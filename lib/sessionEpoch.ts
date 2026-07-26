import "server-only";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Session } from "@/lib/session";
import { serviceUnavailableDenial } from "@/lib/serviceUnavailable";

const GENERIC_FORBIDDEN = { error: "Unauthorized" } as const;

export type OwnerSessionCheckResult = { ok: true } | { ok: false; response: NextResponse };

function ok(): OwnerSessionCheckResult {
  return { ok: true };
}
function fail(response: NextResponse): OwnerSessionCheckResult {
  return { ok: false, response };
}

// Phase 5.7D — the central fail-closed re-verification every owner-only
// route/page must call immediately after requireOwner()/requireRole() and
// STRICTLY BEFORE any business-data query. A session's HMAC signature and
// `exp` claim (already checked by getSession()) prove the cookie hasn't
// been tampered with and hasn't naturally expired -- they do NOT prove the
// session is still trusted, because this app's session model is otherwise
// fully stateless (lib/sessionCrypto.ts). session_epoch is the one piece of
// server-side state that closes that gap.
//
// Deliberately NOT folded into requireRole()/requireOwner() themselves:
// those two functions are synchronous and called, unawaited by design, from
// every route file in this codebase -- making them async to add a database
// check here would silently break every existing call site (an unawaited
// Promise is always truthy), a far wider blast radius than this phase's
// scope. Deliberately NOT folded into requireCapability()/requireFullAccess
// alone either: app/api/stripe/checkout/route.ts and
// app/api/stripe/portal/route.ts are both owner-only routes that
// intentionally do NOT call either of those (billing recovery must stay
// reachable regardless of entitlement state) -- this function is called
// directly at those two call sites as well as being folded into
// requireCapability/requireFullAccess, so every owner-only route is
// covered by one mechanism or the other. See app/dashboard/page.tsx for the
// page-component (non-NextResponse) call site.
//
// Non-owner sessions pass through unconditionally -- employee/tester
// verification is completely unaffected by this module, matching the
// approved scope (MFA/session-epoch enforcement applies to owners only).
export async function requireCurrentOwnerSession(session: Session): Promise<OwnerSessionCheckResult> {
  if (session.role !== "owner") {
    return ok();
  }

  const { data, error } = await supabaseAdmin
    .from("workspace_memberships")
    .select("workspace_id, session_epoch")
    .eq("profile_id", session.authUserId)
    .eq("role", "owner")
    .maybeSingle();

  if (error) {
    // Fixed tag only — no auth user id, workspace id, or raw DB error
    // detail that could leak schema/data information.
    console.error("SESSION_EPOCH_QUERY_ERROR");
    return fail(serviceUnavailableDenial());
  }

  if (!data) {
    console.error("SESSION_EPOCH_MEMBERSHIP_MISSING");
    return fail(NextResponse.json(GENERIC_FORBIDDEN, { status: 403 }));
  }

  if (data.workspace_id !== session.workspaceId || data.session_epoch !== session.sessionEpoch) {
    console.error("SESSION_EPOCH_MISMATCH");
    return fail(NextResponse.json(GENERIC_FORBIDDEN, { status: 403 }));
  }

  return ok();
}
