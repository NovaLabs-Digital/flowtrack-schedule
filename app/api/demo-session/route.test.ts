// Guided Demo Session API routes: host authorization (Alberto only, current
// owner session), invitation claim and the visitor cookie, every per-session
// action's identity checks, the data-change pipeline (allowlist, prechecks,
// the demo's own rules, compare-and-swap apply, retries), cleanup cron
// authorization, and isolation (only migration 042's functions and the
// host's own session-epoch row are ever touched).
//
// Database behavior itself (locks, control_gen, versions, lifecycle) is
// proven against real PostgreSQL in test-db/demo_sessions.test.ts.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "test-session-secret-for-demo-session-routes-0123456789";
process.env.CRON_SECRET = "test-cron-secret";

import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createFakeSupabaseAdmin, fakeSessionNamedExports } from "../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../lib/testSupport.ts";

const HOST = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SID = "0b3c2f9e-5b7a-4c1d-9e2f-1a2b3c4d5e6f";
const OTHER_SID = "1c4d3e0f-6c8b-4d2e-8f3a-2b3c4d5e6f70";
const VISITOR = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };
const cookieJar = new Map<string, string>();

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      rpc: (fn: string, args?: unknown) => currentFake.supabaseAdmin.rpc(fn, args),
    },
  },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });
mock.module("next/headers", {
  namedExports: {
    cookies: async () => ({ get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined) }),
  },
});

const { POST: create, GET: current } = await import("./route.ts");
const { POST: claim } = await import("./claim/route.ts");
const { POST: action } = await import("./[id]/[action]/route.ts");
const { GET: cleanupCron } = await import("../cron/demo-session-cleanup/route.ts");
const { signDemoVisitorPayload, verifyDemoVisitorCookie, verifySessionCookie, signSessionPayload } = await import("../../../lib/sessionCrypto.ts");
const { generateDemoFixture, DEMO_TIMEZONE } = await import("../../../lib/demoLocal/fixtures/generate.ts");
const { addDays } = await import("../../../lib/recurrence.ts");

const OWNER = { role: "owner", workspaceId: "ws-1", authUserId: HOST, sessionEpoch: 1 };
const MEMBERSHIP_OK = { workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 1 } }] };

function reset(tables: Record<string, FakeSupabaseFixture[]> = {}, rpc: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(tables, rpc);
}
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const act = (id: string, name: string, body: unknown) =>
  action(post(`http://localhost/api/demo-session/${id}/${name}`, body), { params: Promise.resolve({ id, action: name }) });
const rpcNames = () => currentFake.rpcCalls.map((c) => c.fn);
const sessionView = (patch: Record<string, unknown> = {}) => ({
  id: SID, status: "live", end_reason: null, expires_at: new Date(Date.now() + 7_000_000).toISOString(),
  controller: "visitor", control_gen: 2, state_version: 5, invite_pending: false, invite_expires_at: null,
  visitor_joined: true, visitor_online: true, visitor_display_name: null, host_online: true, ...patch,
});
async function visitorCookie(sessionId = SID, epoch = 1) {
  return signDemoVisitorPayload({ purpose: "demo_visitor", sessionId, visitorId: VISITOR, epoch, exp: Math.floor(Date.now() / 1000) + 3600 });
}

beforeEach(() => {
  process.env.DEMO_HOST_AUTH_USER_ID = HOST;
  sessionToReturn = { role: "none" };
  cookieJar.clear();
  reset();
});

