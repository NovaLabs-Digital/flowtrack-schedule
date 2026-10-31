// Guided Demo Session browser client: what it sends with every data change
// (control generation, base version, one-time op id), how it mirrors the
// server's answers, and how it recovers (retries with the SAME op id, re-sync
// after a stale version, watch-only and ended states).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createDemoSessionClient, WATCHING_MESSAGE, ENDED_MESSAGE, type DemoSessionView } from "./client.ts";

const SID = "0b3c2f9e-5b7a-4c1d-9e2f-1a2b3c4d5e6f";
const view = (patch: Partial<DemoSessionView> = {}): DemoSessionView => ({
  id: SID, status: "live", end_reason: null, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  controller: "visitor", control_gen: 2, state_version: 5, invite_pending: false, invite_expires_at: null,
  visitor_joined: true, visitor_online: true, visitor_display_name: "Dana", host_online: true, ...patch,
});
const dataset = (marker: number) => ({ marker } as any);

type Reply = { status?: number; body: Record<string, unknown> } | "network-error";
function fakeServer(replies: Reply[]) {
  const sent: Array<{ action: string; body: any }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const action = url.split("/").pop()!;
    sent.push({ action, body: JSON.parse(String(init?.body ?? "{}")) });
    const reply = replies.shift();
    if (!reply || reply === "network-error") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { sent, fetchImpl: () => fetchImpl as unknown as typeof fetch };
}

async function connected(role: "host" | "visitor", replies: Reply[], first = view()) {
  const server = fakeServer([{ body: { outcome: "ok", session: first, state: dataset(5) } }, ...replies]);
  let n = 0;
  const client = createDemoSessionClient({ sessionId: SID, role, fetchImpl: server.fetchImpl, newOpId: () => `op-${++n}` });
  await client.syncNow();
  return { client, sent: server.sent };
}
const url = new URL("http://localhost/api/appointments/create");

describe("syncing", () => {
  test("first sync loads the dataset and session; later syncs send the held version", async () => {
    const { client, sent } = await connected("visitor", [{ body: { outcome: "ok", session: view(), state: null } }]);
    assert.equal(client.getState().status, "live");
    assert.deepEqual(client.store.getSnapshot(), dataset(5));
    await client.syncNow();
    assert.deepEqual(sent.map((s) => [s.action, s.body.role, s.body.since]), [["sync", "visitor", null], ["sync", "visitor", 5]]);
  });

  test("an ended or unauthorized answer stops the session view", async () => {
    const ended = await connected("visitor", [{ status: 410, body: { outcome: "ended", session: view({ status: "ended", end_reason: "host_ended" }) } }]);
    await ended.client.syncNow();
    assert.equal(ended.client.getState().status, "ended");
    const denied = await connected("visitor", [{ status: 403, body: { error: "Unauthorized" } }]);
    await denied.client.syncNow();
    assert.equal(denied.client.getState().status, "unauthorized");
  });

  test("a network failure keeps the last data and marks the view offline", async () => {
    const { client } = await connected("visitor", ["network-error"]);
    await client.syncNow();
    assert.equal(client.getState().offline, true);
    assert.deepEqual(client.store.getSnapshot(), dataset(5));
  });
});

