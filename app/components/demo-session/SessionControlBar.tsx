"use client";

// Control strip for a Guided Demo Session (docked under the Demo Mode banner
// via DashboardShell's sessionBar slot, so it never covers the dashboard or
// its dialogs): who is in control, the
// visitor's presence, time left, and -- for the host -- Give Control, Take
// Back Control, the invitation link, and End Session. Every action is
// decided by the server; this bar only asks and shows the answer.
import { useEffect, useState } from "react";
import type { DemoRole, DemoSessionView } from "@/lib/demoSession/client";
import { SESSION_CONTROLS_ATTR } from "@/app/components/demo-session/WatchOnlyArea";

// The host action waiting for the server, shown on its own button.
export type PendingAction = "give" | "take" | "invite" | "end";

type Props = {
  role: DemoRole;
  session: DemoSessionView;
  offline: boolean;
  inviteUrl: string | null;
  pending: PendingAction | null;
  message: string | null;
  onGiveControl: () => void;
  onTakeBackControl: () => void;
  onNewInvite: () => void;
  onEndSession: () => void;
  onLeave: () => void;
};

function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

export default function SessionControlBar(props: Props) {
  const { role, session, offline, inviteUrl, pending, message } = props;
  const busy = pending !== null;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);

  // Keeps the minutes-left label current.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const visitorName = session.visitor_display_name || "Visitor";
  const iControl = session.controller === role;
  const controlLabel = iControl
    ? "You're in control"
    : role === "host"
      ? `${visitorName} is in control`
      : "Watching — the host is in control";

  async function copyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const button = "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50";

  return (
    // Outside the watch-only area (see WatchOnlyArea). While watching it also
    // rises above any open dialog (blocked then anyway), so Take Back
    // Control, End Session, and Leave are never covered; while in control
    // dialogs stay on top, so the bar never hides a dialog's own buttons.
    <div
      role="region"
      aria-label="Guided Demo Session controls"
      {...{ [SESSION_CONTROLS_ATTR]: "" }}
      className={`${iControl ? "" : "relative z-[80] "}shrink-0 border-b border-slate-200 bg-white px-4 py-2`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-blue-600">Guided Demo Session</div>
          <div className="text-sm font-semibold text-slate-900" aria-live="polite">{controlLabel}</div>
          <div className="text-xs text-slate-500">
            {[
              role === "host"
                ? session.visitor_joined
                  ? `${visitorName} · ${session.visitor_online ? "online" : "offline"}`
                  : session.invite_pending ? "Waiting for your visitor to join" : "No visitor yet"
                : !session.host_online ? "The host is reconnecting…" : null,
              `${minutesLeft(session.expires_at)} min left`,
              offline ? "Reconnecting…" : null,
            ].filter(Boolean).join(" · ")}
          </div>
          {message && <div role="alert" className="mt-1 text-xs text-amber-700">{message}</div>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {role === "host" && (
            <>
              {!session.visitor_joined && inviteUrl && (
                <button type="button" onClick={copyInvite} className={`${button} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
                  {copied ? "Copied" : "Copy invite link"}
                </button>
              )}
              {/* A new link replaces (and removes) the current visitor, so it
                  is only offered while nobody is connected. */}
              {!session.visitor_online && (
                <button type="button" disabled={busy} onClick={props.onNewInvite} className={`${button} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
                  {pending === "invite" ? "Creating link…" : "New invite link"}
                </button>
              )}
              {session.controller === "host" ? (
                <button
                  type="button"
                  disabled={busy || !session.visitor_online}
                  onClick={props.onGiveControl}
                  className={`${button} bg-blue-600 text-white hover:bg-blue-700`}
                >
                  {pending === "give" ? "Giving control…" : "Give Control"}
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={props.onTakeBackControl} className={`${button} bg-[#0f172a] text-white hover:bg-slate-800`}>
                  {pending === "take" ? "Taking back…" : "Take Back Control"}
                </button>
              )}
              {confirmEnd ? (
                <>
                  <button type="button" disabled={busy} onClick={props.onEndSession} className={`${button} bg-rose-600 text-white hover:bg-rose-700`}>
                    {pending === "end" ? "Ending…" : "Yes, end session"}
                  </button>
                  <button type="button" onClick={() => setConfirmEnd(false)} className={`${button} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
                    Keep going
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirmEnd(true)} className={`${button} border border-rose-300 text-rose-700 hover:bg-rose-50`}>
                  End Session
                </button>
              )}
            </>
          )}
          {role === "visitor" && (
            <button type="button" onClick={props.onLeave} className={`${button} border border-slate-300 text-slate-700 hover:bg-slate-50`}>
              Leave
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