describe("only Alberto may host (DEMO_HOST_AUTH_USER_ID + current owner session)", () => {
  const denied: Array<[string, unknown]> = [
    ["no session", { role: "none" }],
    ["employee", { role: "employee", employeeId: "e1", workspaceId: "ws-1" }],
    ["tester", { role: "tester", workspaceId: "ws-demo" }],
    ["a different owner", { ...OWNER, authUserId: "11111111-2222-4333-8444-555555555555" }],
  ];
  for (const [label, session] of denied) {
    test(`${label}: 403, nothing touched`, async () => {
      sessionToReturn = session;
      const res = await create(post("http://localhost/api/demo-session", {}));
      assert.equal(res.status, 403);
      assert.deepEqual(rpcNames(), []);
      assert.deepEqual(currentFake.calls, []);
    });
  }

  test("with DEMO_HOST_AUTH_USER_ID unset the feature is off: every session route is 404 and nothing is touched", async () => {
    delete process.env.DEMO_HOST_AUTH_USER_ID;
    sessionToReturn = OWNER;
    cookieJar.set("sft_demo_visitor", await visitorCookie());
    assert.equal((await create(post("http://localhost/api/demo-session", {}))).status, 404);
    assert.equal((await current()).status, 404);
    assert.equal((await claim(post("http://localhost/api/demo-session/claim", { token: "a".repeat(43) }))).status, 404);
    for (const name of ["sync", "op", "control", "invite", "end", "leave"]) {
      assert.equal((await act(SID, name, { role: "visitor" })).status, 404, name);
    }
    assert.deepEqual(rpcNames(), []);
    assert.deepEqual(currentFake.calls, []);
  });

  test("Alberto with a revoked (stale epoch) owner session: 403, no session created", async () => {
    reset({ workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 2 } }] });
    sessionToReturn = OWNER;
    assert.equal((await create(post("http://localhost/api/demo-session", {}))).status, 403);
    assert.deepEqual(rpcNames(), []);
  });

  test("Alberto: starts a session with a fresh fictional dataset; only the invitation's hash is stored", async () => {
    reset(MEMBERSHIP_OK, {
      demo_session_current: [{ data: { outcome: "none" } }],
      demo_session_create: [{ data: { outcome: "ok", session: sessionView({ controller: "host", control_gen: 1 }) } }],
    });
    sessionToReturn = OWNER;
    const res = await create(post("http://localhost/api/demo-session", {}));
    assert.equal(res.status, 200);
    const body = await res.json();
    const token = body.inviteUrl.split("/demo/join/")[1];
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(rpcNames(), ["demo_session_current", "demo_session_create"]);
    const args = currentFake.rpcCalls[1].args as Record<string, any>;
    assert.equal(args.p_host, HOST);
    assert.equal(args.p_invite_hash, createHash("sha256").update(token).digest("hex"));
    assert.ok(!JSON.stringify(args).includes(token), "the raw token is never stored");
    assert.ok(Array.isArray(args.p_state.appointments) && args.p_state.appointments.length > 0, "fresh fixture");
  });
});

describe("Resume Session and replacing a live session", () => {
  beforeEach(() => {
    sessionToReturn = OWNER;
  });

  test("GET returns Alberto's live session for Resume, or null", async () => {
    reset(
      { workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 1 } }, { data: { workspace_id: "ws-1", session_epoch: 1 } }] },
      { demo_session_current: [{ data: { outcome: "ok", session: sessionView() } }, { data: { outcome: "none" } }] }
    );
    assert.equal((await (await current()).json()).session.id, SID);
    assert.equal((await (await current()).json()).session, null);
    assert.deepEqual(currentFake.rpcCalls.map((c) => c.args), [{ p_host: HOST }, { p_host: HOST }]);
  });

  test("starting while a session is live is refused (409, nothing created) unless the page confirms the replacement", async () => {
    reset(
      { workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 1 } }, { data: { workspace_id: "ws-1", session_epoch: 1 } }] },
      {
        demo_session_current: [{ data: { outcome: "ok", session: sessionView() } }],
        demo_session_create: [{ data: { outcome: "ok", session: sessionView({ id: OTHER_SID }) } }],
      }
    );
    const refused = await create(post("http://localhost/api/demo-session", {}));
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.outcome, "active_session_exists");
    assert.equal(body.session.id, SID);
    assert.deepEqual(rpcNames(), ["demo_session_current"]);

    const replaced = await create(post("http://localhost/api/demo-session", { replaceExisting: true }));
    assert.equal(replaced.status, 200);
    assert.deepEqual(rpcNames(), ["demo_session_current", "demo_session_create"]);
  });

  test("a non-host cannot see whether a session exists", async () => {
    sessionToReturn = { ...OWNER, authUserId: "11111111-2222-4333-8444-555555555555" };
    assert.equal((await current()).status, 403);
    assert.deepEqual(rpcNames(), []);
  });
});

