// Guided Demo Session browser client: what it sends with every data change
// (control generation, base version, one-time op id), how it mirrors the
// server's answers, and how it recovers (retries with the SAME op id, re-sync
// after a stale version, watch-only and ended states).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { closesEditor, defaultNav, offsetsFor, reduceView, type Role, type SharedView, type ShellNav, type ViewOp } from "./sharedView.ts";
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

// ---------------------------------------------------------------------
// Shared screen (lib/demoSession/sharedView.ts)
// ---------------------------------------------------------------------
describe("shared view: navigation and ordering", () => {
  const start = () => reduceView(null, { type: "init", nav: defaultNav("2026-11-02") }, "host").view!;
  const nav = (v: SharedView, patch: Partial<ShellNav>): ShellNav => ({ ...v.nav, ...patch });

  test("only the host starts the shared view; starting twice changes nothing", () => {
    assert.equal(reduceView(null, { type: "init", nav: defaultNav("2026-11-02") }, "visitor").outcome, "denied");
    const v = start();
    assert.equal(v.navVersion, 1);
    assert.equal(reduceView(v, { type: "init", nav: defaultNav("2026-11-03") }, "host").outcome, "noop");
  });

  test("navigation replaces the whole block (date, selection, dialog together) and is numbered in order", () => {
    const v = start();
    const r = reduceView(v, { type: "nav", nav: nav(v, { mode: "month", monthOffset: 1, clientId: "c1" }), baseNavVersion: 1 }, "host");
    assert.equal(r.outcome, "ok");
    assert.deepEqual([r.view!.navVersion, r.view!.navBy, r.view!.nav.mode, r.view!.nav.clientId], [2, "host", "month", "c1"]);
  });

  test("host priority: a guest move based on a view the host has since changed is refused", () => {
    const v1 = start();
    const v2 = reduceView(v1, { type: "nav", nav: nav(v1, { weekOffset: 1 }), baseNavVersion: 1 }, "host").view!;
    const late = reduceView(v2, { type: "nav", nav: nav(v1, { weekOffset: -1 }), baseNavVersion: 1 }, "visitor");
    assert.equal(late.outcome, "superseded");
    assert.equal(late.view!.nav.weekOffset, 1, "the host's view stands");
    // A guest move that HAS seen the host's latest change applies.
    assert.equal(reduceView(v2, { type: "nav", nav: nav(v2, { weekOffset: 2 }), baseNavVersion: 2 }, "visitor").outcome, "ok");
  });

  test("the host's move always applies, even over a guest move it hadn't seen", () => {
    const v1 = start();
    const v2 = reduceView(v1, { type: "nav", nav: nav(v1, { weekOffset: 3 }), baseNavVersion: 1 }, "visitor").view!;
    const r = reduceView(v2, { type: "nav", nav: nav(v1, { center: "settings" }), baseNavVersion: 1 }, "host");
    assert.equal(r.outcome, "ok");
    assert.deepEqual([r.view!.nav.center, r.view!.nav.weekOffset], ["settings", 0], "the whole block is the host's -- never a mix");
  });

  test("calendar position is kept across midnight: the same week from the next day's point of view", () => {
    const n = { ...defaultNav("2026-11-01"), weekOffset: 1, monthOffset: 0 }; // Sunday; next week = week of Nov 2
    assert.deepEqual(offsetsFor(n, "2026-11-01"), { weekOffset: 1, monthOffset: 0 });
    assert.deepEqual(offsetsFor(n, "2026-11-02"), { weekOffset: 0, monthOffset: 0 }, "Monday: the same week is now this week");
    assert.deepEqual(offsetsFor({ ...n, monthOffset: 1 }, "2026-12-01"), { weekOffset: -4, monthOffset: 0 });
  });

  test("scroll positions are validated and recorded with who scrolled", () => {
    const v = start();
    assert.deepEqual(reduceView(v, { type: "scroll", minutes: 510.4 }, "visitor").view!.scroll, { minutes: 510, by: "visitor" });
    assert.equal(reduceView(v, { type: "scroll", minutes: -5 }, "host").outcome, "denied");
    assert.equal(reduceView(v, { type: "scroll", minutes: Number.NaN }, "host").outcome, "denied");
  });
});

