// POST /api/demo-session/claim -- a visitor joins with the invitation link.
// No account is needed. The invitation works once, within 30 minutes, while
// the session is live; every failure gets the same answer. On success the
// visitor receives the signed sft_demo_visitor cookie (scoped to the session
// API, expiring with the session).
export const runtime = "nodejs";

import {
  demoRpc,
  errorResponse,
  guidedDemoEnabled,
  hashInviteToken,
  json,
  newVisitorId,
  NOT_AVAILABLE,
  setVisitorCookie,
  statusForOutcome,
} from "@/lib/demoSession/server";

const UNAVAILABLE = { error: "This invitation is no longer available. Ask the host for a new link." };

export async function POST(req: Request) {
  try {
    if (!guidedDemoEnabled()) return json(NOT_AVAILABLE, 404);
    const body = await req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    const rawName = body?.displayName;
    if (rawName !== undefined && rawName !== null && typeof rawName !== "string") {
      return json({ error: "Invalid request" }, 400);
    }
    const displayName = typeof rawName === "string" ? rawName.trim() : "";
    if (displayName.length > 40) {
      return json({ error: "Please use a name of 40 characters or fewer." }, 400);
    }
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return json(UNAVAILABLE, 404);

    const visitorId = newVisitorId();
    const result = await demoRpc("demo_session_claim", {
      p_invite_hash: hashInviteToken(token),
      p_visitor: visitorId,
      p_display_name: displayName || null,
    });
    if (result.outcome !== "ok" || !result.session || typeof result.visitor_epoch !== "number") {
      return json(result.outcome === "invalid_input" ? { error: "Invalid request" } : UNAVAILABLE, statusForOutcome(result.outcome));
    }
    const res = json({ sessionId: result.session.id });
    await setVisitorCookie(res, result.session.id, visitorId, result.visitor_epoch, result.session.expires_at);
    return res;
  } catch (e) {
    return errorResponse(e, "DEMO_SESSION_CLAIM_ERROR");
  }
}