describe("forwarding data changes", () => {
  test("sends gen, base version, op id, method, path and body; applies the returned dataset", async () => {
    const { client, sent } = await connected("visitor", [
      { body: { outcome: "ok", status: 200, data: { appointmentId: "a9" }, session: view({ state_version: 6 }), state: dataset(6) } },
    ]);
    const res = await client.forwardMutation("POST", url, { x: 1 });
    assert.deepEqual(await res.json(), { appointmentId: "a9" });
    assert.deepEqual(sent[1].body, { role: "visitor", gen: 2, baseVersion: 5, opId: "op-1", method: "POST", path: "/api/appointments/create", body: { x: 1 } });
    assert.deepEqual(client.store.getSnapshot(), dataset(6));
  });

  test("while watching, nothing is sent and the visitor is told why", async () => {
    const { client, sent } = await connected("visitor", [], view({ controller: "host" }));
    const res = await client.forwardMutation("POST", url, {});
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: WATCHING_MESSAGE });
    assert.equal(sent.length, 1, "only the initial sync");
  });

  test("control taken back while a change was in flight: refused, view switches to watching", async () => {
    const { client } = await connected("visitor", [
      { status: 409, body: { outcome: "stale_control", session: view({ controller: "host", control_gen: 3 }) } },
    ]);
    const res = await client.forwardMutation("POST", url, {});
    assert.equal(res.status, 403);
    assert.equal(client.getState().session?.controller, "host");
    assert.equal(client.getState().session?.control_gen, 3);
  });

  test("a stale version re-syncs and retries ONCE with the same op id", async () => {
    const { client, sent } = await connected("visitor", [
      { status: 409, body: { outcome: "stale_version", session: view({ state_version: 7 }), state: dataset(7) } },
      { body: { outcome: "ok", status: 200, data: { ok: true }, session: view({ state_version: 8 }), state: dataset(8) } },
    ]);
    const res = await client.forwardMutation("POST", url, {});
    assert.equal(res.status, 200);
    assert.deepEqual([sent[1].body.opId, sent[1].body.baseVersion], ["op-1", 5]);
    assert.deepEqual([sent[2].body.opId, sent[2].body.baseVersion], ["op-1", 7]);
  });

  test("a lost connection retries with the same op id; the server's 'duplicate' answer returns the original result", async () => {
    const { client, sent } = await connected("visitor", [
      "network-error",
      { body: { outcome: "ok", session: view({ state_version: 6 }), state: dataset(6) } }, // catch-up sync
      { body: { outcome: "duplicate", status: 200, data: { appointmentId: "a9" }, session: view({ state_version: 6 }) } },
      { body: { outcome: "ok", session: view({ state_version: 6 }), state: null } }, // sync after duplicate
    ]);
    const res = await client.forwardMutation("POST", url, {});
    assert.deepEqual(await res.json(), { appointmentId: "a9" });
    const ops = sent.filter((s) => s.action === "op");
    assert.deepEqual(ops.map((o) => o.body.opId), ["op-1", "op-1"]);
  });

  test("the demo's rules refusing a change passes the real error through", async () => {
    const { client } = await connected("visitor", [
      { body: { outcome: "refused", status: 400, data: { error: "Client not found" }, session: view() } },
    ]);
    const res = await client.forwardMutation("POST", url, {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Client not found" });
  });

  test("after the session ends, changes are refused locally", async () => {
    const { client } = await connected("host", [{ status: 410, body: { outcome: "ended", session: view({ status: "ended" }) } }], view({ controller: "host" }));
    await client.syncNow();
    const res = await client.forwardMutation("POST", url, {});
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { error: ENDED_MESSAGE });
  });
});

describe("host actions", () => {
  test("give / take back / new invite / end post to the session API as the host", async () => {
    const { client, sent } = await connected("host", [
      { body: { outcome: "ok", session: view({ controller: "visitor", control_gen: 3 }) } },
      { body: { outcome: "ok", session: view({ controller: "host", control_gen: 4 }) } },
      { body: { outcome: "ok", session: view(), inviteUrl: "x" } },
      { body: { outcome: "ok", session: view({ status: "ended" }) } },
    ], view({ controller: "host" }));
    await client.giveControl();
    assert.equal(client.getState().session?.controller, "visitor");
    await client.takeBackControl();
    assert.equal(client.getState().session?.control_gen, 4);
    await client.newInvite();
    await client.endSession();
    assert.equal(client.getState().status, "ended");
    assert.deepEqual(sent.slice(1).map((s) => [s.action, s.body.role, s.body.to]), [
      ["control", "host", "visitor"], ["control", "host", "host"], ["invite", "host", undefined], ["end", "host", undefined],
    ]);
  });
});