describe("shared view: one active editor and unsaved input", () => {
  const start = () => reduceView(null, { type: "init", nav: defaultNav("2026-11-02") }, "host").view!;
  const open = (v: SharedView, by: Role, appointmentId = "a1") =>
    reduceView(v, { type: "nav", nav: { ...v.nav, dialog: { id: `d-${appointmentId}`, kind: "edit", appointmentId } }, baseNavVersion: v.navVersion, label: "Appointment" }, by).view!;
  const seed = (v: SharedView, by: Role, fields: unknown, base = 5, key = "appointment:a1") =>
    reduceView(v, { type: "claim", key, base, initial: { notes: "" }, fields, anchor: {}, label: "Appointment" }, by);
  const draft = (v: SharedView, by: Role, fields: unknown) => reduceView(v, { type: "draft", key: v.editor!.key, epoch: v.editor!.epoch, fields }, by);

  test("opening a form reserves its editor for the opener; only they can seed it; the other follows", () => {
    const v = open(start(), "visitor");
    assert.deepEqual([v.editor!.key, v.editor!.role, v.editor!.fields], ["appointment:a1", "visitor", null]);
    assert.equal(seed(v, "host", { notes: "x" }).outcome, "denied", "the follower cannot type over the opener");
    const seeded = seed(v, "visitor", { notes: "" }).view!;
    assert.deepEqual([seeded.editor!.base, seeded.editor!.dirty], [5, false]);
  });

  test("only the active editor changes the draft; a request from before a takeover is refused", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }).view!;
    v = draft(v, "visitor", { notes: "Gate" }).view!;
    assert.equal(v.editor!.dirty, true);
    assert.equal(draft(v, "host", { notes: "nope" }).outcome, "denied");
    const oldEpoch = v.editor!.epoch;
    v = reduceView(v, { type: "takeover", key: "appointment:a1" }, "host").view!;
    assert.equal(reduceView(v, { type: "draft", key: "appointment:a1", epoch: oldEpoch, fields: { notes: "late" } }, "visitor").outcome, "denied");
  });

  test("host takeover keeps the guest's draft AND the original edit version; the guest can't take over a host who is typing", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }, 5).view!;
    v = draft(v, "visitor", { notes: "Guest typing" }).view!;
    v = reduceView(v, { type: "takeover", key: "appointment:a1" }, "host").view!;
    assert.deepEqual([v.editor!.role, v.editor!.fields, v.editor!.base, v.editor!.dirty], ["host", { notes: "Guest typing" }, 5, true]);
    assert.equal(reduceView(v, { type: "takeover", key: "appointment:a1" }, "visitor").outcome, "denied");
  });

  test("navigation that would close a form with unsaved input becomes a pending request -- nothing is closed or lost", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }).view!;
    v = draft(v, "visitor", { notes: "Unsaved" }).view!;
    const r = reduceView(v, { type: "nav", nav: { ...v.nav, dialog: null, center: "settings" }, baseNavVersion: v.navVersion, label: "Settings" }, "host");
    assert.equal(r.outcome, "pending");
    assert.equal(r.view!.nav.dialog?.kind, "edit", "still open");
    assert.deepEqual(r.view!.editor!.fields, { notes: "Unsaved" });
    assert.deepEqual([r.view!.pending!.by, r.view!.pending!.label], ["host", "Settings"]);
  });

  test("navigation that keeps the form open is not held up (e.g. moving the calendar behind it)", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }).view!;
    v = draft(v, "visitor", { notes: "Unsaved" }).view!;
    assert.equal(reduceView(v, { type: "nav", nav: { ...v.nav, weekOffset: 1 }, baseNavVersion: v.navVersion }, "host").outcome, "ok");
  });

  test("resolving a pending request: keep editing, discard (owner only), or the host continues and parks the draft", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }, 5).view!;
    v = draft(v, "visitor", { notes: "Unsaved" }).view!;
    const pend = reduceView(v, { type: "nav", nav: { ...v.nav, dialog: null }, baseNavVersion: v.navVersion }, "host").view!;
    const id = pend.pending!.id;
    assert.equal(reduceView(pend, { type: "resolve", pendingId: id, decision: "keep" }, "visitor").view!.pending, null);
    assert.equal(reduceView(pend, { type: "resolve", pendingId: id, decision: "discard" }, "host").outcome, "denied", "the host can't throw away the guest's draft");
    const discarded = reduceView(pend, { type: "resolve", pendingId: id, decision: "discard" }, "visitor").view!;
    assert.deepEqual([discarded.nav.dialog, discarded.editor], [null, null]);
    const parked = reduceView(pend, { type: "resolve", pendingId: id, decision: "continue_keep_draft" }, "host").view!;
    assert.equal(parked.nav.dialog, null);
    assert.deepEqual(parked.parked["appointment:a1"].fields, { notes: "Unsaved" });
    assert.equal(reduceView(pend, { type: "resolve", pendingId: id, decision: "continue_keep_draft" }, "visitor").outcome, "denied");
  });

  test("reopening that record's form restores the parked draft with its ORIGINAL edit version", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }, 5).view!;
    v = draft(v, "visitor", { notes: "Unsaved" }).view!;
    const pend = reduceView(v, { type: "nav", nav: { ...v.nav, dialog: null }, baseNavVersion: v.navVersion }, "host").view!;
    let back = reduceView(pend, { type: "resolve", pendingId: pend.pending!.id, decision: "continue_keep_draft" }, "host").view!;
    back = open(back, "host");
    const restored = seed(back, "host", { notes: "" }, 9).view!; // 9 = the version now on screen
    assert.deepEqual([restored.editor!.fields, restored.editor!.base, restored.editor!.dirty], [{ notes: "Unsaved" }, 5, true]);
    assert.deepEqual(restored.parked, {});
  });

  test("saving or cancelling (release) lets a waiting navigation go ahead", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }).view!;
    v = draft(v, "visitor", { notes: "Unsaved" }).view!;
    const pend = reduceView(v, { type: "nav", nav: { ...v.nav, dialog: null, center: "settings" }, baseNavVersion: v.navVersion }, "host").view!;
    const after = reduceView(pend, { type: "release", key: "appointment:a1" }, "visitor").view!;
    assert.deepEqual([after.nav.center, after.nav.dialog, after.editor, after.pending], ["settings", null, null, null]);
  });

  test("an always-open form is claimed by whoever types first; the other person's claim is refused, not merged", () => {
    const v = start();
    const claim = (by: Role, notes: string) => reduceView(v, { type: "claim", key: "company", base: 3, initial: { name: "A" }, fields: { name: notes }, anchor: { center: "settings" }, label: "Company details" }, by);
    const host = claim("host", "B").view!;
    assert.deepEqual([host.editor!.role, host.editor!.dirty], ["host", true]);
    assert.equal(reduceView(host, { type: "claim", key: "company", base: 3, initial: { name: "A" }, fields: { name: "C" }, anchor: {}, label: "" }, "visitor").outcome, "denied");
  });

  test("an explicit conflict acknowledgement (rebase) is the only thing that moves the edit version", () => {
    let v = seed(open(start(), "visitor"), "visitor", { notes: "" }, 5).view!;
    v = draft(v, "visitor", { notes: "x" }).view!;
    assert.equal(v.editor!.base, 5, "typing never changes it");
    v = reduceView(v, { type: "rebase", key: "appointment:a1", epoch: v.editor!.epoch, base: 8 }, "visitor").view!;
    assert.equal(v.editor!.base, 8);
    assert.equal(reduceView(v, { type: "rebase", key: "appointment:a1", epoch: v.editor!.epoch, base: 9 }, "host").outcome, "denied");
  });

  test("closesEditor compares only the values the form depends on", () => {
    const e = { anchor: { "dialog.id": "d1", "ui.clientEdit": "c1" } } as unknown as Parameters<typeof closesEditor>[0];
    const base = { ...defaultNav("2026-11-02"), dialog: { id: "d1", kind: "edit" as const, appointmentId: "a1" }, ui: { clientEdit: "c1" } };
    assert.equal(closesEditor(e, { ...base, weekOffset: 4 }), false);
    assert.equal(closesEditor(e, { ...base, ui: { clientEdit: null } }), true);
    assert.equal(closesEditor(e, { ...base, dialog: null }), true);
  });
});

