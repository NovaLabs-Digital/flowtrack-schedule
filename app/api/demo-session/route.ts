// The host's Guided Demo Session (Alberto only).
//
//   GET  -- the host's current live session, if any (Resume Session).
//   POST -- start a session: a fresh fictional dataset and a single-use,
//           30-minute invitation. If a live session exists, the request must
//           say { replaceExisting: true } (the page asks first); starting then
//           ends the current session (migration 042).
//
// Off (404, no database access) until DEMO_HOST_AUTH_USER_ID is set; a
// clear 503 if the code is deployed before migration 042 is applied.
export const runtime = "nodejs";

import { generateDemoFixture } from "@/lib/demoLocal/fixtures/generate";
import {
  demoRpc,
  errorResponse,
  guidedDemoEnabled,
  json,
  newInviteToken,
  NOT_AVAILABLE,
  requireDemoHost,
  statusForOutcome,
} from "@/lib/demoSession/server";

export async function GET() {
  try {
    if (!guidedDemoEnabled()) return json(NOT_AVAILABLE, 404);
    const host = await requireDemoHost();
    if ("response" in host) return host.response;
    const current = await demoRpc("demo_session_current", { p_host: host.hostId });
    return json({ session: current.outcome === "ok" ? current.session ?? null : null });
  } catch (e) {
    return errorResponse(e, "DEMO_SESSION_CURRENT_ERROR");
  }
}

export async function POST(req: Request) {
  try {
    if (!guidedDemoEnabled()) return json(NOT_AVAILABLE, 404);
    const host = await requireDemoHost();
    if ("response" in host) return host.response;
    const body = await req.json().catch(() => ({}));

    if (body?.replaceExisting !== true) {
      const current = await demoRpc("demo_session_current", { p_host: host.hostId });
      if (current.outcome === "ok" && current.session) {
        return json({ outcome: "active_session_exists", session: current.session }, 409);
      }
    }

    const invite = newInviteToken();
    const result = await demoRpc("demo_session_create", {
      p_host: host.hostId,
      p_state: generateDemoFixture(new Date()),
      p_invite_hash: invite.hash,
    });
    if (result.outcome !== "ok" || !result.session) {
      return json({ error: "Could not start the session." }, statusForOutcome(result.outcome));
    }
    const origin = new URL(req.url).origin;
    return json({ session: result.session, inviteUrl: `${origin}/demo/join/${invite.token}` });
  } catch (e) {
    return errorResponse(e, "DEMO_SESSION_CREATE_ERROR");
  }
}
