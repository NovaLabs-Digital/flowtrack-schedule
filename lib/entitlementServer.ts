import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Session } from "@/lib/session";
import { DEMO_WORKSPACE_ID } from "@/lib/workspace";
import { noDataResult, resolveWorkspaceEntitlement } from "@/lib/entitlement";
import type { EntitlementResult, SubscriptionRecord, EntitlementCapabilities } from "@/lib/entitlement";

// Raw shape of a subscriptions row as Postgres/PostgREST returns it
// (migration 015). Deliberately narrower than the full table — this route
// never reads stripe_customer_id/stripe_subscription_id, so there's no risk
// of accidentally threading them into an EntitlementResult later.
interface SubscriptionRow {
  billing_mode: "internal" | "stripe";
  stripe_status: string | null;
  trial_end: string | null;
  current_period_end: string | null;
  grace_until: string | null;
  cancel_at_period_end: boolean;
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    billingMode: row.billing_mode,
    stripeStatus: row.stripe_status,
    trialEnd: row.trial_end ? new Date(row.trial_end) : null,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end) : null,
    graceUntil: row.grace_until ? new Date(row.grace_until) : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  };
}

// Server-only: reads the subscriptions table via the service-role client
// (same access pattern as every other table — see docs/SECURITY.md) and
// hands the result to the pure resolver in lib/entitlement.ts. Fails closed
// on both "no row" and "query error" — a workspace is never granted access
// because we couldn't determine its billing state.
//
// The demo workspace never has a subscriptions row (migration 015) and its
// access does not depend on Stripe/Supabase data at all, so it's
// short-circuited before the query — a Supabase outage cannot affect demo
// mode, and demo requests never pay for a DB round-trip they don't need.
export async function fetchEntitlementForWorkspace(workspaceId: string): Promise<EntitlementResult> {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    return resolveWorkspaceEntitlement(workspaceId, null, new Date());
  }

  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("billing_mode, stripe_status, trial_end, current_period_end, grace_until, cancel_at_period_end")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    // Fixed tag only — no Stripe identifiers, no customer/subscription
    // data, no raw DB error details that could leak schema information.
    console.error("ENTITLEMENT_QUERY_ERROR");
    return noDataResult("query_error");
  }

  return resolveWorkspaceEntitlement(workspaceId, data ? toRecord(data as SubscriptionRow) : null, new Date());
}

const GENERIC_FORBIDDEN = { error: "Unauthorized" } as const;

// Central write-gate for mutation routes: call at the top of any handler
// that changes state, right after requireRole()/requireOwner(). Returns
// null when the caller may proceed, or the established generic 403
// response when it may not — never a distinct "read-only" message, so a
// denied request can't be used to probe billing state.
//
//   const session = await getSession();
//   const deny = requireRole(session, ["owner", "employee"]);
//   if (deny) return deny;
//   const entitlementDeny = await requireFullAccess(session);
//   if (entitlementDeny) return entitlementDeny;
//
// Not called from any route yet (Phase 5.4A is the entitlement model only —
// route/API enforcement is a later phase).
//
// SESSION-INTEGRITY GUARD: a tester session should always carry
// DEMO_WORKSPACE_ID (see lib/session.ts — tester sessions are minted with
// exactly that workspaceId, never any other). A tester session carrying a
// different workspaceId is not a legitimate state under this app's session
// model, so it fails closed here rather than falling through to
// fetchEntitlementForWorkspace (which would correctly fail closed anyway,
// since a non-demo workspaceId with no subscriptions row resolves to
// "no_subscription", but failing closed at this earlier, more specific
// check produces a clearer audit log signal for what would otherwise be an
// unusual/corrupted session).
export async function requireFullAccess(session: Session): Promise<NextResponse | null> {
  if (session.role === "none") {
    return NextResponse.json(GENERIC_FORBIDDEN, { status: 403 });
  }

  if (session.role === "tester" && session.workspaceId !== DEMO_WORKSPACE_ID) {
    console.error("ENTITLEMENT_TESTER_WORKSPACE_MISMATCH");
    return NextResponse.json(GENERIC_FORBIDDEN, { status: 403 });
  }

  const result = await fetchEntitlementForWorkspace(session.workspaceId);
  if (result.hasOperationalAccess) {
    return null;
  }
  return NextResponse.json(GENERIC_FORBIDDEN, { status: 403 });
}