describe("shared view: in-place edit forms", () => {
  const start = () => reduceView(null, { type: "init", nav: defaultNav("2026-11-02") }, "host").view!;
  test("an in-place form lives somewhere: leaving that place closes it (or asks first if it has unsaved input)", () => {
    let v = start();
    v = reduceView(v, { type: "nav", nav: { ...v.nav, clientId: "c1", ui: { clientEdit: "c1" } }, baseNavVersion: v.navVersion }, "visitor").view!;
    assert.deepEqual(v.editor!.anchor, { "ui.clientEdit": "c1", center: "schedule", clientId: "c1" });
    v = reduceView(v, { type: "claim", key: "ui:clientEdit:c1", base: 4, initial: { notes: "" }, fields: { notes: "" }, anchor: {}, label: "Angela's details" }, "visitor").view!;
    // Clean: moving to Settings just closes it -- flag included.
    const clean = reduceView(v, { type: "nav", nav: { ...v.nav, center: "settings" }, baseNavVersion: v.navVersion }, "host").view!;
    assert.deepEqual([clean.editor, clean.nav.ui.clientEdit], [null, null]);
    // Unsaved: the same move waits for a decision.
    v = reduceView(v, { type: "draft", key: "ui:clientEdit:c1", epoch: v.editor!.epoch, fields: { notes: "Gate" } }, "visitor").view!;
    assert.equal(reduceView(v, { type: "nav", nav: { ...v.nav, center: "settings" }, baseNavVersion: v.navVersion }, "host").outcome, "pending");
  });

  test("the host continuing parks the draft AND closes the form; reopening it restores the draft and its original edit version", () => {
    let v = start();
    v = reduceView(v, { type: "nav", nav: { ...v.nav, clientId: "c1", ui: { clientEdit: "c1" } }, baseNavVersion: v.navVersion }, "visitor").view!;
    v = reduceView(v, { type: "claim", key: "ui:clientEdit:c1", base: 4, initial: { notes: "" }, fields: { notes: "" }, anchor: {}, label: "Angela's details" }, "visitor").view!;
    v = reduceView(v, { type: "draft", key: "ui:clientEdit:c1", epoch: v.editor!.epoch, fields: { notes: "Gate" } }, "visitor").view!;
    v = reduceView(v, { type: "nav", nav: { ...v.nav, center: "settings" }, baseNavVersion: v.navVersion }, "host").view!;
    v = reduceView(v, { type: "resolve", pendingId: v.pending!.id, decision: "continue_keep_draft" }, "host").view!;
    assert.deepEqual([v.nav.center, v.nav.ui.clientEdit, v.editor], ["settings", null, null]);
    v = reduceView(v, { type: "nav", nav: { ...v.nav, center: "schedule", ui: { clientEdit: "c1" } }, baseNavVersion: v.navVersion }, "visitor").view!;
    v = reduceView(v, { type: "claim", key: "ui:clientEdit:c1", base: 9, initial: { notes: "" }, fields: { notes: "" }, anchor: {}, label: "Angela's details" }, "visitor").view!;
    assert.deepEqual([v.editor!.fields, v.editor!.base, v.editor!.dirty], [{ notes: "Gate" }, 4, true]);
  });
});

