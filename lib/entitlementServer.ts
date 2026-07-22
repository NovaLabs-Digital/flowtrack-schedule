import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Session } from "@/lib/session";
import { DEMO_WORKSPACE_ID } from "@/lib/workspace";
import { noDataResult, resolveWorkspaceEntitlement } from "@/lib/entitlement";
import type { EntitlementResult, SubscriptionRecord } from "@/lib/entitlement";

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
