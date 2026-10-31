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

export type DemoRole = "host" | "visitor";

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
};

export type DemoSessionStatus = "connecting" | "live" | "ended" | "unauthorized";

export type DemoSessionState = {
  status: DemoSessionStatus;
  session: DemoSessionView | null;
  dataset: DemoFixtureBundle | null;
  // Polling currently failing (network); the last known data stays visible.
  offline: boolean;
};

export const WATCHING_MESSAGE = "You're watching. The host can give you control.";
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
};

type ApiResult = { status: number; data: Record<string, any> | null };

const respond = (status: number, data: unknown) =>
  new Response(JSON.stringify(data ?? null), { status, headers: { "content-type": "application/json" } });

export function createDemoSessionClient({ sessionId, role, fetchImpl, newOpId }: Options) {
  const getFetch = fetchImpl ?? (() => globalThis.fetch.bind(globalThis));
  const opId = newOpId ?? (() => crypto.randomUUID());
  let state: DemoSessionState = { status: "connecting", session: null, dataset: null, offline: false };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const emit = () => listeners.forEach((l) => l());
  const update = (patch: Partial<DemoSessionState>) => {
    state = { ...state, ...patch };
    emit();
  };

  async function call(action: string, body: Record<string, unknown>): Promise<ApiResult> {
    const res = await getFetch()(`/api/demo-session/${sessionId}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role, ...body }),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }

  // The version of the dataset this browser holds. Only ever advanced
  // together with the dataset itself, so a missed update is re-fetched.
  let heldVersion: number | null = null;

  // Applies a server answer: session view, outcome, and (when sent) dataset.
  function absorb(result: ApiResult) {
    const d = result.data ?? {};
    if (d.outcome === "ended" || d.session?.status === "ended") {
      update({ status: "ended", session: d.session ?? state.session, offline: false });
      return;
    }
    if (d.outcome === "unauthorized" || (result.status === 403 && !d.session)) {
      update({ status: "unauthorized", offline: false });
      return;
    }
    const patch: Partial<DemoSessionState> = { offline: false };
    if (d.session) patch.session = d.session;
    if (d.state && typeof d.state === "object" && d.session) {
      patch.dataset = d.state as DemoFixtureBundle;
      heldVersion = d.session.state_version;
    }
    if (state.status === "connecting" && (patch.dataset ?? state.dataset) && (patch.session ?? state.session)) {
      patch.status = "live";
    }
    update(patch);
  }

  async function syncNow(): Promise<void> {
    if (state.status === "ended" || state.status === "unauthorized") return;
    try {
      absorb(await call("sync", { since: heldVersion }));
    } catch {
      update({ offline: true });
    }
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

  const forwardMutation: DemoSessionMode["forwardMutation"] = async (method, url, body) => {
    const id = opId();
    const attempt = async (retriesLeft: number): Promise<Response> => {
      const s = state.session;
      if (state.status === "ended" || !s) return respond(410, { error: ENDED_MESSAGE });
      if (s.controller !== role) return respond(403, { error: WATCHING_MESSAGE });
      let result: ApiResult;
      try {
        result = await call("op", {
          gen: s.control_gen,
          baseVersion: heldVersion ?? s.state_version,
          opId: id,
          method,
          path: url.pathname + url.search,
          body,
        });
      } catch {
        // The change may or may not have applied: catch up, then retry with
        // the same op id (the server applies an op id at most once).
        await syncNow();
        if (retriesLeft > 0) return attempt(retriesLeft - 1);
        return respond(503, { error: "Connection lost. Please try again." });
      }
      const d = result.data ?? {};
      switch (d.outcome) {
        case "ok":
          absorb(result);
          return respond(d.status ?? 200, d.data);
        case "duplicate":
          await syncNow();
          return respond(d.status ?? 200, d.data);
        case "refused":
          absorb(result);
          return respond(d.status ?? 400, d.data);
        case "stale_version":
          absorb(result);
          if (retriesLeft > 0) return attempt(retriesLeft - 1);
          return respond(409, { error: "The demo just changed. Please try again." });
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
    giveControl: () => hostAction("control", { to: "visitor" }),
    takeBackControl: () => hostAction("control", { to: "host" }),
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