// ============================================================================
// Phase 5.4D — capability-aware server enforcement foundation.
//
// This is the ONE canonical gate every operational route should eventually
// call — but as of this phase, NOTHING calls it yet (see the Phase 5.4C
// audit for the route-by-route wiring plan; that wiring is Phase 5.4E+, not
// this one). Nothing here changes runtime access behavior today.
//
// Deliberately additive: requireFullAccess above is left completely
// unmodified. The two functions below are new, separate exports; a route
// migrating to capability-based checks calls one of these instead of
// requireFullAccess, it doesn't need requireFullAccess to change shape.
// ============================================================================

// Derived directly from EntitlementCapabilities (lib/entitlement.ts) rather
// than a hand-maintained string union, so this can never drift from the
// canonical model — adding/removing a capability field there is the only
// way to add/remove a valid value here. hasOperationalAccess/isReadOnly are
// excluded: they're the resolver's own internal summary of the other seven,
// not a capability a caller asks for by name.
export type EntitlementCapability = Exclude<keyof EntitlementCapabilities, "hasOperationalAccess" | "isReadOnly">;

// Explicit, typed success/denial contract — deliberately not a bare
// `NextResponse | null` (the shape requireFullAccess already uses): the
// discriminant makes "did this pass?" checkable without inspecting a
// response body, and TypeScript won't let a caller forget the `allowed`
// check before touching `.response`. The `response` on denial is already a
// complete, safe-to-return NextResponse — callers never construct their own
// error body from this result.
export type CapabilityCheckResult = { allowed: true } | { allowed: false; response: NextResponse };

function allowed(): CapabilityCheckResult {
  return { allowed: true };
}

function denied(response: NextResponse): CapabilityCheckResult {
  return { allowed: false, response };
}

// The one safe response body for a genuine subscription-state restriction —
// distinct from GENERIC_FORBIDDEN (role/auth failures) so a caller can tell
// "you're not allowed to call this at all" apart from "you're allowed to
// call this, but your subscription needs attention," without either
// message ever naming the specific reason/state, or any workspace/
// customer/subscription identifier, or any Supabase/Stripe/provider error
// text. An unauthenticated request never reaches this response at all — it
// is only ever returned to a caller who already passed the role/session
// check inside requireCapability (or who is being checked via the
// server-trusted requireCapabilityForWorkspace path below), so it cannot be
// used by an outside prober to learn whether a workspace has a
// subscription: reaching this branch already proves the caller belongs to
// that workspace (or is the server itself).
const SUBSCRIPTION_RESTRICTED_BODY = {
  error: "This action isn't available right now — visit Billing to restore full access.",
  code: "SUBSCRIPTION_RESTRICTED",
} as const;

function subscriptionRestrictedDenial(): NextResponse {
  return NextResponse.json(SUBSCRIPTION_RESTRICTED_BODY, { status: 403 });
}

// Injectable purely for testability (same pattern as lib/stripeWebhook.ts's
// WebhookDeps / lib/reconcileSubscriptions.ts's ReconcileDeps) — every real
// caller omits this argument and gets the true fetchEntitlementForWorkspace
// above, which is the only production code path. Tests supply a fake that
// returns a synthetic EntitlementResult (built via the already-pure,
// already-tested resolveEntitlement/resolveWorkspaceEntitlement) so the
// capability-check LOGIC can be exercised for every state without a live
// Supabase connection.
type EntitlementFetcher = (workspaceId: string) => Promise<EntitlementResult>;

