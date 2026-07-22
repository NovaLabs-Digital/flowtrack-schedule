// Phase 5.5C: focused tests for the shared client-side billing-recovery
// helper (lib/billingRecovery.ts). globalThis.fetch is replaced ONCE at
// module load with a call-tracking fake whose response is reconfigured per
// test via the mutable `fetchImpl` variable (the same "mutable captured
// variable" pattern already used by mock.module()-based route tests
// elsewhere in this repo) -- no test in this file can reach a real
// network, Stripe, Supabase, Twilio, Resend, or Vercel endpoint. Browser
// navigation is never exercised for real either: every call supplies its
// own `navigate` spy instead of relying on the module's window.location.href
// default, so no test touches a DOM/window global.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type FakeFetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
type FetchCall = { url: string; init?: RequestInit };

const fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<FakeFetchResponse> = async () => {
  throw new Error("fetchImpl not configured for this test");
};

// @ts-expect-error -- deliberately narrower than the full Fetch API; every
// call site in lib/billingRecovery.ts only ever uses (url, {method}) and
// res.ok/res.status/res.json(), which this fake fully covers.
globalThis.fetch = (url: string, init?: RequestInit) => {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
};

const { beginBillingRecovery } = await import("./billingRecovery.ts");

function ok(body: unknown): FakeFetchResponse {
  return { ok: true, status: 200, json: async () => body };
}
function fail(status: number, body: unknown): FakeFetchResponse {
  return { ok: false, status, json: async () => body };
}

function resetFetch(impl: typeof fetchImpl) {
  fetchCalls.length = 0;
  fetchImpl = impl;
}

