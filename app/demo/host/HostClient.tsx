"use client";

// Host start page for Guided Demo Sessions. Shows Resume Session when the
// host already has a live session; starting a new one then requires a clear
// confirmation, because it ends the current session (the server refuses a
// replacement unless the page confirms it).
import { useEffect, useState } from "react";
import { inviteStorageKey, type DemoSessionView } from "@/lib/demoSession/client";

type Started = { sessionId: string; inviteUrl: string };
type Load =
  | { kind: "loading" }
  | { kind: "ready"; current: DemoSessionView | null }
  | { kind: "message"; text: string };

const MESSAGES: Record<number, string> = {
  403: "Only the session host can start a Guided Demo Session. Sign in with the host account and try again.",
  404: "Guided Demo Sessions are not available.",
  503: "Guided Demo Sessions aren't set up yet.",
};

function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

export default function HostClient() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<Started | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/demo-session", { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setLoad({ kind: "message", text: MESSAGES[res.status] ?? "Couldn't load your session. Please try again." });
        return;
      }
      setLoad({ kind: "ready", current: data?.session ?? null });
    } catch {
      setLoad({ kind: "message", text: "Couldn't load your session. Please check your connection." });
    }
  }

  // Loads the host's current session from the server once on mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, []);

  async function start(replaceExisting: boolean) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/demo-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replaceExisting }),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 409 && data?.outcome === "active_session_exists") {
        setLoad({ kind: "ready", current: data.session });
        setConfirmReplace(true);
        return;
      }
      if (!res.ok || !data?.session?.id || typeof data.inviteUrl !== "string") {
        setError(MESSAGES[res.status] ?? "Couldn't start the session. Please try again.");
        return;
      }
      try {
        window.sessionStorage.setItem(inviteStorageKey(data.session.id), data.inviteUrl);
      } catch {
        // storage unavailable: a new link can be issued from the session
      }
      setStarted({ sessionId: data.session.id, inviteUrl: data.inviteUrl });
      setConfirmReplace(false);
    } catch {
      setError("Couldn't start the session. Please check your connection.");
    } finally {
      setStarting(false);
    }
  }

  async function copy() {
    if (!started) return;
    try {
      await navigator.clipboard.writeText(started.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const current = load.kind === "ready" ? load.current : null;
  const primary = "rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50";
  const secondary = "rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="max-w-lg w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">Guided Demo Session</div>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">Show ScheduleFlowTrack to one visitor</h1>
        <p className="mt-2 text-sm text-slate-600">
          You both see the same fictional demo. Your visitor starts by watching; you can give them control and take it back at any time.
          Sessions last up to two hours.
        </p>

        {load.kind === "loading" && <p className="mt-5 text-sm text-slate-500" aria-busy="true">Checking for a session in progress…</p>}
        {load.kind === "message" && <p role="alert" className="mt-5 text-sm text-slate-700">{load.text}</p>}

        {load.kind === "ready" && !started && (
          <div className="mt-5 space-y-4">
            {current && (
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                <div className="text-sm font-semibold text-slate-900">You have a session in progress</div>
                <div className="mt-1 text-xs text-slate-600">
                  {current.visitor_joined ? `Visitor: ${current.visitor_display_name || "joined"}` : "No visitor has joined yet"}
                  {" · "}{minutesLeft(current.expires_at)} min left
                </div>
                <a href={`/demo/session/${current.id}?as=host`} className={`mt-3 inline-block ${primary}`}>
                  Resume Session
                </a>
              </div>
            )}

            {current && confirmReplace ? (
              <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
                <div className="text-sm font-semibold text-amber-900">Start a new session?</div>
                <p className="mt-1 text-sm text-amber-900">
                  This ends your current session right away. Your visitor will be disconnected and its invitation link will stop working.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => start(true)} disabled={starting} className="rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                    {starting ? "Starting…" : "End it and start a new session"}
                  </button>
                  <button type="button" onClick={() => setConfirmReplace(false)} className={secondary}>
                    Keep the current session
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => (current ? setConfirmReplace(true) : start(false))}
                disabled={starting}
                className={current ? secondary : primary}
              >
                {starting ? "Starting…" : current ? "Start a new session instead" : "Start a session"}
              </button>
            )}
          </div>
        )}

        {started && (
          <div className="mt-5 space-y-3">
            <label className="block text-xs font-medium text-slate-600" htmlFor="invite-link">
              Invitation link (works once, for 30 minutes)
            </label>
            <div className="flex gap-2">
              <input id="invite-link" readOnly value={started.inviteUrl} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700" />
              <button type="button" onClick={copy} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <a href={`/demo/session/${started.sessionId}?as=host`} className="inline-block rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
              Open the session
            </a>
          </div>
        )}

        {error && <p role="alert" className="mt-4 text-sm text-rose-700">{error}</p>}
      </div>
    </main>
  );
}
