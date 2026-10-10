"use client";

import { useEffect, useRef, useState } from "react";
import { toBusinessLocal } from "@/lib/timezone";

type MessageStatusCode = "sent" | "failed" | "skipped_disabled" | "skipped_notifications_off" | "unknown";

type HistoryMessage = {
  id: string;
  channel: "email" | "sms";
  kindLabel: string;
  toValue: string;
  body: string;
  subject: string | null;
  status: { code: MessageStatusCode; label: string };
  createdAt: string;
  scheduledFor: string | null;
};

const PAGE_SIZE = 20;

const STATUS_STYLES: Record<MessageStatusCode, string> = {
  sent: "text-blue-700 bg-blue-50",
  failed: "text-rose-700 bg-rose-50",
  skipped_disabled: "text-slate-600 bg-slate-100",
  skipped_notifications_off: "text-slate-600 bg-slate-100",
  unknown: "text-amber-700 bg-amber-50",
};

function formatSentAt(iso: string, timezone: string) {
  return toBusinessLocal(iso, timezone).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Shared list body for both scopes below -- a single fetch/paginate/render
// implementation, since the only real difference between "this appointment's
// history" and "this client's history across every appointment" is which
// endpoint and query param feed it.
function MessageHistoryList({ endpoint, timezone }: { endpoint: string; timezone: string }) {
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Guards against a stale response landing after a newer one: every call to
  // load() (the initial fetch for a selection, a "Show more" page, OR the
  // initial fetch for a DIFFERENT, later-selected appointment/client) claims
  // the next id. If that request's fetch resolves after a newer one has
  // already been issued -- e.g. the owner switches from appointment A to B
  // while A's request is still in flight, and A's response arrives after B's
  // effect has already reset state and started B's own fetch -- its id no
  // longer matches the ref's current value, so its result is discarded
  // rather than overwriting B's (or a later page's) state with stale data.
  const requestIdRef = useRef(0);

  async function load(offset: number, append: boolean) {
    const requestId = ++requestIdRef.current;
    if (append) setLoadingMore(true); else setLoading(true);
    setError("");
    try {
      const res = await fetch(`${endpoint}&limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return; // superseded -- discard
      if (!res.ok) { setError(data?.error || "Could not load message history."); return; }
      setMessages((prev) => (append ? [...prev, ...(data.messages ?? [])] : (data.messages ?? [])));
      setHasMore(!!data.hasMore);
    } catch {
      if (requestIdRef.current !== requestId) return;
      setError("Network error.");
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  // Re-fetches from the start whenever the endpoint itself changes (a
  // different appointment or client selected) -- never reuses a previous
  // selection's accumulated pages.
  useEffect(() => {
    setMessages([]);
    setHasMore(false);
    setExpandedId(null);
    load(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  if (loading) {
    return <div className="text-xs text-slate-400 py-2">Loading message history...</div>;
  }
  if (error) {
    return <div className="text-xs text-rose-600 py-2">{error}</div>;
  }
  // "No message record available" must never be read as "not sent" --
  // there are real, unlogged reasons a channel has zero rows (e.g. the
  // client's own Auto Email/Auto SMS setting was off at the time, which
  // writes no audit row at all) that this view has no way to distinguish
  // from any other gap. The wording is deliberately neutral.
  if (messages.length === 0) {
    return <div className="text-xs text-slate-400 py-2">No message record available.</div>;
  }

  return (
    <div className="space-y-1.5">
      {messages.map((m) => {
        const expanded = expandedId === m.id;
        const hasSnapshot = !!m.body || !!m.subject;
        return (
          <div key={m.id} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium text-slate-700 shrink-0">{m.channel === "email" ? "Email" : "SMS"}</span>
                <span className="text-slate-500 truncate">{m.kindLabel}</span>
              </div>
              <span className={["shrink-0 rounded px-1.5 py-0.5 font-medium", STATUS_STYLES[m.status.code]].join(" ")}>
                {m.status.label}
              </span>
            </div>
            <div className="mt-0.5 text-slate-500">
              to {m.toValue} &middot; {formatSentAt(m.createdAt, timezone)}
            </div>
            {hasSnapshot && (
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : m.id)}
                className="mt-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
              >
                {expanded ? "Hide message" : "View message"}
              </button>
            )}
            {expanded && hasSnapshot && (
              <div className="mt-1.5 rounded-md bg-slate-50 px-2 py-1.5 text-slate-700 space-y-1">
                {m.channel === "email" && (
                  <div>
                    <span className="font-medium text-slate-600">Subject: </span>
                    {m.subject || <span className="text-slate-400">Not captured</span>}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{m.body}</div>
              </div>
            )}
          </div>
        );
      })}
      {hasMore && (
        <button
          type="button"
          onClick={() => load(messages.length, true)}
          disabled={loadingMore}
          className="mt-1 text-[11px] font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
        >
          {loadingMore ? "Loading..." : "Show more"}
        </button>
      )}
    </div>
  );
}

// Appointment-scoped Message History -- used by desktop's
// AppointmentDetailPanel and mobile's MobileAppointmentDetail, both scoped
// to this exact appointment only.
export function AppointmentMessageHistory({ appointmentId, timezone }: { appointmentId: string; timezone: string }) {
  return <MessageHistoryList endpoint={`/api/appointments/messages?appointment_id=${encodeURIComponent(appointmentId)}`} timezone={timezone} />;
}

// Client-scoped Message History -- used by ClientPanel, covering every
// message across this client's appointments regardless of which calendar
// week they fall in.
export function ClientMessageHistory({ clientId, timezone }: { clientId: string; timezone: string }) {
  return <MessageHistoryList endpoint={`/api/clients/messages?client_id=${encodeURIComponent(clientId)}`} timezone={timezone} />;
}