describe("deployed before migration 042 is applied", () => {
  const missing = { error: { code: "PGRST202", message: "Could not find the function public.demo_session_current" } };

  test("host, visitor and session routes answer a clear 503 instead of a generic error", async () => {
    sessionToReturn = OWNER;
    reset(
      { workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 1 } }, { data: { workspace_id: "ws-1", session_epoch: 1 } }] },
      { demo_session_current: [missing, missing], demo_session_claim: [missing], demo_session_sync: [missing] }
    );
    for (const res of [await current(), await create(post("http://localhost/api/demo-session", {}))]) {
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: "Guided Demo Sessions aren't set up yet." });
    }
    assert.equal((await claim(post("http://localhost/api/demo-session/claim", { token: "d".repeat(43) }))).status, 503);
    cookieJar.set("sft_demo_visitor", await visitorCookie());
    assert.equal((await act(SID, "sync", { role: "visitor", since: null })).status, 503);
  });

  test("the cleanup cron treats a missing migration as a successful no-op, and still runs with the feature switched off", async () => {
    delete process.env.DEMO_HOST_AUTH_USER_ID;
    reset({}, { demo_session_cleanup: [missing] });
    const res = await cleanupCron(new Request("http://localhost/api/cron/demo-session-cleanup", { headers: { authorization: "Bearer test-cron-secret" } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, skipped: "not_installed" });
    assert.deepEqual(rpcNames(), ["demo_session_cleanup"]);
  });

  test("any other database error is still a 500", async () => {
    reset({}, { demo_session_cleanup: [{ error: { code: "57014", message: "canceling statement due to statement timeout" } }] });
    const res = await cleanupCron(new Request("http://localhost/api/cron/demo-session-cleanup", { headers: { authorization: "Bearer test-cron-secret" } }));
    assert.equal(res.status, 500);
  });
});

describe("joining with an invitation", () => {
  test("malformed tokens and over-long names are refused before touching the database", async () => {
    assert.equal((await claim(post("http://localhost/api/demo-session/claim", { token: "short" }))).status, 404);
    const longName = await claim(post("http://localhost/api/demo-session/claim", { token: "a".repeat(43), displayName: "x".repeat(41) }));
    assert.equal(longName.status, 400);
    assert.deepEqual(rpcNames(), []);
  });

  test("a valid claim sets the visitor cookie: signed, httpOnly, scoped to the session API, expiring with the session", async () => {
    const expires = new Date(Date.now() + 2 * 3_600_000).toISOString();
    reset({}, { demo_session_claim: [{ data: { outcome: "ok", visitor_epoch: 1, session: sessionView({ expires_at: expires }) } }] });
    const token = "b".repeat(43);
    const res = await claim(post("http://localhost/api/demo-session/claim", { token, displayName: "  Dana " }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sessionId: SID });
    const args = currentFake.rpcCalls[0].args as Record<string, any>;
    assert.equal(args.p_invite_hash, createHash("sha256").update(token).digest("hex"));
    assert.equal(args.p_display_name, "Dana");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /sft_demo_visitor=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Path=\/api\/demo-session/);
    const maxAge = Number(setCookie.match(/Max-Age=(\d+)/i)?.[1]);
    assert.ok(maxAge > 7000 && maxAge <= 7200);
    const value = decodeURIComponent(setCookie.match(/sft_demo_visitor=([^;]+)/)![1]);
    const payload = await verifyDemoVisitorCookie(value);
    assert.equal(payload?.sessionId, SID);
    assert.equal(payload?.visitorId, args.p_visitor);
  });

  test("an unavailable invitation gets one uniform answer and no cookie", async () => {
    reset({}, { demo_session_claim: [{ data: { outcome: "invite_unavailable" } }] });
    const res = await claim(post("http://localhost/api/demo-session/claim", { token: "c".repeat(43) }));
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no longer available/);
    assert.equal(res.headers.get("set-cookie"), null);
  });

  test("a visitor cookie is never a login session, and a login session is never a visitor cookie", async () => {
    assert.equal(await verifySessionCookie(await visitorCookie()), null);
    const login = await signSessionPayload({ role: "tester", workspaceId: "ws-demo", exp: Math.floor(Date.now() / 1000) + 3600 } as any);
    assert.equal(await verifyDemoVisitorCookie(login), null);
  });
});