describe("shared view: scrolling inside panels", () => {
  const start = () => reduceView(null, { type: "init", nav: defaultNav("2026-11-02") }, "host").view!;
  const panel = (scope = "company", over: Record<string, unknown> = {}) =>
    ({ type: "panel", key: "settings", scope, path: [0, 3, 1], frac: 0.25, ratio: 0.5, focus: [0, 3, 1, 2], ...over }) as ViewOp;

  test("a panel position is stored per panel, with its scope and who moved it", () => {
    const v = reduceView(start(), panel(), "host").view!;
    assert.deepEqual(v.panels!.settings, { scope: "company", path: [0, 3, 1], frac: 0.25, ratio: 0.5, focus: [0, 3, 1, 2], by: "host" });
    const v2 = reduceView(v, { ...panel("appointment:a1"), key: "dialog" } as ViewOp, "visitor").view!;
    assert.deepEqual(Object.keys(v2.panels!).sort(), ["dialog", "settings"]);
  });

  test("malformed positions are refused", () => {
    const v = start();
    for (const bad of [{ key: "Bad Key" }, { frac: 2 }, { ratio: -1 }, { path: [1.5] }, { path: Array(31).fill(0) }, { focus: "x" }, { scope: "x".repeat(81) }]) {
      assert.equal(reduceView(v, panel("company", bad), "host").outcome, "denied", JSON.stringify(bad));
    }
  });

  test("while someone is editing, only the editor moves panels for both", () => {
    let v = start();
    v = reduceView(v, { type: "nav", nav: { ...v.nav, dialog: { id: "d1", kind: "edit", appointmentId: "a1" } }, baseNavVersion: v.navVersion }, "visitor").view!;
    v = reduceView(v, { type: "claim", key: "appointment:a1", base: 3, initial: {}, fields: {}, anchor: {}, label: "the appointment form" }, "visitor").view!;
    assert.equal(reduceView(v, { ...panel("appointment:a1"), key: "dialog" } as ViewOp, "host").outcome, "denied");
    assert.equal(reduceView(v, { ...panel("appointment:a1"), key: "dialog" } as ViewOp, "visitor").outcome, "ok");
  });
});

