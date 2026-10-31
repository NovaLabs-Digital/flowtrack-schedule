// POST /api/demo-session/[id]/[action] -- everything a participant does in a
// live Guided Demo Session:
//
//   sync     both   poll: presence + session state (+ dataset when newer)
//   op       both   apply one data change (current controller only)
//   control  host   give control to the visitor / take it back
//   invite   host   issue a new invitation (revokes the previous visitor)
//   end      host   end the session (clears everything at once)
//   leave    visitor leave (control, if theirs, returns to the host)
//
// The caller is resolved for the role the page acts as (`role` in the body)
// -- the host by owner session + DEMO_HOST_AUTH_USER_ID, the visitor by the
// signed sft_demo_visitor cookie -- and migration 042's functions re-check
// identity, lifecycle, control ownership, control_gen and versions under a
// row lock. A data change is computed by the SAME demo handlers the public
// /demo uses (runDemoRoute) and applied by compare-and-swap.
export const runtime = "nodejs";

import { isDemoMutationRoute, runDemoRoute } from "@/lib/demoLocal/fetchInterceptor";
import type { DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";
import {
  demoRpc,
  errorResponse,
  guidedDemoEnabled,
  json,
  newInviteToken,
  NOT_AVAILABLE,
  requireDemoHost,
  resolveCaller,
  statusForOutcome,
  type DemoCaller,
} from "@/lib/demoSession/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;

type Params = { params: Promise<{ id: string; action: string }> };

const isWholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

export async function POST(req: Request, { params }: Params) {
  try {
    if (!guidedDemoEnabled()) return json(NOT_AVAILABLE, 404);
    const { id, action } = await params;
    if (!UUID.test(id)) return json({ error: "Not found" }, 404);
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return json({ error: "Request too large" }, 413);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);

    switch (action) {
      case "sync":
        return await sync(id, body);
      case "op":
        return await op(id, body);
      case "control":
        return await control(id, body);
      case "invite":
        return await invite(id, req);
      case "end":
        return await end(id);
      case "leave":
        return await leave(id);
      default:
        return json({ error: "Not found" }, 404);
    }
  } catch (e) {
    return errorResponse(e, "DEMO_SESSION_ACTION_ERROR");
  }
}

async function sync(id: string, body: Record<string, unknown>) {
  const who = await resolveCaller(id, body.role);
  if ("response" in who) return who.response;
  const since = body.since === null || body.since === undefined ? null : body.since;
  if (since !== null && !isWholeNumber(since)) return json({ error: "Invalid request" }, 400);
  const result = await demoRpc("demo_session_sync", { p_session_id: id, ...who.caller, p_since: since });
  if (result.outcome !== "ok") return json({ outcome: result.outcome, session: result.session ?? null }, statusForOutcome(result.outcome));
  return json({ outcome: "ok", session: result.session, state: result.state ?? null });
}

async function op(id: string, body: Record<string, unknown>) {
  const who = await resolveCaller(id, body.role);
  if ("response" in who) return who.response;
  const { gen, baseVersion, opId, method, path } = body;
  if (!isWholeNumber(gen) || !isWholeNumber(baseVersion) || typeof opId !== "string" || !UUID.test(opId)
      || typeof method !== "string" || typeof path !== "string" || path.length > 500) {
    return json({ error: "Invalid request" }, 400);
  }
  let url: URL;
  try {
    url = new URL(path, "http://demo-session.local");
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!isDemoMutationRoute(method, url.pathname)) return json({ error: "Not available in this demo." }, 400);

  // Current session and dataset (also records the caller as present).
  const current = await demoRpc("demo_session_sync", { p_session_id: id, ...who.caller, p_since: null });
  if (current.outcome !== "ok" || !current.session) {
    return json({ outcome: current.outcome, session: current.session ?? null }, statusForOutcome(current.outcome));
  }
  const rejection = precheck(who.caller, current.session, gen, baseVersion);
  if (rejection) {
    return json({ outcome: rejection, session: current.session, state: current.state ?? null }, 409);
  }

  const run = await runDemoRoute(current.state as DemoFixtureBundle, method, url.pathname + url.search, body.body);
  if (!run) return json({ error: "Not available in this demo." }, 400);
  if (run.status >= 400) {
    // The demo's own rules refused the change: nothing to apply.
    return json({ outcome: "refused", status: run.status, data: run.data, session: current.session });
  }

  const applied = await demoRpc("demo_session_apply", {
    p_session_id: id,
    ...who.caller,
    p_gen: gen,
    p_base_version: baseVersion,
    p_op_id: opId,
    p_new_state: run.bundle,
    p_response_status: run.status,
    p_response: run.data ?? null,
  });
  if (applied.outcome === "ok") {
    return json({ outcome: "ok", status: run.status, data: run.data, session: applied.session, state: applied.state });
  }
  if (applied.outcome === "duplicate") {
    return json({ outcome: "duplicate", status: applied.response_status, data: applied.response, session: applied.session });
  }
  return json({ outcome: applied.outcome, session: applied.session ?? null }, statusForOutcome(applied.outcome));
}

// Fast refusal before running the handlers (the database re-checks all of
// this atomically when applying).
function precheck(caller: DemoCaller, session: { controller: string; control_gen: number; state_version: number }, gen: number, baseVersion: number) {
  if (session.controller !== caller.p_role) return "not_controller";
  if (session.control_gen !== gen) return "stale_control";
  if (session.state_version !== baseVersion) return "stale_version";
  return null;
}

async function control(id: string, body: Record<string, unknown>) {
  const host = await requireDemoHost();
  if ("response" in host) return host.response;
  if (body.to !== "host" && body.to !== "visitor") return json({ error: "Invalid request" }, 400);
  const result = await demoRpc("demo_session_set_controller", { p_session_id: id, p_host: host.hostId, p_to: body.to });
  return json({ outcome: result.outcome, session: result.session ?? null }, result.outcome === "ok" ? 200 : statusForOutcome(result.outcome));
}

async function invite(id: string, req: Request) {
  const host = await requireDemoHost();
  if ("response" in host) return host.response;
  const token = newInviteToken();
  const result = await demoRpc("demo_session_reinvite", { p_session_id: id, p_host: host.hostId, p_invite_hash: token.hash });
  if (result.outcome !== "ok") return json({ outcome: result.outcome, session: result.session ?? null }, statusForOutcome(result.outcome));
  return json({ outcome: "ok", session: result.session, inviteUrl: `${new URL(req.url).origin}/demo/join/${token.token}` });
}

async function end(id: string) {
  const host = await requireDemoHost();
  if ("response" in host) return host.response;
  const result = await demoRpc("demo_session_end", { p_session_id: id, p_host: host.hostId });
  return json({ outcome: result.outcome, session: result.session ?? null }, result.outcome === "ok" ? 200 : statusForOutcome(result.outcome));
}

async function leave(id: string) {
  const who = await resolveCaller(id, "visitor");
  if ("response" in who) return who.response;
  const result = await demoRpc("demo_session_leave", { p_session_id: id, p_visitor: who.caller.p_visitor, p_epoch: who.caller.p_epoch });
  return json({ outcome: result.outcome, session: result.session ?? null }, result.outcome === "ok" ? 200 : statusForOutcome(result.outcome));
}