describe("per-session actions: identity", () => {
  test("unknown actions and malformed session ids are 404", async () => {
    assert.equal((await act(SID, "explode", { role: "host" })).status, 404);
    assert.equal((await act("not-a-uuid", "sync", { role: "host" })).status, 404);
  });

  test("a visitor needs their own session's valid cookie", async () => {
    assert.equal((await act(SID, "sync", { role: "visitor" })).status, 403, "no cookie");
    cookieJar.set("sft_demo_visitor", await visitorCookie(OTHER_SID));
    assert.equal((await act(SID, "sync", { role: "visitor" })).status, 403, "another session's cookie");
    cookieJar.set("sft_demo_visitor", (await visitorCookie()).slice(0, -2) + "xx");
    assert.equal((await act(SID, "sync", { role: "visitor" })).status, 403, "tampered cookie");
    assert.deepEqual(rpcNames(), []);
  });

  test("control, invite and end are host-only: a visitor cookie cannot use them", async () => {
    cookieJar.set("sft_demo_visitor", await visitorCookie());
    for (const name of ["control", "invite", "end"]) {
      assert.equal((await act(SID, name, { role: "visitor", to: "visitor" })).status, 403, name);
    }
    assert.deepEqual(rpcNames(), []);
  });

  test("the visitor's identity (id + epoch from the cookie) is what reaches the database", async () => {
    cookieJar.set("sft_demo_visitor", await visitorCookie(SID, 3));
    reset({}, { demo_session_sync: [{ data: { outcome: "ok", session: sessionView(), state: null } }] });
    const res = await act(SID, "sync", { role: "visitor", since: 5, p_visitor: "forged", p_epoch: 99 });
    assert.equal(res.status, 200);
    assert.deepEqual(currentFake.rpcCalls[0].args, { p_session_id: SID, p_role: "visitor", p_host: null, p_visitor: VISITOR, p_epoch: 3, p_since: 5 });
  });

  test("an ended session answers 410 to sync", async () => {
    cookieJar.set("sft_demo_visitor", await visitorCookie());
    reset({}, { demo_session_sync: [{ data: { outcome: "ended", session: sessionView({ status: "ended" }) } }] });
    assert.equal((await act(SID, "sync", { role: "visitor", since: null })).status, 410);
  });
});

describe("data changes", () => {
  const bundle = generateDemoFixture(new Date());
  const createChange = (patch: Record<string, unknown> = {}) => ({
    role: "visitor", gen: 2, baseVersion: 5, opId: "2d3e4f50-6172-4839-8a4b-5c6d7e8f9012",
    method: "POST", path: "/api/appointments/create",
    body: {
      client_id: bundle.clients[0].id, service_type: "Window Washing",
      scheduled_for: addDays(new Date(), 4, DEMO_TIMEZONE).toISOString(), duration_minutes: 90,
      employee_ids: [bundle.employees[0].id], price_cents: 12000,
    },
    ...patch,
  });
  const syncOk = (patch: Record<string, unknown> = {}) => ({ data: { outcome: "ok", session: sessionView(patch), state: bundle } });
  beforeEach(async () => cookieJar.set("sft_demo_visitor", await visitorCookie()));

  test("only handled demo changes are accepted: reads, logout and other routes are refused before any database call", async () => {
    for (const change of [{ method: "GET", path: "/api/services" }, { method: "POST", path: "/api/auth/logout" }, { method: "POST", path: "/api/stripe/checkout" }]) {
      const res = await act(SID, "op", createChange(change));
      assert.equal(res.status, 400, change.path);
    }
    assert.equal((await act(SID, "op", createChange({ opId: "not-a-uuid" }))).status, 400);
    assert.deepEqual(rpcNames(), []);
  });

  for (const [label, patch, outcome] of [
    ["a watcher (not the controller)", { controller: "host" }, "not_controller"],
    ["a previous control generation", { control_gen: 3 }, "stale_control"],
    ["an out-of-date base version", { state_version: 6 }, "stale_version"],
  ] as const) {
    test(`${label} is refused with nothing applied`, async () => {
      reset({}, { demo_session_sync: [syncOk(patch)] });
      const res = await act(SID, "op", createChange());
      assert.equal(res.status, 409);
      assert.equal((await res.json()).outcome, outcome);
      assert.deepEqual(rpcNames(), ["demo_session_sync"]);
    });
  }

  test("the demo's own rules refusing the change: answered, nothing applied", async () => {
    reset({}, { demo_session_sync: [syncOk()] });
    const res = await act(SID, "op", createChange({ body: { client_id: "nope" } }));
    const body = await res.json();
    assert.equal(body.outcome, "refused");
    assert.ok(body.status >= 400);
    assert.deepEqual(rpcNames(), ["demo_session_sync"]);
  });

  test("an accepted change is computed by the demo handlers and applied with the caller's gen, base version and op id", async () => {
    reset({}, {
      demo_session_sync: [syncOk()],
      demo_session_apply: [{ data: { outcome: "ok", session: sessionView({ state_version: 6 }), state: { applied: true } } }],
    });
    const res = await act(SID, "op", createChange());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outcome, "ok");
    assert.equal(body.status, 200);
    assert.deepEqual(body.state, { applied: true });
    const args = currentFake.rpcCalls[1].args as Record<string, any>;
    assert.equal(args.p_gen, 2);
    assert.equal(args.p_base_version, 5);
    assert.equal(args.p_op_id, "2d3e4f50-6172-4839-8a4b-5c6d7e8f9012");
    assert.equal(args.p_visitor, VISITOR);
    assert.equal(args.p_new_state.appointments.length, bundle.appointments.length + 1);
    assert.equal(args.p_response.appointmentId, body.data.appointmentId);
  });

  test("a retried op returns the original result ('duplicate'); a race lost at apply time is refused", async () => {
    reset({}, {
      demo_session_sync: [syncOk(), syncOk()],
      demo_session_apply: [
        { data: { outcome: "duplicate", response_status: 200, response: { appointmentId: "a1" }, session: sessionView() } },
        { data: { outcome: "stale_control", session: sessionView({ controller: "host", control_gen: 3 }) } },
      ],
    });
    const dup = await (await act(SID, "op", createChange())).json();
    assert.deepEqual([dup.outcome, dup.status, dup.data], ["duplicate", 200, { appointmentId: "a1" }]);
    const raced = await act(SID, "op", createChange());
    assert.equal(raced.status, 409);
    assert.equal((await raced.json()).outcome, "stale_control");
  });
});

