// POST /api/demo-session/[id]/[action] -- everything a participant does in a
// live Guided Demo Session:
//
//   sync     both   poll: presence + session state (+ dataset / shared view when newer)
//   view     both   change the shared screen (the host always; the guest while allowed)
//   op       both   apply one data change (the host always; the guest while allowed)
//   control  host   allow guest editing / stop it (the host can always edit)
//   invite   host   issue a new invitation (revokes the previous visitor)
//   end      host   end the session (clears everything at once)
//   leave    visitor leave (control, if theirs, returns to the host)
//
// The caller is resolved for the role the page acts as (`role` in the body)
// -- the host by owner session + DEMO_HOST_AUTH_USER_ID, the visitor by the
// signed sft_demo_visitor cookie -- and migration 042's functions re-check
// identity, lifecycle, guest permission, control_gen and versions under a
// row lock (migration 043). A data change is computed by the SAME demo
// handlers the public /demo uses (runDemoRoute), checked for record-level
// edit conflicts (lib/demoSession/recordVersions.ts), and applied by
// compare-and-swap.
export const runtime = "nodejs";

import { isDemoMutationRoute, runDemoRoute } from "@/lib/demoLocal/fetchInterceptor";
import { changedRecords, conflictingRecords, splitDataset, withRecordVersions, type SessionDataset } from "@/lib/demoSession/recordVersions";
import { isViewOp, reduceView, type Role, type SharedView } from "@/lib/demoSession/sharedView";
import {
  DemoRpcError,
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
import { cleanChatText } from "@/lib/demoSession/chat";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_APPLY_ATTEMPTS = 3;
const MAX_VIEW_ATTEMPTS = 5;
const MAX_VIEW_OP_BYTES = 64 * 1024;
// A "since" no dataset version reaches: the session without its dataset.
const NO_DATASET = Number.MAX_SAFE_INTEGER;

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
      case "view":
        return await view(id, body);
      case "control":
        return await control(id, body);
      case "invite":
        return await invite(id, req);
      case "end":
        return await end(id);
      case "leave":
        return await leave(id);
      case "chat":
        return await chat(id, body);
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
  const chatGen = body.chatGen === null || body.chatGen === undefined ? null : body.chatGen;
  const chatSince = body.chatSince === null || body.chatSince === undefined ? null : body.chatSince;
  if ((chatGen !== null && !isWholeNumber(chatGen)) || (chatSince !== null && !isWholeNumber(chatSince))) return json({ error: "Invalid request" }, 400);
  const result = await syncWithChat(id, who.caller, since, cursorFrom(body.cursor), chatGen, chatSince);
  if (result.outcome !== "ok") return json({ outcome: result.outcome, session: result.session ?? null }, statusForOutcome(result.outcome));
  // chat: null = chat isn't installed yet (before migration 046).
  return json({ outcome: "ok", session: withoutUnchangedView(result.session, body.viewSince), state: result.state ?? null, chat: result.chat ?? null });
}

// Migration 046's check-in (044's plus new chat messages); before 046 is
// applied, the 044 check-in without chat.
async function syncWithChat(id: string, caller: DemoCaller, since: unknown, cursor: ReturnType<typeof cursorFrom>, chatGen: unknown, chatSince: unknown) {
  try {
    return await demoRpc("demo_session_sync_chat", { p_session_id: id, ...caller, p_since: since, p_cursor: cursor, p_chat_gen: chatGen, p_chat_since: chatSince });
  } catch (e) {
    if (e instanceof DemoRpcError && e.notInstalled) return syncWithCursor(id, caller, since, cursor);
    throw e;
  }
}

// Session chat (migration 046): plain text from the host or the current
// guest, whether or not the guest has dashboard control. Length, rate, the
// session being live, and duplicates (same clientId = the same message) are
// all enforced in the database under the session lock.
async function chat(id: string, body: Record<string, unknown>) {
  const who = await resolveCaller(id, body.role);
  if ("response" in who) return who.response;
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const text = cleanChatText(body.text);
  if (!UUID.test(clientId) || text === null) return json({ outcome: "invalid_input" }, 400);
  let result;
  try {
    result = await demoRpc("demo_session_post_message", { p_session_id: id, ...who.caller, p_client_msg_id: clientId, p_body: text });
  } catch (e) {
    if (e instanceof DemoRpcError && e.notInstalled) return json({ outcome: "chat_unavailable" }, 503);
    throw e;
  }
  if (result.outcome !== "ok") return json({ outcome: result.outcome }, statusForOutcome(result.outcome));
  return json({ outcome: "ok", message: result.message, duplicate: result.duplicate === true, chatGen: result.chat_gen ?? null });
}

// The check-in with this person's cursor (migration 044). Before 044 is
// applied it falls back to the plain check-in: sessions keep working, just
// without shared screens or cursors, until the migration is in place.
async function syncWithCursor(id: string, caller: DemoCaller, since: unknown, cursor: ReturnType<typeof cursorFrom>) {
  try {
    return await demoRpc("demo_session_sync_cursor", { p_session_id: id, ...caller, p_since: since, p_cursor: cursor });
  } catch (e) {
    if (e instanceof DemoRpcError && e.notInstalled) return demoRpc("demo_session_sync", { p_session_id: id, ...caller, p_since: since });
    throw e;
  }
}

