export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getStripeConfig } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCurrentOwnerSession } from "@/lib/sessionEpoch";

const GENERIC_ERROR = "Unable to open billing portal";

// Deliberately NOT gated by requireFullAccess (lib/entitlementServer.ts) —
// a read-only workspace (e.g. past its grace period) must still be able to
// reach the billing portal to fix payment and restore access. This route
// stays reachable regardless of entitlement state. Phase 5.7D: the
// session_epoch check is called directly here for the same reason (see
// app/api/stripe/checkout/route.ts) — this route bypasses
// requireCapability/requireFullAccess entirely, so it must re-verify the
// session itself rather than rely on that central wiring.
//
// Cross-workspace access is structurally impossible here: the Stripe
// customer id is always looked up server-side from session.workspaceId,
// never accepted from the request. There is no request body to trust or
// distrust in the first place.
export async function POST() {
  const session = await getSession();
  const deny = requireRole(session, ["owner"]);
  if (deny) return deny;
  assertWorkspace(session);
  const ownerSessionCheck = await requireCurrentOwnerSession(session);
  if (!ownerSessionCheck.ok) return ownerSessionCheck.response;

  let config;
  try {
    config = getStripeConfig();
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  const { data: row, error } = await supabaseAdmin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("workspace_id", session.workspaceId)
    .maybeSingle();

  if (error) {
    console.error("STRIPE_PORTAL_QUERY_ERROR");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  if (!row?.stripe_customer_id) {
    return NextResponse.json({ error: "No billing account found for this workspace." }, { status: 404 });
  }

  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const portalSession = await config.client.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${appUrl}/dashboard?settings=subscription`,
    });
    return NextResponse.json({ url: portalSession.url });
  } catch {
    console.error("STRIPE_PORTAL_SESSION_ERROR");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
