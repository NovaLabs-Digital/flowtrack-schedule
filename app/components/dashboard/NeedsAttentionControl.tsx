"use client";

// Desktop "Needs attention" control -- a compact button, collapsed by
// default, that opens an anchored dropdown overlay covering Dispatch
// below it (never pushing it down or resizing the sidebar/calendar -- see
// the absolute positioning below). Data comes from
// useNeedsAttentionData.ts, which is the single source of truth this and
// the mobile equivalent both read.
import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useNeedsAttentionData, type NeedsAttentionEntry, type NeedsAttentionIssue, type NeedsAttentionIssueKind } from "@/app/components/dashboard/useNeedsAttentionData";
import { useOverlayMaxHeight } from "@/app/components/dashboard/useOverlayMaxHeight";
import { formatMMDDYY } from "@/lib/dateDisplay";

// Fallback cap when there's no better signal yet (first paint before the
// viewport-aware measurement below runs) -- roughly 65% of a typical
// laptop viewport, matching this control's original fixed max-height.
const FALLBACK_MAX_HEIGHT_PX = 520;

export default function NeedsAttentionControl({
  onNavigateToAppointment,
  onNavigateToBilling,
  refreshToken,
}: {
  // Worked-time-review and failed-message issues both select the
  // appointment (DashboardShell's existing selectAppointment, resolved
  // from the full, un-filtered appointments array, never the week-filtered
  // view), but each must land on its OWN matching section once selected --
  // a worked-time-review click should bring DispatchPanel's Employee
  // Worked Hours controls into view, a failed-message click should bring
  // AppointmentDetailPanel's Message History card into view, not just
  // "select the appointment and hope the right card happens to be on
  // screen." The issue kind is passed through so DashboardShell can scroll
  // the matching section into view (see its own needsAttentionFocusSection
  // state).
  onNavigateToAppointment: (appointmentId: string, issueKind: Exclude<NeedsAttentionIssueKind, "needs_invoicing" | "payment_outstanding">) => void;
  // Both billing-destination issue kinds (needs_invoicing AND
  // payment_outstanding -- mutually exclusive per appointment, see
  // lib/needsAttention.ts's own header, but share the same destination)
  // switch to Settings -> Billing AND tell BillingPanel which job to bring
  // into view (its own date range may default to "this week," which would
  // otherwise hide a job from another week).
  onNavigateToBilling: (appointmentId: string, serviceDate: string) => void;
  // Bump this (e.g. a counter) after an action elsewhere that's likely to
  // have resolved an item -- triggers a fresh fetch without the owner
  // needing to close and reopen the control.
  refreshToken?: number;
}) {
  const { entries, totalCount, hasMore, loadingMore, loadMore, rangeStart, rangeEnd, loading, error, refresh } = useNeedsAttentionData();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const maxHeight = useOverlayMaxHeight(rootRef, open, FALLBACK_MAX_HEIGHT_PX);

  // Skips the very first run: the mount-time fetch (useNeedsAttentionData's
  // own effect) already covers the initial load, so a parent that passes a
  // defined refreshToken from the start (e.g. 0) must not trigger a second,
  // redundant fetch before anything has actually changed. Only an actual
  // CHANGE to refreshToken after mount should refresh.
  const isFirstRefreshTokenRun = useRef(true);
  useEffect(() => {
    if (isFirstRefreshTokenRun.current) {
      isFirstRefreshTokenRun.current = false;
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    // Refetch every time the control is OPENED, so returning from Billing
    // (or anywhere else a resolution could have happened) and reopening
    // this always shows current state, without a full-page reload.
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeAndReturnFocus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function closeAndReturnFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function handleIssueClick(entry: NeedsAttentionEntry, issue: NeedsAttentionIssue) {
    if (issue.kind === "needs_invoicing" || issue.kind === "payment_outstanding") {
      onNavigateToBilling(entry.appointmentId, entry.serviceDate);
    } else {
      onNavigateToAppointment(entry.appointmentId, issue.kind);
    }
    closeAndReturnFocus();
  }

  // The collapsed button's own count: ALWAYS the server's totalCount
  // (every distinct appointment with an issue, across every page), never
  // entries.length (which only reflects whatever page(s) have loaded so
  // far) -- otherwise the badge would understate the real total until the
  // owner scrolled/loaded every page.
  const count = totalCount;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={listId}
        className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
      >
        <AlertCircle aria-hidden="true" size={15} className={count > 0 ? "text-amber-500" : "text-slate-400"} />
        {count > 0 ? `Needs attention · ${count}` : "Needs attention"}
      </button>

      {open && (
        <div
          id={listId}
          role="group"
          aria-label="Needs attention"
          className="absolute left-0 right-0 top-full mt-2 z-30 rounded-2xl border border-slate-200 bg-white shadow-lg max-h-[65vh] overflow-y-auto overflow-x-hidden"
          style={maxHeight != null ? { maxHeight } : undefined}
        >
          <div className="px-4 py-2 border-b border-slate-100 text-[11px] text-slate-400">
            {rangeStart && rangeEnd
              ? `Needs invoice number, Payment outstanding, and Worked time needs review cover your full history, not just recent work. Failed-message checks cover ${formatMMDDYY(rangeStart)} to ${formatMMDDYY(rangeEnd)}.`
              : "Loading date range..."}
          </div>
          {loading && entries.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-400">Loading...</div>
          ) : error ? (
            <div className="px-4 py-6 text-center text-xs text-rose-600">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-slate-400">No items need attention.</div>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {entries.map((entry) => (
                  <li key={entry.appointmentId} className="px-4 py-2.5">
                    <div className="text-xs font-medium text-slate-900 break-words">{entry.clientName}</div>
                    <div className="text-[11px] text-slate-500 break-words">
                      {entry.serviceType} · {formatMMDDYY(entry.serviceDate)}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {entry.issues.map((issue, idx) => (
                        <button
                          key={`${entry.appointmentId}-${issue.kind}-${idx}`}
                          type="button"
                          onClick={() => handleIssueClick(entry, issue)}
                          className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 transition-colors"
                        >
                          {issue.label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="px-4 py-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full rounded-md px-2 py-1.5 text-[11px] font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
                  >
                    {loadingMore ? "Loading..." : `Load more (${entries.length} of ${totalCount})`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