function spyNavigate(): { navigate: (url: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { navigate: (url: string) => calls.push(url), calls };
}

const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_abc123";
const PORTAL_URL = "https://billing.stripe.com/session/bps_test_xyz789";

describe("beginBillingRecovery -- endpoint selection per action", () => {
  test('action "portal" calls only /api/stripe/portal, via POST', async () => {
    resetFetch(async () => ok({ url: PORTAL_URL }));
    const { navigate } = spyNavigate();
    await beginBillingRecovery("portal", navigate);
    assert.deepEqual(
      fetchCalls.map((c) => ({ url: c.url, method: c.init?.method })),
      [{ url: "/api/stripe/portal", method: "POST" }]
    );
  });

  test('action "checkout" calls only /api/stripe/checkout initially, via POST', async () => {
    resetFetch(async () => ok({ url: CHECKOUT_URL }));
    const { navigate } = spyNavigate();
    await beginBillingRecovery("checkout", navigate);
    assert.deepEqual(
      fetchCalls.map((c) => ({ url: c.url, method: c.init?.method })),
      [{ url: "/api/stripe/checkout", method: "POST" }]
    );
  });

  test('action "support" performs no network call and never reaches Stripe', async () => {
    resetFetch(async () => {
      throw new Error("must not be called");
    });
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("support", navigate);
    assert.deepEqual(result, { status: "support_required" });
    assert.equal(fetchCalls.length, 0);
    assert.equal(calls.length, 0);
  });

  test("action null performs no network call and returns a typed no-action result", async () => {
    resetFetch(async () => {
      throw new Error("must not be called");
    });
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery(null, navigate);
    assert.deepEqual(result, { status: "no_action" });
    assert.equal(fetchCalls.length, 0);
    assert.equal(calls.length, 0);
  });
});

describe("beginBillingRecovery -- successful redirects", () => {
  test("a trusted checkout URL response navigates and reports redirecting", async () => {
    resetFetch(async () => ok({ url: CHECKOUT_URL }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.deepEqual(result, { status: "redirecting" });
    assert.deepEqual(calls, [CHECKOUT_URL]);
  });

  test("a trusted portal URL response navigates and reports redirecting", async () => {
    resetFetch(async () => ok({ url: PORTAL_URL }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("portal", navigate);
    assert.deepEqual(result, { status: "redirecting" });
    assert.deepEqual(calls, [PORTAL_URL]);
  });
});

describe("beginBillingRecovery -- checkout-to-portal fallback (redirectToPortal)", () => {
  test("checkout's exact 409 + redirectToPortal:true signal performs exactly one follow-up portal request, which then redirects", async () => {
    let call = 0;
    resetFetch(async (url) => {
      call++;
      if (url === "/api/stripe/checkout") return fail(409, { error: "already has a subscription", redirectToPortal: true });
      if (url === "/api/stripe/portal") return ok({ url: PORTAL_URL });
      throw new Error(`unexpected url ${url}`);
    });
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.equal(call, 2, "exactly one checkout call followed by exactly one portal call");
    assert.deepEqual(
      fetchCalls.map((c) => c.url),
      ["/api/stripe/checkout", "/api/stripe/portal"]
    );
    assert.deepEqual(result, { status: "redirecting" });
    assert.deepEqual(calls, [PORTAL_URL]);
  });

  test("direct portal and the checkout fallback's portal request share identical failure handling", async () => {
    resetFetch(async () => fail(404, { error: "No billing account found for this workspace." }));
    const { navigate: navigateDirect } = spyNavigate();
    const directResult = await beginBillingRecovery("portal", navigateDirect);

    resetFetch(async (url) => {
      if (url === "/api/stripe/checkout") return fail(409, { error: "already has a subscription", redirectToPortal: true });
      return fail(404, { error: "No billing account found for this workspace." });
    });
    const { navigate: navigateFallback } = spyNavigate();
    const fallbackResult = await beginBillingRecovery("checkout", navigateFallback);

    assert.deepEqual(directResult, fallbackResult);
    assert.deepEqual(directResult, { status: "error", message: "We couldn't open billing right now. Please try again." });
  });

  test("a portal failure reached via the checkout fallback terminates safely -- no loop back into checkout", async () => {
    resetFetch(async (url) => {
      if (url === "/api/stripe/checkout") return fail(409, { error: "already has a subscription", redirectToPortal: true });
      return fail(500, { error: "Unable to open billing portal" });
    });
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.equal(fetchCalls.length, 2, "checkout once, portal once -- never a third call");
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0, "no navigation occurs on failure");
  });

  test("a redirectToPortal signal on the wrong HTTP status (not 409) is never honored", async () => {
    resetFetch(async () => ok({ redirectToPortal: true })); // 200 OK, no url, but redirectToPortal present
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.equal(fetchCalls.length, 1, "no follow-up portal call");
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("a redirectToPortal value that is truthy but not the exact boolean true is never honored", async () => {
    resetFetch(async () => fail(409, { error: "...", redirectToPortal: "true" }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.equal(fetchCalls.length, 1, "no follow-up portal call for a non-boolean signal");
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });
});

describe("beginBillingRecovery -- failure modes fail safe, never navigate, never leak raw detail", () => {
  test("malformed JSON (a .json() rejection) fails safely with the generic message", async () => {
    resetFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("a non-2xx checkout response (no redirectToPortal) fails safely, no portal follow-up", async () => {
    resetFetch(async () => fail(500, { error: "Unable to start checkout" }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.equal(fetchCalls.length, 1);
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("a non-2xx portal response fails safely", async () => {
    resetFetch(async () => fail(500, { error: "Unable to open billing portal" }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("portal", navigate);
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("a 2xx response with a missing url fails safely instead of navigating to undefined", async () => {
    resetFetch(async () => ok({}));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("a 2xx response with a syntactically invalid url string fails safely", async () => {
    resetFetch(async () => ok({ url: "not a url" }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("portal", navigate);
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("a network-level fetch rejection fails safely", async () => {
    resetFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("checkout", navigate);
    assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
    assert.equal(calls.length, 0);
  });

  test("the returned error message is always the fixed generic text, never the route's own error body", async () => {
    resetFetch(async () => fail(500, { error: "Stripe API key invalid: sk_live_XXXXXXXXXXXXXXXXXXXX" }));
    const { navigate } = spyNavigate();
    const result = await beginBillingRecovery("portal", navigate);
    if (result.status === "error") {
      assert.ok(!result.message.includes("sk_live"), "must never surface a raw provider error/secret");
      assert.equal(result.message, "We couldn't open billing right now. Please try again.");
    } else {
      assert.fail("expected an error result");
    }
  });
});

describe("beginBillingRecovery -- untrusted/unsafe redirect destinations are always rejected", () => {
  const UNTRUSTED_URLS = [
    "http://checkout.stripe.com/c/pay/cs_test_abc", // wrong protocol (http, not https)
    "javascript:alert(1)", // not a valid absolute http(s) URL destination
    "https://evil.com/checkout.stripe.com", // stripe.com only appears in the path, not the host
    "https://stripe.com.evil.com/steal", // suffix trick -- host does not end with ".stripe.com"
    "https://evilstripe.com/steal", // lookalike host, not a stripe.com subdomain
    "https://stripe.com@evil.com/steal", // userinfo trick -- real host is evil.com
    "", // empty string
  ];

  for (const untrusted of UNTRUSTED_URLS) {
    test(`rejects "${untrusted}" as a checkout redirect target`, async () => {
      resetFetch(async () => ok({ url: untrusted }));
      const { navigate, calls } = spyNavigate();
      const result = await beginBillingRecovery("checkout", navigate);
      assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
      assert.equal(calls.length, 0, `must never navigate to "${untrusted}"`);
    });

    test(`rejects "${untrusted}" as a portal redirect target`, async () => {
      resetFetch(async () => ok({ url: untrusted }));
      const { navigate, calls } = spyNavigate();
      const result = await beginBillingRecovery("portal", navigate);
      assert.deepEqual(result, { status: "error", message: "We couldn't open billing right now. Please try again." });
      assert.equal(calls.length, 0, `must never navigate to "${untrusted}"`);
    });
  }

  test("accepts a bare https://stripe.com root host as trusted (boundary case for the suffix check)", async () => {
    resetFetch(async () => ok({ url: "https://stripe.com/session/abc" }));
    const { navigate, calls } = spyNavigate();
    const result = await beginBillingRecovery("portal", navigate);
    assert.deepEqual(result, { status: "redirecting" });
    assert.deepEqual(calls, ["https://stripe.com/session/abc"]);
  });
});

describe("beginBillingRecovery -- no request ever carries workspace/Stripe/billing identity", () => {
  test("neither the checkout nor the portal request has a request body", async () => {
    resetFetch(async () => ok({ url: CHECKOUT_URL }));
    await beginBillingRecovery("checkout", () => {});
    resetFetch(async () => ok({ url: PORTAL_URL }));
    await beginBillingRecovery("portal", () => {});
    for (const call of fetchCalls) {
      assert.equal(call.init?.body, undefined, `${call.url} must send no request body`);
    }
  });

  test("the endpoint URLs are fixed literals -- no workspace/customer/subscription identifier is ever interpolated into them", async () => {
    resetFetch(async () => ok({ url: CHECKOUT_URL }));
    await beginBillingRecovery("checkout", () => {});
    assert.equal(fetchCalls[0]?.url, "/api/stripe/checkout");
  });
});

describe("beginBillingRecovery is stateless and safely reentrant -- duplicate-request prevention is the hook's responsibility, not this function's", () => {
  test("two concurrent calls each perform their own independent request (no hidden shared state to corrupt)", async () => {
    resetFetch(async () => ok({ url: CHECKOUT_URL }));
    const { navigate: nav1, calls: calls1 } = spyNavigate();
    const { navigate: nav2, calls: calls2 } = spyNavigate();
    const [r1, r2] = await Promise.all([beginBillingRecovery("checkout", nav1), beginBillingRecovery("checkout", nav2)]);
    assert.equal(fetchCalls.length, 2);
    assert.deepEqual(r1, { status: "redirecting" });
    assert.deepEqual(r2, { status: "redirecting" });
    assert.deepEqual(calls1, [CHECKOUT_URL]);
    assert.deepEqual(calls2, [CHECKOUT_URL]);
  });
});

describe("lib/billingRecovery.ts contains no server-only dependency (source-level proof)", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./billingRecovery.ts", import.meta.url)), "utf8");

  test('never imports "server-only"', () => {
    assert.ok(!source.includes('"server-only"'));
  });

  test("never imports the canonical entitlement resolver, Supabase, or Stripe SDK modules", () => {
    for (const forbidden of ["@/lib/entitlement", "@/lib/entitlementServer", "@/lib/supabaseAdmin", "@/lib/stripe", "@/lib/stripeCheckout", "from \"stripe\""]) {
      assert.ok(!source.includes(forbidden), `must not import "${forbidden}"`);
    }
  });

  test("contains no hardcoded workspace/demo/internal/role special case", () => {
    for (const forbidden of ["isTester", "DEMO_WORKSPACE_ID", "REAL_WORKSPACE_ID", "billing_mode", "role ===", "session."]) {
      assert.ok(!source.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("exports beginBillingRecovery as the only recovery executor -- no React hook, no untested duplicate-request logic", () => {
    assert.ok(source.includes("export async function beginBillingRecovery("));
    // Checked as declarations/imports, not a bare substring -- the file's
    // own comments legitimately reference the removed hook's name to
    // document why it's absent (see the Phase 5.5D note above this test's
    // target), which would otherwise false-positive a plain substring check.
    for (const forbidden of ["export function useBillingRecovery", "useState(", "useCallback(", 'from "react"', "\"use client\""]) {
      assert.ok(!source.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });
});

describe("employee and public surfaces receive no billing-recovery interface (source-level proof)", () => {
  const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

  test("EmployeeSchedule.tsx does not import billingRecovery or reference recoveryAction", () => {
    const source = fs.readFileSync(path.join(projectRoot, "app", "components", "schedule", "EmployeeSchedule.tsx"), "utf8");
    assert.ok(!source.includes("billingRecovery"));
    assert.ok(!source.includes("recoveryAction"));
  });

  test("public booking (BookingForm.tsx, app/book/page.tsx) does not import billingRecovery", () => {
    for (const rel of [
      path.join("app", "components", "book", "BookingForm.tsx"),
      path.join("app", "book", "page.tsx"),
    ]) {
      const source = fs.readFileSync(path.join(projectRoot, rel), "utf8");
      assert.ok(!source.includes("billingRecovery"), `${rel} must not import the billing-recovery helper`);
    }
  });

  test("public cancellation (app/cancel/page.tsx) does not import billingRecovery", () => {
    const source = fs.readFileSync(path.join(projectRoot, "app", "cancel", "page.tsx"), "utf8");
    assert.ok(!source.includes("billingRecovery"));
  });
});
