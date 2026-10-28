"use client";

// Mobile equivalent of app/components/dashboard/NeedsAttentionControl.tsx
// -- same data source (useNeedsAttentionData.ts), same collapsed-by-
// default/outside-tap/Escape/focus-return behavior, adapted to a single
// full-width column instead of a sidebar.
//
// Deliberately a SINGLE navigation action per appointment here, not one
// per issue: on desktop, a needs-invoicing issue opens Settings -> Billing
// specifically, a genuinely different destination from worked-time-review/
// failed-message issues (which open the appointment itself). Mobile has no
// Billing screen at all (MobileSettings is a minimal v1 placeholder -- see
// its own header comment), so there is only ONE real destination available
// here regardless of issue kind: the appointment's own detail screen.
// Offering three identically-acting buttons per appointment would be
// clutter, not three real choices -- so issue labels are shown as
// informational badges, and tapping anywhere on the row selects the
// appointment (same as tapping it from the Today/Schedule list).
//
// Needs-invoicing is never offered here at all (surface: "mobile" tells
// the server to never generate that issue kind in the first place -- see
// the route's own comment): tapping an entry would only ever reach the
// appointment's own detail screen, which has no billing action, so
// labeling a billing issue as actionable here would be dishonest. A
// persistent note below the date-range caption discloses that billing
// review is desktop-only, so it's never silently absent.
import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useNeedsAttentionData } from "@/app/components/dashboard/useNeedsAttentionData";
import { useOverlayMaxHeight } from "@/app/components/dashboard/useOverlayMaxHeight";

const FALLBACK_MAX_HEIGHT_PX = 420;

export default function MobileNeedsAttentionControl({
  onSelectAppointment,
}: {
  onSelectAppointment: (appointmentId: string) => void;
}) {
  const { entries, totalCount, hasMore, loadingMore, loadMore, rangeStart, rangeEnd, loading, error, refresh } = useNeedsAttentionData({ surface: "mobile" });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  const maxHeight = useOverlayMaxHeight(rootRef, open, FALLBACK_MAX_HEIGHT_PX);

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
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

  function handleEntryClick(appointmentId: string) {
    onSelectAppointment(appointmentId);
    closeAndReturnFocus();
  }

  // Always the server's full distinct-appointment total, independent of
  // how many have been loaded onto this page -- see
  // NeedsAttentionControl.tsx's identical comment.
  const count = totalCount;

  return (
    <div ref={rootRef} className="relative shrink-0 px-4 pt-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={listId}
        className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm active:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
      >
        <AlertCircle aria-hidden="true" size={13} className={count > 0 ? "text-amber-500" : "text-slate-400"} />
        {count > 0 ? `Needs attention · ${count}` : "Needs attention"}
      </button>

      {open && (
        <div
          id={listId}
          role="group"
          aria-label="Needs attention"
          className="absolute left-4 right-4 top-full mt-1 z-30 rounded-2xl border border-slate-200 bg-white shadow-lg max-h-[60vh] overflow-y-auto overflow-x-hidden"
          style={maxHeight != null ? { maxHeight } : undefined}
        >
          <div className="px-3 py-2 border-b border-slate-100 text-[10px] text-slate-400">
            {rangeStart && rangeEnd
              ? `Showing issues from ${rangeStart} to ${rangeEnd}.`
              : "Loading date range..."}
            <div className="mt-0.5">Billing review is available on desktop.</div>
          </div>
          {loading && entries.length === 0 ? (
            <div className="px-3 py-5 text-center text-xs text-slate-400">Loading...</div>
          ) : error ? (
            <div className="px-3 py-5 text-center text-xs text-rose-600">{error}</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-5 text-center text-xs text-slate-400">No items need attention.</div>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {entries.map((entry) => (
                  <li key={entry.appointmentId}>
                    <button
                      type="button"
                      onClick={() => handleEntryClick(entry.appointmentId)}
                      className="w-full text-left px-3 py-2.5 active:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                    >
                      <div className="text-xs font-medium text-slate-900 break-words">{entry.clientName}</div>
                      <div className="text-[11px] text-slate-500 break-words">
                        {entry.serviceType} · {entry.serviceDate}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {entry.issues.map((issue, idx) => (
                          <span
                            key={`${entry.appointmentId}-${issue.kind}-${idx}`}
                            className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                          >
                            {issue.label}
                          </span>
                        ))}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <div className="px-3 py-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full rounded-md px-2 py-1.5 text-[10px] font-medium text-blue-700 active:bg-blue-50 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors"
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
