// Guided Demo Session browser client: what it sends with every data change
// (control generation, base version, one-time op id), how it mirrors the
// server's answers, and how it recovers (retries with the SAME op id, re-sync
// after a stale version, watch-only and ended states).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { changedRecords, conflictingRecords, splitDataset, withRecordVersions, RECORD_VERSIONS_KEY, type SessionDataset } from "./recordVersions.ts";
import type { DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";
import { createDemoSessionClient, WATCHING_MESSAGE, ENDED_MESSAGE, CONFLICT_MESSAGE, BUSY_MESSAGE, type DemoSessionView } from "./client.ts";

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
    const res = await client.forwardMutation("POST", url, { x: 1 }, null);
    assert.deepEqual(await res.json(), { appointmentId: "a9" });
    assert.deepEqual(sent[1].body, { role: "visitor", gen: 2, baseVersion: 5, opId: "op-1", method: "POST", path: "/api/appointments/create", body: { x: 1 } });
    assert.deepEqual(client.store.getSnapshot(), dataset(6));
  });

  test("the host can always save, including while the guest may edit too", async () => {
    for (const controller of ["host", "visitor"] as const) {
      const { client, sent } = await connected("host", [
        { body: { outcome: "ok", status: 200, data: { ok: true }, session: view({ controller, state_version: 6 }), state: dataset(6) } },
      ], view({ controller }));
      const res = await client.forwardMutation("POST", url, {}, null);
      assert.equal(res.status, 200, controller);
      assert.equal(sent[1].action, "op");
    }
  });

  test("while the guest is watching, nothing is sent and the guest is told why", async () => {
    const { client, sent } = await connected("visitor", [], view({ controller: "host" }));
    const res = await client.forwardMutation("POST", url, {}, null);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: WATCHING_MESSAGE });
    assert.equal(sent.length, 1, "only the initial sync");
  });

  test("guest control stopped while a guest change was in flight: refused, the guest's view switches to watching", async () => {
    const { client } = await connected("visitor", [
      { status: 409, body: { outcome: "stale_control", session: view({ controller: "host", control_gen: 3 }) } },
    ]);
    const res = await client.forwardMutation("POST", url, {}, null);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: WATCHING_MESSAGE });
    assert.equal(client.getState().session?.controller, "host");
    assert.equal(client.getState().session?.control_gen, 3);
  });

  test("an edit is based on the version on screen when it BEGAN, not when Save is clicked", async () => {
    const { client, sent } = await connected("host", [
      { body: { outcome: "ok", session: view({ state_version: 9 }), state: dataset(9) } }, // others' changes arrive
      { body: { outcome: "ok", status: 200, data: { ok: true }, session: view({ state_version: 10 }), state: dataset(10) } },
    ]);
    await client.syncNow();
    await client.forwardMutation("PATCH", url, {}, "edit-1:5");
    assert.equal(sent[2].body.baseVersion, 5);
  });

  test("an edit conflict is reported, nothing is retried, and saving again is based on the latest version", async () => {
    const { client, sent } = await connected("visitor", [
      { status: 409, body: { outcome: "edit_conflict", conflicts: ["appointments:a1"], session: view({ state_version: 8 }), state: dataset(8) } },
      { body: { outcome: "ok", status: 200, data: { ok: true }, session: view({ state_version: 9 }), state: dataset(9) } },
    ]);
    const res = await client.forwardMutation("PATCH", url, { notes: "mine" }, "edit-1:5");
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: CONFLICT_MESSAGE, code: "edit_conflict" });
    assert.equal(sent.filter((x) => x.action === "op").length, 1, "no automatic retry");
    assert.deepEqual(client.store.getSnapshot(), dataset(8), "the latest data is shown");
    // The person read the message and saves again on purpose.
    await client.forwardMutation("PATCH", url, { notes: "mine" }, "edit-1:5");
    assert.equal(sent[2].body.baseVersion, 8);
  });

  test("after a successful save, further saves from the same form are based on that save", async () => {
    const { client, sent } = await connected("host", [
      { body: { outcome: "ok", status: 200, data: { ok: true }, session: view({ state_version: 6 }), state: dataset(6) } },
      { body: { outcome: "ok", status: 200, data: { ok: true }, session: view({ state_version: 7 }), state: dataset(7) } },
    ]);
    await client.forwardMutation("PATCH", url, {}, "edit-1:5");
    await client.forwardMutation("PATCH", url, {}, "edit-1:5");
    assert.deepEqual(sent.filter((x) => x.action === "op").map((o) => o.body.baseVersion), [5, 6]);
  });

  test("when the server keeps losing races with other saves it says so, without looping", async () => {
    const { client, sent } = await connected("visitor", [
      { status: 409, body: { outcome: "stale_version", session: view({ state_version: 7 }), state: dataset(7) } },
    ]);
    const res = await client.forwardMutation("POST", url, {}, null);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: BUSY_MESSAGE });
    assert.equal(sent.filter((x) => x.action === "op").length, 1);
  });

  test("a lost connection resends the SAME request (op id and starting version); 'duplicate' returns the original result", async () => {
    const { client, sent } = await connected("visitor", [
      "network-error",
      { body: { outcome: "ok", session: view({ state_version: 6 }), state: dataset(6) } }, // catch-up sync
      { body: { outcome: "duplicate", status: 200, data: { appointmentId: "a9" }, session: view({ state_version: 6 }) } },
      { body: { outcome: "ok", session: view({ state_version: 6 }), state: null } }, // sync after duplicate
    ]);
    const res = await client.forwardMutation("POST", url, {}, "edit-1:5");
    assert.deepEqual(await res.json(), { appointmentId: "a9" });
    const ops = sent.filter((s) => s.action === "op");
    assert.deepEqual(ops.map((o) => [o.body.opId, o.body.baseVersion]), [["op-1", 5], ["op-1", 5]]);
  });

  test("a malformed edit marker is ignored (falls back to the version on screen)", async () => {
    const { client, sent } = await connected("host", [
      { body: { outcome: "ok", status: 200, data: {}, session: view({ state_version: 6 }), state: dataset(6) } },
    ]);
    await client.forwardMutation("POST", url, {}, "not a marker");
    assert.equal(sent[1].body.baseVersion, 5);
  });

  test("the demo's rules refusing a change passes the real error through", async () => {
    const { client } = await connected("visitor", [
      { body: { outcome: "refused", status: 400, data: { error: "Client not found" }, session: view() } },
    ]);
    const res = await client.forwardMutation("POST", url, {}, null);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Client not found" });
  });

  test("after the session ends, changes are refused locally", async () => {
    const { client } = await connected("host", [{ status: 410, body: { outcome: "ended", session: view({ status: "ended" }) } }], view({ controller: "host" }));
    await client.syncNow();
    const res = await client.forwardMutation("POST", url, {}, null);
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { error: ENDED_MESSAGE });
  });

  test("currentVersion is the dataset version on screen", async () => {
    const { client } = await connected("host", []);
    assert.equal(client.currentVersion(), 5);
  });
});

