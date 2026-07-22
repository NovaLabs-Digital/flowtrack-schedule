// Phase 5.5C — the ONE shared client-side entry point for turning a
// Phase 5.5B browser-safe recoveryAction ("checkout" | "portal" | "support"
// | null) into an actual authenticated Stripe recovery flow. This file
// contains no subscription-state mapping and no entitlement calculation —
// it only ever receives the already-projected action string and never
// inspects billing state itself. It sends no body on either request (both
// app/api/stripe/checkout/route.ts and app/api/stripe/portal/route.ts take
// zero request input already — workspace identity is resolved entirely
// server-side from the session), so there is no workspace ID, Stripe ID, or
// billing detail for this file to leak even by accident.

export type BillingRecoveryAction = "checkout" | "portal" | "support" | null;

export type BillingRecoveryResult =
  | { status: "redirecting" }
  | { status: "support_required" }
  | { status: "no_action" }
  | { status: "error"; message: string };

// Calm, generic, and identical for every failure mode -- never the raw
// provider/route error text (which the routes already scrub server-side;
// this is a second, independent layer of the same discipline on the client).
const GENERIC_ERROR_MESSAGE = "We couldn't open billing right now. Please try again.";

// Injectable purely for testability: every real caller omits this and gets
// real browser navigation. Tests always supply a spy, so no test ever
// navigates anywhere or touches a real window.
export type Navigate = (url: string) => void;
const defaultNavigate: Navigate = (url) => {
  window.location.href = url;
};

// The one trusted-destination contract this file enforces: a redirect only
// ever happens to an https:// URL on stripe.com or a stripe.com subdomain.
// Stripe's checkout and billing-portal session URLs are always served from
// a *.stripe.com host in both test and live mode -- the test/live
// distinction lives in the session/API key, never in the URL's hostname --
// so this single suffix check covers checkout.stripe.com, billing.stripe.com,
// and any other current or future Stripe-hosted subdomain without needing to
// enumerate exact paths that could change. Never the value of recoveryAction
// itself (which is only ever the action-selector string, never a URL) and
// never anything sourced from component props, query parameters, or local
// storage -- the only input to this check is the JSON body of a same-origin
// authenticated response from one of the two routes below.
function isTrustedStripeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return parsed.hostname === "stripe.com" || parsed.hostname.endsWith(".stripe.com");
}

interface RecoveryEndpointResponse {
  url?: unknown;
  error?: unknown;
  redirectToPortal?: unknown;
}

type EndpointOutcome =
  | { ok: true; url: string }
  | { ok: false; redirectToPortal: boolean };

// Same-origin authenticated POST, zero body -- matching the routes' own
// contract exactly (neither accepts or expects any request body; the
// browser's session cookie is sent automatically for a same-origin
// request, exactly like every other fetch call already in this codebase).
async function requestRedirectUrl(endpoint: "/api/stripe/checkout" | "/api/stripe/portal"): Promise<EndpointOutcome> {
  let res: Response;
  try {
    res = await fetch(endpoint, { method: "POST" });
  } catch {
    console.error("BILLING_RECOVERY_NETWORK_ERROR", endpoint);
    return { ok: false, redirectToPortal: false };
  }

  let data: RecoveryEndpointResponse;
  try {
    data = await res.json();
  } catch {
    console.error("BILLING_RECOVERY_MALFORMED_RESPONSE", endpoint);
    return { ok: false, redirectToPortal: false };
  }

  if (res.ok && isTrustedStripeUrl(data.url)) {
    return { ok: true, url: data.url };
  }

  if (!res.ok) {
    console.error("BILLING_RECOVERY_ROUTE_ERROR", endpoint, res.status);
  } else {
    // 2xx but no trustworthy url -- fail exactly the same as a hard error
    // rather than ever falling through to a redirect.
    console.error("BILLING_RECOVERY_UNTRUSTED_OR_MISSING_URL", endpoint);
  }

  // The checkout route's ONLY documented signal for "a subscription already
  // exists, use the portal instead" is an exact 409 status paired with
  // redirectToPortal === true in the body -- both conditions are required,
  // so a malformed/partial signal (wrong status, truthy-but-not-true value,
  // or a 409 for an unrelated reason) never triggers the fallback.
  const redirectToPortal = res.status === 409 && data.redirectToPortal === true;
  return { ok: false, redirectToPortal };
}

// Shared by both the direct "portal" action and the checkout→portal
// fallback below -- there is exactly one portal-request code path, never a
// duplicated one. Terminates in a plain error result on failure; it never
// falls back to anything else, so a portal failure can never loop back into
// checkout (checkout is the only caller that can reach this a second time
// after its own attempt, and it only ever does so once).
async function attemptPortalRedirect(navigate: Navigate): Promise<BillingRecoveryResult> {
  const outcome = await requestRedirectUrl("/api/stripe/portal");
  if (outcome.ok) {
    navigate(outcome.url);
    return { status: "redirecting" };
  }
  return { status: "error", message: GENERIC_ERROR_MESSAGE };
}

// The one shared entry point every future consumer (grace banner, restricted
// banner, the existing Subscription & Plan card) should call. Deliberately
// switches ONLY on `action` -- the already-projected Phase 5.5B value -- and
// never inspects or infers subscription/entitlement state itself.
export async function beginBillingRecovery(
  action: BillingRecoveryAction,
  navigate: Navigate = defaultNavigate
): Promise<BillingRecoveryResult> {
  if (action === null) {
    return { status: "no_action" };
  }

  if (action === "support") {
    // No canonical support email/URL/route exists in this repository today
    // (checked deliberately -- see the Phase 5.5C report) -- inventing one
    // here would be exactly the kind of local policy this phase must not
    // introduce. This result exists so a later banner can render whatever
    // the approved support path turns out to be, without this helper ever
    // needing to know it, and without ever calling Stripe.
    return { status: "support_required" };
  }

  if (action === "portal") {
    return attemptPortalRedirect(navigate);
  }

  // action === "checkout"
  const outcome = await requestRedirectUrl("/api/stripe/checkout");
  if (outcome.ok) {
    navigate(outcome.url);
    return { status: "redirecting" };
  }
  if (outcome.redirectToPortal) {
    return attemptPortalRedirect(navigate);
  }
  return { status: "error", message: GENERIC_ERROR_MESSAGE };
}

// Phase 5.5D note: this module deliberately provides NO in-flight/
// duplicate-request guard. An earlier draft of this file included a thin
// useBillingRecovery() React hook for that purpose, but its behavior had no
// automated test (this repository has no React hook/component-testing
// infrastructure -- no jsdom, no @testing-library/react -- and a hook
// cannot be safely invoked outside an actual render cycle), so it was
// removed rather than shipped untested. beginBillingRecovery itself is
// stateless and safely reentrant (see the "stateless and safely reentrant"
// test below) -- Phase 5.5D must implement pending/duplicate-request
// protection directly inside whatever banner or shared billing-action
// component actually calls this function, where the real behavior (a
// disabled button, an ignored second click) can be exercised and tested
// against that component, not simulated here in the abstract.