// Central capability gate for an AUTHENTICATED session: call at the top of
// any handler that needs a specific capability, right after
// requireRole()/requireOwner(). Uses the session's own trusted
// workspaceId — never a workspaceId from a request body, query string,
// header, or any other browser-supplied input, because this function
// doesn't accept one; the only workspace identity it can ever act on is
// whatever was signed into the caller's session cookie at login (see
// lib/session.ts / lib/sessionCrypto.ts).
//
//   const session = await getSession();
//   const deny = requireRole(session, ["owner", "employee"]);
//   if (deny) return deny;
//   const check = await requireCapability(session, "canMutateOperationalData");
//   if (!check.allowed) return check.response;
//
// SESSION-INTEGRITY GUARD (identical rationale to requireFullAccess above):
// a tester session should always carry DEMO_WORKSPACE_ID; one that doesn't
// is not a legitimate state under this app's session model and fails
// closed here — with the generic role/auth response, not the
// subscription-restricted one, so this specific failure mode stays
// indistinguishable from "you're not allowed to call this" rather than
// leaking "your session looks unusual."
//
// Internal and demo workspaces resolve without any Stripe dependence: for
// DEMO_WORKSPACE_ID, the default fetchEntitlementForWorkspace short-circuits
// before touching Supabase at all (Phase 5.4B); for an `internal`-mode
// workspace, resolveEntitlement's own `internal` branch is pure, dependency-
// free logic (Phase 5.4A) once the (Supabase-only, non-Stripe) row is read.
// A genuine Supabase query error or malformed stored row fails closed to
// RESTRICTED_CAPABILITIES (lib/entitlement.ts) — every operational
// capability denies, while canManageBilling/canViewExistingData/
// canExportData stay true exactly as Phase 5.4A defines them, so a data
// problem degrades an operation to "can't do this right now," never to
// "can't see your own data."
export async function requireCapability(
  session: Session,
  capability: EntitlementCapability,
  fetchEntitlement: EntitlementFetcher = fetchEntitlementForWorkspace
): Promise<CapabilityCheckResult> {
  if (session.role === "none") {
    return denied(NextResponse.json(GENERIC_FORBIDDEN, { status: 403 }));
  }

  if (session.role === "tester" && session.workspaceId !== DEMO_WORKSPACE_ID) {
    console.error("ENTITLEMENT_TESTER_WORKSPACE_MISMATCH");
    return denied(NextResponse.json(GENERIC_FORBIDDEN, { status: 403 }));
  }

  const result = await fetchEntitlement(session.workspaceId);
  return result[capability] ? allowed() : denied(subscriptionRestrictedDenial());
}

// Capability gate for a workspace identity the SERVER itself already
// resolved and trusts — never a session. Intended only for the narrow set
// of call sites where there is no authenticated user at all, but the
// workspace is still known with certainty because the server derived it
// itself, e.g.:
//   - the fixed public-booking workspace configuration (a server-side
//     constant, never a request parameter);
//   - the workspace_id read off an appointment row that was already looked
//     up BY a valid, unguessable cancellation token (the token match is
//     what established trust; the resulting row's workspace_id is then
//     server-trusted, not client-supplied);
//   - a row a cron job loaded directly from the database.
//
// CALLERS MUST NEVER pass a workspaceId that originated directly from
// request.json()/searchParams/headers or any other value a browser could
// set — that would let an attacker probe or manufacture entitlement results
// for an arbitrary workspace. This function performs no session/role check
// of its own (there is no session to check) and no defense against a
// caller violating that contract; the trust boundary is enforced entirely
// by what the CALLER passes in, which is why every legitimate call site
// above resolves its workspaceId from a fixed constant or a value already
// authenticated by some other mechanism (a token match, a server-only
// query) before ever reaching this function.
//
// Uses the exact same resolution path as requireCapability — no separate
// status mapping, no separate demo/internal logic. A workspaceId of
// DEMO_WORKSPACE_ID still resolves to full demo capabilities here for the
// same structural reason it does everywhere else: resolveWorkspaceEntitlement
// only ever checks workspaceId equality, never a role or caller identity.
export async function requireCapabilityForWorkspace(
  trustedWorkspaceId: string,
  capability: EntitlementCapability,
  fetchEntitlement: EntitlementFetcher = fetchEntitlementForWorkspace
): Promise<CapabilityCheckResult> {
  const result = await fetchEntitlement(trustedWorkspaceId);
  return result[capability] ? allowed() : denied(subscriptionRestrictedDenial());
}