describe("host actions", () => {
  test("allow / stop guest control, new invite, and end post to the session API as the host", async () => {
    const { client, sent } = await connected("host", [
      { body: { outcome: "ok", session: view({ controller: "visitor", control_gen: 3 }) } },
      { body: { outcome: "ok", session: view({ controller: "host", control_gen: 4 }) } },
      { body: { outcome: "ok", session: view(), inviteUrl: "x" } },
      { body: { outcome: "ok", session: view({ status: "ended" }) } },
    ], view({ controller: "host" }));
    await client.allowGuestControl();
    assert.equal(client.getState().session?.controller, "visitor");
    await client.stopGuestControl();
    assert.equal(client.getState().session?.control_gen, 4);
    await client.newInvite();
    await client.endSession();
    assert.equal(client.getState().status, "ended");
    assert.deepEqual(sent.slice(1).map((s) => [s.action, s.body.role, s.body.to]), [
      ["control", "host", "visitor"], ["control", "host", "host"], ["invite", "host", undefined], ["end", "host", undefined],
    ]);
  });
});

describe("requests that never answer", () => {
  // A fetch that only settles when aborted, like a request stuck on the network.
  const hangingFetch = () => ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  })) as unknown as typeof fetch;

  test("a host action that gets no answer fails with AbortError after the time limit instead of waiting forever", async () => {
    const client = createDemoSessionClient({ sessionId: SID, role: "host", fetchImpl: hangingFetch, requestTimeoutMs: 30 });
    for (const action of [client.stopGuestControl, client.endSession, client.allowGuestControl]) {
      const started = Date.now();
      await assert.rejects(action(), (e: Error) => e.name === "AbortError");
      assert.ok(Date.now() - started < 2000);
    }
  });

  test("a sync that gets no answer marks the view offline, so polling carries on", async () => {
    const client = createDemoSessionClient({ sessionId: SID, role: "host", fetchImpl: hangingFetch, requestTimeoutMs: 30 });
    await client.syncNow();
    assert.equal(client.getState().offline, true);
  });
});