describe("host session actions", () => {
  beforeEach(() => {
    sessionToReturn = OWNER;
  });

  test("give / take back control, new invitation, end -- each passes Alberto's id; a new invitation stores only a hash", async () => {
    reset(
      { workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 1 } }, { data: { workspace_id: "ws-1", session_epoch: 1 } }, { data: { workspace_id: "ws-1", session_epoch: 1 } }] },
      {
        demo_session_set_controller: [{ data: { outcome: "ok", session: sessionView() } }],
        demo_session_reinvite: [{ data: { outcome: "ok", session: sessionView() } }],
        demo_session_end: [{ data: { outcome: "ok", session: sessionView({ status: "ended" }) } }],
      }
    );
    assert.equal((await act(SID, "control", { role: "host", to: "visitor" })).status, 200);
    const invite = await (await act(SID, "invite", { role: "host" })).json();
    assert.equal((await act(SID, "end", { role: "host" })).status, 200);
    const [ctrl, re, end] = currentFake.rpcCalls;
    assert.deepEqual(ctrl.args, { p_session_id: SID, p_host: HOST, p_to: "visitor" });
    const token = invite.inviteUrl.split("/demo/join/")[1];
    assert.equal((re.args as any).p_invite_hash, createHash("sha256").update(token).digest("hex"));
    assert.deepEqual(end.args, { p_session_id: SID, p_host: HOST });
  });

  test("an invalid control target is refused before the database", async () => {
    reset(MEMBERSHIP_OK);
    assert.equal((await act(SID, "control", { role: "host", to: "everyone" })).status, 400);
    assert.deepEqual(rpcNames(), []);
  });
});

describe("cleanup cron and isolation", () => {
  test("the cleanup cron requires the cron secret", async () => {
    assert.equal((await cleanupCron(new Request("http://localhost/api/cron/demo-session-cleanup"))).status, 401);
    assert.deepEqual(rpcNames(), []);
    reset({}, { demo_session_cleanup: [{ data: { outcome: "ok", ended: 0, purged: 1 } }] });
    const ok = await cleanupCron(new Request("http://localhost/api/cron/demo-session-cleanup", { headers: { authorization: "Bearer test-cron-secret" } }));
    assert.equal(ok.status, 200);
    assert.deepEqual(rpcNames(), ["demo_session_cleanup"]);
  });

  test("session routes only ever call migration 042's functions and read the host's own session-epoch row", async () => {
    const fs = await import("node:fs");
    const files = [
      "./route.ts", "./claim/route.ts", "./[id]/[action]/route.ts", "../cron/demo-session-cleanup/route.ts", "../../../lib/demoSession/server.ts",
    ].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8"));
    for (const src of files) {
      assert.ok(!/\.from\(/.test(src), "no direct table access");
      for (const m of src.matchAll(/demoRpc\("([a-z_]+)"/g)) assert.match(m[1], /^demo_session_/);
      assert.ok(!/lib\/(notify|stripe|completedJobBilling|appointmentEmployees|recurringSeries)\b/.test(src), "no real business modules");
    }
  });
});