// A pointer position: which part of the screen (a short name) and where in
// it, as fractions -- so it lands in the same place at any window size.
function cursorFrom(value: unknown): { anchor: string; x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const { anchor, x, y } = value as Record<string, unknown>;
  const fraction = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (typeof anchor !== "string" || !/^[a-z0-9-]{1,40}$/.test(anchor) || !fraction(x) || !fraction(y)) return null;
  return { anchor, x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

// The shared view is only sent to a browser that doesn't have this version.
function withoutUnchangedView(session: Record<string, unknown> | null | undefined, viewSince: unknown) {
  if (!session || !isWholeNumber(viewSince) || session.view_version !== viewSince) return session ?? null;
  const rest = { ...session };
  delete rest.view;
  return rest;
}

// One change to the shared screen, computed by lib/demoSession/sharedView.ts
// from the latest stored view and stored by compare-and-swap (retried
// against whatever another change just stored), so every change is applied
// in one order on the server.
async function view(id: string, body: Record<string, unknown>) {
  const who = await resolveCaller(id, body.role);
  if ("response" in who) return who.response;
  const { gen, op } = body;
  if (!isWholeNumber(gen) || !isViewOp(op) || JSON.stringify(op).length > MAX_VIEW_OP_BYTES) {
    return json({ error: "Invalid request" }, 400);
  }
  for (let attempt = 1; ; attempt++) {
    const current = await demoRpc("demo_session_sync", { p_session_id: id, ...who.caller, p_since: NO_DATASET });
    if (current.outcome !== "ok" || !current.session) {
      return json({ outcome: current.outcome, session: current.session ?? null }, statusForOutcome(current.outcome));
    }
    const denied = permission(who.caller, current.session, gen);
    if (denied) return json({ outcome: denied, session: current.session }, 409);
    const role = who.caller.p_role as Role;
    const result = reduceView((current.session.view ?? null) as SharedView | null, op, role);
    if (result.outcome === "noop" || result.outcome === "superseded" || result.outcome === "denied") {
      return json({ outcome: result.outcome, reason: result.reason ?? null, session: current.session }, result.outcome === "denied" ? 409 : 200);
    }
    const stored = await demoRpc("demo_session_put_view", {
      p_session_id: id,
      ...who.caller,
      p_gen: gen,
      p_base_view_version: current.session.view_version,
      p_view: result.view,
    });
    if (stored.outcome === "ok") return json({ outcome: result.outcome, session: stored.session });
    if (stored.outcome === "stale_view" && attempt < MAX_VIEW_ATTEMPTS) continue;
    return json({ outcome: stored.outcome, session: stored.session ?? null }, statusForOutcome(stored.outcome));
  }
}

async function op(id: string, body: Record<string, unknown>) {
  const who = await resolveCaller(id, body.role);
  if ("response" in who) return who.response;
  // baseVersion: the dataset version the editor started from (when the form
  // opened or Edit was clicked; for a one-click action, what was on screen).
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

  for (let attempt = 1; ; attempt++) {
    // Current session and dataset (also records the caller as present).
    const current = await demoRpc("demo_session_sync", { p_session_id: id, ...who.caller, p_since: null });
    if (current.outcome !== "ok" || !current.session) {
      return json({ outcome: current.outcome, session: current.session ?? null }, statusForOutcome(current.outcome));
    }
    const denied = permission(who.caller, current.session, gen);
    if (denied) return json({ outcome: denied, session: current.session }, 409);

    const { bundle, versions } = splitDataset(current.state as SessionDataset);
    const run = await runDemoRoute(bundle, method, url.pathname + url.search, body.body);
    if (!run) return json({ error: "Not available in this demo." }, 400);
    if (run.status >= 400) {
      // The demo's own rules refused the change: nothing to apply.
      return json({ outcome: "refused", status: run.status, data: run.data, session: current.session });
    }

    // Refused only if a record this change touches was changed by someone
    // after the editor started; other records never cause a conflict.
    const changed = changedRecords(bundle, run.bundle);
    const conflicts = conflictingRecords(changed, versions, baseVersion);
    if (conflicts.length > 0) {
      // A retry of a request that already applied touches records it changed
      // itself: answer with its original result instead.
      const earlier = await demoRpc("demo_session_find_op", { p_session_id: id, ...who.caller, p_op_id: opId });
      if (earlier.outcome === "duplicate") {
        return json({ outcome: "duplicate", status: earlier.response_status, data: earlier.response, session: earlier.session });
      }
      return json({ outcome: "edit_conflict", conflicts, session: current.session, state: current.state ?? null }, 409);
    }

    const version = current.session.state_version as number;
    const applied = await demoRpc("demo_session_apply", {
      p_session_id: id,
      ...who.caller,
      p_gen: gen,
      p_base_version: version,
      p_op_id: opId,
      p_new_state: withRecordVersions(run.bundle, versions, changed, version + 1),
      p_response_status: run.status,
      p_response: run.data ?? null,
    });
    if (applied.outcome === "ok") {
      return json({ outcome: "ok", status: run.status, data: run.data, session: applied.session, state: applied.state });
    }
    if (applied.outcome === "duplicate") {
      return json({ outcome: "duplicate", status: applied.response_status, data: applied.response, session: applied.session });
    }
    // Someone else saved between reading and applying: check this change
    // again against theirs (still against the editor's own starting version,
    // so it can never overwrite what they just did).
    if (applied.outcome === "stale_version" && attempt < MAX_APPLY_ATTEMPTS) continue;
    return json({ outcome: applied.outcome, session: applied.session ?? null }, statusForOutcome(applied.outcome));
  }
}

// The host may always edit; the guest only while allowed, and only under the
// current permission grant (the database re-checks this atomically).
function permission(caller: DemoCaller, session: { controller: string; control_gen: number }, gen: number) {
  if (caller.p_role !== "visitor") return null;
  if (session.controller !== "visitor") return "not_controller";
  if (session.control_gen !== gen) return "stale_control";
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