// ---------------------------------------------------------------------
// Record-level edit conflicts (lib/demoSession/recordVersions.ts)
// ---------------------------------------------------------------------
const base = (): DemoFixtureBundle => ({
  sessionInitIso: "2026-11-01T00:00:00.000Z",
  clients: [{ id: "c1", name: "Angela Winslow", notes: null }, { id: "c2", name: "Brianna Holt", notes: null }],
  appointments: [{ id: "a1", client_id: "c1", notes: "old" }, { id: "a2", client_id: "c2", notes: null }],
  employees: [],
  services: [{ id: "s1", name: "Window Washing" }],
  employeeHours: [],
  assignments: [],
  completedJobBilling: [],
  messagesSent: [],
  recurringSeries: [],
  companySettings: { company_name: "Palmetto Cove Services" },
} as unknown as DemoFixtureBundle);

describe("record versions: changedRecords", () => {
  test("names exactly the records that were changed, added, or removed", () => {
    const before = base();
    const after = structuredClone(before);
    after.appointments[0].notes = "new";
    after.clients.push({ id: "c3", name: "New Client", notes: null } as unknown as DemoFixtureBundle["clients"][number]);
    after.services = [];
    assert.deepEqual(changedRecords(before, after), ["appointments:a1", "clients:c3", "services:s1"]);
  });

  test("order within a list does not count as a change", () => {
    const before = base();
    const after = structuredClone(before);
    after.clients.reverse();
    assert.deepEqual(changedRecords(before, after), []);
  });

  test("single-object values such as company settings are one record", () => {
    const before = base();
    const after = structuredClone(before);
    after.companySettings = { ...after.companySettings, company_name: "Renamed" } as DemoFixtureBundle["companySettings"];
    assert.deepEqual(changedRecords(before, after), ["companySettings"]);
  });

  test("the record versions themselves are never counted as a change", () => {
    const before = { ...base(), [RECORD_VERSIONS_KEY]: { "clients:c1": 3 } } as unknown as DemoFixtureBundle;
    const after = { ...base(), [RECORD_VERSIONS_KEY]: { "clients:c1": 4 } } as unknown as DemoFixtureBundle;
    assert.deepEqual(changedRecords(before, after), []);
  });
});

describe("record versions: conflictingRecords", () => {
  const versions = { "appointments:a1": 7, "clients:c2": 4 };
  test("a touched record changed after the edit began is a conflict", () => {
    assert.deepEqual(conflictingRecords(["appointments:a1"], versions, 5), ["appointments:a1"]);
  });
  test("a touched record unchanged since the edit began is not", () => {
    assert.deepEqual(conflictingRecords(["appointments:a1"], versions, 7), []);
    assert.deepEqual(conflictingRecords(["clients:c2"], versions, 5), []);
  });
  test("changes to OTHER records never conflict", () => {
    assert.deepEqual(conflictingRecords(["appointments:a2", "clients:c1"], versions, 0), []);
  });
  test("records never changed in the session (version 0) never conflict", () => {
    assert.deepEqual(conflictingRecords(["services:s1"], {}, 0), []);
  });
});

describe("record versions: splitDataset / withRecordVersions", () => {
  test("the handlers get the dataset without record versions; the stored dataset gets them back, updated", () => {
    const stored = { ...base(), [RECORD_VERSIONS_KEY]: { "clients:c1": 2 } } as SessionDataset;
    const { bundle, versions } = splitDataset(stored);
    assert.equal(RECORD_VERSIONS_KEY in bundle, false);
    assert.deepEqual(versions, { "clients:c1": 2 });
    const next = withRecordVersions(bundle, versions, ["appointments:a1"], 9);
    assert.deepEqual(next[RECORD_VERSIONS_KEY], { "clients:c1": 2, "appointments:a1": 9 });
    assert.deepEqual(versions, { "clients:c1": 2 }, "input versions are not modified");
  });
  test("a dataset from before record versions existed starts with none", () => {
    assert.deepEqual(splitDataset(base() as SessionDataset).versions, {});
  });
});
