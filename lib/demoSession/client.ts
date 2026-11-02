// Guided Demo Session -- browser side (milestone 1).
//
// Holds the session's shared fictional dataset and status, polls the session
// API (about once a second while visible), and forwards every data change to
// the server with the caller's control generation, base version, and a
// one-time op id. The server is authoritative: it decides who may change
// data (and when), so this module only mirrors its answers.
//
// It plugs into the existing demo fetch interceptor as its session `store`
// (reads are answered locally from the synced dataset by the same demo
// handlers) and `forwardMutation` (changes go to the server).
import type { DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";
import type { DemoSessionMode, DemoStore } from "@/lib/demoLocal/fetchInterceptor";
import { editMarkerKey, reduceView, type SharedView, type ViewOp, type ViewOutcome } from "@/lib/demoSession/sharedView";
import { cleanChatText } from "@/lib/demoSession/chat";

export type DemoRole = "host" | "visitor";

export type SessionCursor = { anchor: string; x: number; y: number };

export type DemoSessionView = {
  id: string;
  status: "live" | "ended";
  end_reason: string | null;
  expires_at: string;
  controller: DemoRole;
  control_gen: number;
  state_version: number;
  invite_pending: boolean;
  invite_expires_at: string | null;
  visitor_joined: boolean;
  visitor_online: boolean;
  visitor_display_name: string | null;
  host_online: boolean;
  // Migration 044 (absent before it): the shared screen and fresh cursors.
  // `view` is left out of a reply when this browser already has that version.
  view?: unknown;
  view_version?: number;
  host_cursor?: SessionCursor | null;
  visitor_cursor?: SessionCursor | null;
};

export type DemoSessionStatus = "connecting" | "live" | "ended" | "unauthorized";

// Session chat (migration 046). Kept in this page's memory only -- never in
// browser storage. A message being sent, or one that failed, stays in
// outgoing with its text until it is confirmed (Retry resends it under the
// same clientId, so it can never arrive twice).
export type ChatMessage = { id: number; role: DemoRole; name: string; body: string; at: string; clientId: string };
export type ChatOutgoing = { clientId: string; text: string; status: "sending" | "failed"; error: string | null };
export type ChatState = {
  // null until the first check-in; false = chat isn't installed yet (before migration 046).
  available: boolean | null;
  messages: ChatMessage[];
  outgoing: ChatOutgoing[];
};

export type DemoSessionState = {
  status: DemoSessionStatus;
  session: DemoSessionView | null;
  dataset: DemoFixtureBundle | null;
  // Polling currently failing (network); the last known data stays visible.
  offline: boolean;
  // The shared screen both participants follow (lib/demoSession/sharedView.ts):
  // the server's latest, with this browser's own unconfirmed changes on top.
  view: SharedView | null;
  chat: ChatState;
};

export const WATCHING_MESSAGE = "You're watching. The host can give you control.";
// A save refused because someone changed the same record after this edit
// began. Nothing was saved; the form still holds what was typed.
export const CONFLICT_MESSAGE =
  "Someone else changed this while you were editing, so your changes weren't saved. They're still here: check the latest details, then save again to apply them.";
export const BUSY_MESSAGE = "The demo is busy with other changes. Please try again.";
export const ENDED_MESSAGE = "This Guided Demo Session has ended.";

// Where the host page leaves the invitation link for the session page
// (this tab only; never sent anywhere).
export const inviteStorageKey = (sessionId: string) => `sft-guided-invite:${sessionId}`;

const VISIBLE_POLL_MS = 1000;
const HIDDEN_POLL_MS = 4000;

type Options = {
  sessionId: string;
  role: DemoRole;
  fetchImpl?: () => typeof fetch;
  newOpId?: () => string;
  requestTimeoutMs?: number;
};

export const REQUEST_TIMEOUT_MS = 15_000;

type ApiResult = { status: number; data: Record<string, any> | null };

const respond = (status: number, data: unknown) =>
  new Response(JSON.stringify(data ?? null), { status, headers: { "content-type": "application/json" } });

export function createDemoSessionClient({ sessionId, role, fetchImpl, newOpId, requestTimeoutMs = REQUEST_TIMEOUT_MS }: Options) {
  const getFetch = fetchImpl ?? (() => globalThis.fetch.bind(globalThis));
  const opId = newOpId ?? (() => crypto.randomUUID());
  let state: DemoSessionState = {
    status: "connecting",
    session: null,
    dataset: null,
    offline: false,
    view: null,
    chat: { available: null, messages: [], outgoing: [] },
  };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const emit = () => listeners.forEach((l) => l());
  const update = (patch: Partial<DemoSessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  // A request that never answers fails after REQUEST_TIMEOUT_MS instead of
  // leaving the page waiting forever (a stuck host action would otherwise
  // keep the bar's buttons disabled with nothing on screen).
  async function call(action: string, body: Record<string, unknown>): Promise<ApiResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await getFetch()(`/api/demo-session/${sessionId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role, ...body }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // The version of the dataset this browser holds. Only ever advanced
  // together with the dataset itself, so a missed update is re-fetched.
  let heldVersion: number | null = null;

  // Shared screen: the server's view plus this browser's queued changes,
  // replayed in order on top so your own change shows at once. Changes are
  // sent one at a time; each answer carries the server's view, which wins.
  // This person's pointer, sent with each check-in (null = off the dashboard).
  let myCursor: SessionCursor | null = null;
  let serverView: SharedView | null = null;
  let serverViewVersion = 0;
  const viewQueue: Array<{ op: ViewOp; done: (outcome: ViewOutcome | "error") => void }> = [];
  let viewSending = false;

  function localView(): SharedView | null {
    let v = serverView;
    for (const { op } of viewQueue) v = reduceView(v, op, role).view ?? v;
    return v;
  }

  async function pumpView() {
    if (viewSending) return;
    viewSending = true;
    try {
      while (viewQueue.length > 0) {
        const item = viewQueue[0];
        let outcome: ViewOutcome | "error" = "error";
        for (let tries = 0; tries < 3; tries++) {
          try {
            const result = await call("view", { gen: state.session?.control_gen ?? 0, op: item.op });
            absorb(result);
            outcome = (result.data?.outcome as ViewOutcome) ?? "error";
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        viewQueue.shift();
        if (outcome === "error") void syncNow();
        update({ view: localView() });
        item.done(outcome);
      }
    } finally {
      viewSending = false;
    }
  }

  // Draft, scroll, and panel-scroll updates replace an earlier one still waiting to be sent.
  const coalesces = (a: ViewOp, b: ViewOp) =>
    (a.type === "draft" && b.type === "draft" && a.key === b.key && a.epoch === b.epoch) || (a.type === "scroll" && b.type === "scroll")
    || (a.type === "panel" && b.type === "panel" && a.key === b.key);

  function dispatchView(op: ViewOp): Promise<ViewOutcome | "error"> {
    const s = state.session;
    if (state.status === "ended" || !s) return Promise.resolve("denied");
    // A watching guest cannot change the shared screen (the server agrees).
    if (role === "visitor" && s.controller !== "visitor") return Promise.resolve("denied");
    return new Promise((done) => {
      const waiting = viewQueue.findIndex((q, i) => i > 0 && coalesces(q.op, op));
      if (waiting > 0) {
        viewQueue[waiting].done("ok");
        viewQueue[waiting] = { op, done };
      } else {
        viewQueue.push({ op, done });
      }
      update({ view: localView() });
      void pumpView();
    });
  }

  // Chat: the conversation generation and the last message held. A new
  // generation (the conversation was cleared) drops every cached message and
  // reads again from the start; more = true asks for the next batch at once.
  let chatGen: number | null = null;
  let chatSince: number | null = null;
  let chatMore = false;

  function mergeChat(chat: ChatState, incoming: ChatMessage[]): ChatState {
    if (incoming.length === 0) return chat;
    const byId = new Map(chat.messages.map((m) => [m.id, m]));
    for (const m of incoming) byId.set(m.id, m);
    const messages = [...byId.values()].sort((a, b) => a.id - b.id);
    const confirmed = new Set(incoming.map((m) => m.clientId));
    return { ...chat, messages, outgoing: chat.outgoing.filter((o) => !confirmed.has(o.clientId)) };
  }

  function absorbChat(raw: unknown): ChatState {
    if (raw === null) return { ...state.chat, available: false };
    const c = raw as { gen?: unknown; messages?: unknown; more?: unknown };
    if (typeof c.gen !== "number" || !Array.isArray(c.messages)) return state.chat;
    let chat: ChatState = { ...state.chat, available: true };
    if (c.gen !== chatGen) {
      chat = { ...chat, messages: [] };
      chatSince = null;
      chatGen = c.gen;
    }
    const incoming = c.messages as ChatMessage[];
    chat = mergeChat(chat, incoming);
    for (const m of incoming) if (chatSince === null || m.id > chatSince) chatSince = m.id;
    chatMore = c.more === true;
    return chat;
  }

  // Applies a server answer: session view, outcome, and (when sent) dataset.
  function absorb(result: ApiResult) {
    const d = result.data ?? {};
    if (d.outcome === "ended" || d.session?.status === "ended") {
      // Ended: nothing more can be sent and the conversation is gone.
      chatGen = null;
      chatSince = null;
      chatMore = false;
      update({
        status: "ended",
        session: d.session ?? state.session,
        offline: false,
        chat: { available: state.chat.available, messages: [], outgoing: [] },
      });
      return;
    }
    if (d.outcome === "unauthorized" || (result.status === 403 && !d.session)) {
      update({ status: "unauthorized", offline: false });
      return;
    }
    const patch: Partial<DemoSessionState> = { offline: false };
    if (d.session) patch.session = d.session;
    if (d.session && "view" in d.session) {
      serverView = (d.session.view ?? null) as SharedView | null;
      serverViewVersion = typeof d.session.view_version === "number" ? d.session.view_version : 0;
    }
    if (d.session) patch.view = localView();
    if (d.state && typeof d.state === "object" && d.session) {
      patch.dataset = d.state as DemoFixtureBundle;
      heldVersion = d.session.state_version;
    }
    if ("chat" in d) patch.chat = absorbChat(d.chat);
    if (state.status === "connecting" && (patch.dataset ?? state.dataset) && (patch.session ?? state.session)) {
      patch.status = "live";
    }
    update(patch);
  }

  async function syncNow(): Promise<void> {
    if (state.status === "ended" || state.status === "unauthorized") return;
    try {
      // A long conversation arrives in batches (at most 200 per answer):
      // keep asking until everything is held.
      for (let round = 0; round < 5; round++) {
        absorb(await call("sync", { since: heldVersion, viewSince: serverView ? serverViewVersion : null, cursor: myCursor, chatGen, chatSince }));
        if (!chatMore || state.status !== "live") break;
      }
    } catch {
      update({ offline: true });
    }
  }

  function chatError(status: number, outcome: unknown): string {
    if (outcome === "rate_limited" || status === 429) return "Not sent: you're sending messages too quickly. Wait a few seconds and press Retry.";
    if (outcome === "chat_full") return "Not sent: this chat has reached its 300-message limit.";
    if (outcome === "ended" || status === 410) return "Not sent: the session has ended.";
    if (outcome === "invalid_input") return "Not sent: messages must be 1 to 500 characters.";
    if (outcome === "chat_unavailable") return "Not sent: chat isn't available yet.";
    return "Not sent. Your message is kept -- press Retry.";
  }

  function markFailed(clientId: string, error: string) {
    update({
      chat: {
        ...state.chat,
        outgoing: state.chat.outgoing.map((o) => (o.clientId === clientId ? { ...o, status: "failed", error } : o)),
      },
    });
  }

  async function deliver(clientId: string, text: string): Promise<boolean> {
    try {
      const result = await call("chat", { clientId, text });
      const d = result.data ?? {};
      if (result.status === 200 && d.outcome === "ok" && d.message) {
        let chat = state.chat;
        if (typeof d.chatGen === "number" && d.chatGen === chatGen) chat = mergeChat(chat, [d.message as ChatMessage]);
        update({ chat: { ...chat, outgoing: chat.outgoing.filter((o) => o.clientId !== clientId) } });
        return true;
      }
      markFailed(clientId, chatError(result.status, d.outcome));
      if (d.outcome === "ended") absorb({ status: result.status, data: { outcome: "ended" } });
      return false;
    } catch {
      markFailed(clientId, "Not sent: no connection. Your message is kept -- press Retry.");
      return false;
    }
  }

  // Sends a chat message. Returns false (sending nothing) for empty or
  // over-long text, or when chat can't send; otherwise the message waits in
  // outgoing until it is confirmed.
  function sendChat(text: string): boolean {
    const clean = cleanChatText(text);
    if (clean === null || state.status !== "live" || state.chat.available !== true) return false;
    const clientId = opId();
    update({ chat: { ...state.chat, outgoing: [...state.chat.outgoing, { clientId, text: clean, status: "sending", error: null }] } });
    void deliver(clientId, clean);
    return true;
  }

  // Resends a failed message under the same clientId (never a duplicate).
  function retryChat(clientId: string) {
    const o = state.chat.outgoing.find((x) => x.clientId === clientId);
    if (!o || o.status !== "failed" || state.status !== "live") return;
    update({
      chat: { ...state.chat, outgoing: state.chat.outgoing.map((x) => (x.clientId === clientId ? { ...x, status: "sending", error: null } : x)) },
    });
    void deliver(clientId, o.text);
  }

  // Takes a failed message back; its text is returned for editing.
  function discardChat(clientId: string): string | null {
    const o = state.chat.outgoing.find((x) => x.clientId === clientId && x.status === "failed");
    if (!o) return null;
    update({ chat: { ...state.chat, outgoing: state.chat.outgoing.filter((x) => x.clientId !== clientId) } });
    return o.text;
  }

  function schedule() {
    if (!running) return;
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    timer = setTimeout(async () => {
      await syncNow();
      if (state.status === "ended" || state.status === "unauthorized") running = false;
      schedule();
    }, hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
  }

  const onWake = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void syncNow();
  };

  const store: DemoStore = {
    getSnapshot: () => {
      if (!state.dataset) throw new Error("Guided Demo Session data is not loaded yet.");
      return state.dataset;
    },
    // Reads never change data; the server owns every change.
    setSnapshot: () => {},
    notify: () => {},
  };

  // Where each open edit stands: its marker -> the dataset version its next
  // save is based on. Starts at the version the edit began from; moves to
  // the new version after a save (so further saves from the same form are
  // not refused because of its own change) and to the latest version after
  // a refused, conflicting save (so saving again is the person's informed
  // decision after reading the conflict message -- never an automatic retry).
  const editBases = new Map<string, number>();

  function parseEdit(edit: string | null): { key: string; base: number } | null {
    const m = edit?.match(/^([A-Za-z0-9-]{1,64}):(\d{1,15})$/);
    return m ? { key: m[1], base: Number(m[2]) } : null;
  }

  const forwardMutation: DemoSessionMode["forwardMutation"] = async (method, url, body, edit) => {
    const id = opId();
    const editStart = parseEdit(edit);
    const baseVersion = () => (editStart ? editBases.get(editStart.key) ?? editStart.base : heldVersion ?? state.session?.state_version ?? 0);
    const remember = (version: unknown) => {
      if (editStart && typeof version === "number") editBases.set(editStart.key, version);
    };
    const attempt = async (retriesLeft: number): Promise<Response> => {
      const s = state.session;
      if (state.status === "ended" || !s) return respond(410, { error: ENDED_MESSAGE });
      // The host can always edit; the guest only while the host allows it.
      if (role === "visitor" && s.controller !== "visitor") return respond(403, { error: WATCHING_MESSAGE });
      let result: ApiResult;
      try {
        result = await call("op", {
          gen: s.control_gen,
          baseVersion: baseVersion(),
          opId: id,
          method,
          path: url.pathname + url.search,
          body,
        });
      } catch {
        // The change may or may not have applied: catch up, then send the
        // SAME request again (same op id and starting version), which the
        // server applies at most once and checks for conflicts as before.
        await syncNow();
        if (retriesLeft > 0) return attempt(retriesLeft - 1);
        return respond(503, { error: "Connection lost. Please try again." });
      }
      const d = result.data ?? {};
      switch (d.outcome) {
        case "ok":
          absorb(result);
          remember(d.session?.state_version);
          return respond(d.status ?? 200, d.data);
        case "duplicate":
          await syncNow();
          remember(state.session?.state_version);
          return respond(d.status ?? 200, d.data);
        case "refused":
          absorb(result);
          return respond(d.status ?? 400, d.data);
        case "edit_conflict":
          // Nothing was saved; the form keeps what was typed and shows why.
          absorb(result);
          remember(d.session?.state_version);
          {
            // A shared draft keeps its edit version in the shared view; the
            // person saving again on purpose moves it (never synchronization).
            const e = localView()?.editor;
            if (editStart && e && editMarkerKey(e.key) === editStart.key && e.role === role && typeof d.session?.state_version === "number") {
              void dispatchView({ type: "rebase", key: e.key, epoch: e.epoch, base: d.session.state_version });
            }
          }
          return respond(409, { error: CONFLICT_MESSAGE, code: "edit_conflict" });
        case "stale_version":
          // The server kept losing races with other saves: report, never loop.
          absorb(result);
          return respond(409, { error: BUSY_MESSAGE });
        case "not_controller":
        case "stale_control":
          absorb(result);
          return respond(403, { error: WATCHING_MESSAGE });
        case "ended":
          absorb(result);
          return respond(410, { error: ENDED_MESSAGE });
        default:
          absorb(result);
          return respond(result.status >= 400 ? result.status : 500, { error: d.error ?? "Could not save. Please try again." });
      }
    };
    return attempt(1);
  };

  async function hostAction(action: "control" | "invite" | "end", body: Record<string, unknown> = {}) {
    const result = await call(action, body);
    absorb(result);
    return result;
  }

  return {
    store,
    forwardMutation,
    getState: () => state,
    // The dataset version on screen: where a new edit starts from.
    currentVersion: () => heldVersion ?? state.session?.state_version ?? null,
    dispatchView,
    sendChat,
    retryChat,
    discardChat,
    setCursor(cursor: SessionCursor | null) {
      myCursor = cursor;
    },
    // The server's navigation version this browser has seen (host priority).
    serverNavVersion: () => serverView?.navVersion ?? 0,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncNow,
    start() {
      if (running) return;
      running = true;
      void syncNow().then(schedule);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onWake);
      if (typeof window !== "undefined") window.addEventListener("focus", onWake);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onWake);
      if (typeof window !== "undefined") window.removeEventListener("focus", onWake);
    },
    // Guest editing on/off; the host can always edit.
    allowGuestControl: () => hostAction("control", { to: "visitor" }),
    stopGuestControl: () => hostAction("control", { to: "host" }),
    newInvite: () => hostAction("invite"),
    endSession: () => hostAction("end"),
    async leave() {
      try {
        await call("leave", {});
      } catch {
        // Leaving is best-effort: control returns to the host after 20s anyway.
      }
    },
  };
}

export type DemoSessionClient = ReturnType<typeof createDemoSessionClient>;