// ---------- session chat (migration 046) ----------
describe("session chat", () => {
  const msg = (id: number, role: "host" | "visitor" = "host", clientId = `c${id}`) => ({ id, role, name: role === "host" ? "Alberto" : "Dana", body: `m${id}`, at: "2026-11-01T12:00:00Z", clientId });
  const chatReply = (gen: number, messages: ReturnType<typeof msg>[], more = false) => ({ body: { outcome: "ok", session: view(), state: null, chat: { gen, messages, more } } });

  test("messages arrive on the check-in; the cursor and generation are sent back", async () => {
    const { client, sent } = await connected("visitor", [chatReply(1, [msg(1), msg(2, "visitor")]), chatReply(1, [msg(3)])]);
    await client.syncNow();
    assert.deepEqual(client.getState().chat.messages.map((m) => m.id), [1, 2]);
    assert.equal(client.getState().chat.available, true);
    await client.syncNow();
    assert.deepEqual([sent[2].body.chatGen, sent[2].body.chatSince], [1, 2]);
    assert.deepEqual(client.getState().chat.messages.map((m) => m.id), [1, 2, 3]);
  });

  test("a long conversation is fetched batch after batch in one check-in (nothing lost past 200)", async () => {
    const first = Array.from({ length: 200 }, (_, i) => msg(i + 1));
    const rest = Array.from({ length: 100 }, (_, i) => msg(i + 201));
    const { client, sent } = await connected("host", [chatReply(1, first, true), chatReply(1, rest, false)]);
    await client.syncNow();
    assert.equal(client.getState().chat.messages.length, 300);
    assert.deepEqual([sent[2].body.chatGen, sent[2].body.chatSince], [1, 200]);
  });

  test("a cleared conversation (new generation) drops every cached message and reads from the start", async () => {
    const { client, sent } = await connected("host", [chatReply(1, [msg(1), msg(2)]), chatReply(2, [])]);
    await client.syncNow();
    await client.syncNow();
    assert.deepEqual(client.getState().chat.messages, []);
    await client.syncNow().catch(() => {});
    assert.deepEqual([sent[3]?.body.chatGen, sent[3]?.body.chatSince], [2, null]);
  });

  test("before migration 046 chat is reported unavailable and sending does nothing", async () => {
    const { client, sent } = await connected("host", [{ body: { outcome: "ok", session: view(), state: null, chat: null } }]);
    await client.syncNow();
    assert.equal(client.getState().chat.available, false);
    assert.equal(client.sendChat("hello"), false);
    assert.equal(sent.filter((s) => s.action === "chat").length, 0);
  });

  test("sending: shown as sending, confirmed by the server answer", async () => {
    const { client, sent } = await connected("visitor", [chatReply(1, []), { body: { outcome: "ok", message: msg(5, "visitor", "op-1"), duplicate: false, chatGen: 1 } }]);
    await client.syncNow();
    assert.equal(client.sendChat("  hello  "), true);
    assert.deepEqual(client.getState().chat.outgoing.map((o) => [o.text, o.status]), [["hello", "sending"]]);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent.at(-1)!.body, { role: "visitor", clientId: "op-1", text: "hello" });
    assert.deepEqual(client.getState().chat.outgoing, []);
    assert.deepEqual(client.getState().chat.messages.map((m) => m.id), [5]);
  });

  test("a failed send keeps the text with a clear message; Retry resends under the same id", async () => {
    const { client, sent } = await connected("visitor", [
      chatReply(1, []),
      "network-error",
      { status: 429, body: { outcome: "rate_limited" } },
      { body: { outcome: "ok", message: msg(7, "visitor", "op-1"), duplicate: true, chatGen: 1 } },
    ]);
    await client.syncNow();
    client.sendChat("are you there?");
    await new Promise((r) => setTimeout(r, 0));
    let o = client.getState().chat.outgoing[0];
    assert.deepEqual([o.text, o.status], ["are you there?", "failed"]);
    assert.match(o.error!, /no connection.*kept.*Retry/);
    client.retryChat("op-1");
    await new Promise((r) => setTimeout(r, 0));
    o = client.getState().chat.outgoing[0];
    assert.match(o.error!, /too quickly/);
    client.retryChat("op-1");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(client.getState().chat.outgoing, []);
    assert.deepEqual(sent.filter((s) => s.action === "chat").map((s) => s.body.clientId), ["op-1", "op-1", "op-1"]);
  });

  test("a send whose answer was lost is confirmed by the next check-in -- never shown twice", async () => {
    const { client } = await connected("visitor", [chatReply(1, []), "network-error", chatReply(1, [msg(9, "visitor", "op-1")])]);
    await client.syncNow();
    client.sendChat("hi");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.getState().chat.outgoing[0].status, "failed");
    await client.syncNow();
    assert.deepEqual(client.getState().chat.outgoing, []);
    assert.equal(client.getState().chat.messages.length, 1);
  });

  test("Edit takes a failed message back for editing", async () => {
    const { client } = await connected("visitor", [chatReply(1, []), "network-error"]);
    await client.syncNow();
    client.sendChat("draft text");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(client.discardChat("op-1"), "draft text");
    assert.deepEqual(client.getState().chat.outgoing, []);
  });

  test("empty or over-long text is never sent", async () => {
    const { client, sent } = await connected("visitor", [chatReply(1, [])]);
    await client.syncNow();
    assert.equal(client.sendChat("   "), false);
    assert.equal(client.sendChat("x".repeat(501)), false);
    assert.equal(sent.filter((s) => s.action === "chat").length, 0);
  });

  test("when the session ends, messages and unsent text are cleared and nothing more can be sent", async () => {
    const { client } = await connected("visitor", [chatReply(1, [msg(1)]), { status: 410, body: { outcome: "ended", session: view({ status: "ended", end_reason: "host_ended" }) } }]);
    await client.syncNow();
    await client.syncNow();
    assert.equal(client.getState().status, "ended");
    assert.deepEqual([client.getState().chat.messages, client.getState().chat.outgoing], [[], []]);
    assert.equal(client.sendChat("hello?"), false);
  });

  test("chat never touches browser storage", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./client.ts", import.meta.url), "utf8");
    const card = readFileSync(new URL("../../app/components/demo-session/SessionChat.tsx", import.meta.url), "utf8");
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src), "the client keeps chat in memory only");
    // The card stores only its position.
    const keys = [...card.matchAll(/localStorage\.(\w+)\((\w+)\(/g)].map((m) => `${m[1]}:${m[2]}`);
    assert.deepEqual(keys.sort(), ["getItem:positionKey", "setItem:positionKey"]);
    assert.ok(!/sessionStorage|indexedDB/.test(card));
  });
});
