"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { nowInBusinessTz } from "@/lib/timezone";
import { formatCents } from "@/lib/money";
import { formatMMDDYY } from "@/lib/dateDisplay";
import {
  PAYMENT_METHODS,
  BILLING_STATUS_FILTERS,
  BILLING_SORT_ORDERS,
  DEFAULT_BILLING_SORT_ORDER,
  DEFAULT_BILLING_STATUS_FILTER,
  applyBillingStatusFilter,
  applyGroupedBillingUpdate,
  computeBillingSummary,
  matchesClientSearch,
  sortCompletedJobRows,
  isValidBillingSortOrder,
  isValidBillingStatusFilter,
  type BillingStatusFilter,
  type BillingSortOrder,
  type CompletedJobRow,
  type ReviewNeededRow,
} from "@/lib/completedJobBilling";

// Monday 00:00 (workspace-local), `offsetWeeks` weeks from this week -- same
// calculation as app/schedule/page.tsx's own (unexported) mondayOfWeek.
// Duplicated locally rather than factored into a shared helper, matching
// this codebase's existing convention of each date-range-owning component
// (DispatchPanel, app/schedule/page.tsx) keeping its own small copy rather
// than forcing a premature shared abstraction.
function mondayOfWeek(offsetWeeks: number, tz: string): Date {
  const d = nowInBusinessTz(tz);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff + offsetWeeks * 7);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Monday 00:00 of the week CONTAINING a given "YYYY-MM-DD" workspace-local
// calendar date -- used only when this panel is opened with a deep-link
// focus target (e.g. from the Needs Attention control), to seed the date
// range around that job's own service date instead of "this week." Plain
// local-calendar arithmetic (3-argument Date constructor, never
// `new Date("YYYY-MM-DD")`) -- the input is already a resolved
// workspace-local calendar day, so no further timezone conversion is
// needed or safe to apply (same convention as AppointmentDetailPanel.tsx's
// formatReportedDate).
function mondayOfWeekContaining(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();
  const diff = (dow + 6) % 7;
  dt.setDate(dt.getDate() - diff);
  return dt;
}
function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type FetchState = { completed: CompletedJobRow[]; reviewNeeded: ReviewNeededRow[] } | null;

const BILLING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Navigation/filter preferences: remembered per (user, workspace) on this
// browser only -- same sft_... prefix and per-person+per-tenant scoping
// convention as useDashboardLayoutPrefs.ts's localStorage key (never read
// or written by any server route, and never a billing/invoice VALUE --
// only which range/filter/sort/search/scroll the owner last chose). v1:
// consolidates what used to be a standalone sort-order-only key
// (sft_billing_sort_order_v1_...) plus four new fields into one object, so
// a custom date range, status filter, sort, and client search all survive
// a save, a remount (leaving and returning to the Billing tab), or a hard
// refresh -- not just the sort order. The old standalone key is simply
// orphaned (same precedent as useDashboardLayoutPrefs.ts's own v1 -> v2
// migration): nothing reads it anymore, nothing explicitly clears it.
type BillingPrefs = {
  rangeStart: string;
  rangeEnd: string;
  statusFilter: BillingStatusFilter;
  sortOrder: BillingSortOrder;
  clientSearch: string;
  // Settings scroll container's scrollTop, restored (clamped) once data has
  // reloaded after a remount -- see the restore effect below. Best-effort
  // ("where practical"): flushed opportunistically whenever any other field
  // here is persisted, plus once on unmount, not on every scroll tick.
  scrollTop: number;
};

function billingPrefsStorageKey(userId: string, workspaceId: string): string {
  return `sft_billing_prefs_v1_${userId}_${workspaceId}`;
}

// "This week" -- the same default the unbounded range used before this
// preference existed, and still what a first-ever visit (or a browser with
// no/unavailable storage) sees.
function defaultBillingRange(timezone: string): { rangeStart: string; rangeEnd: string } {
  const monday = mondayOfWeek(0, timezone);
  return { rangeStart: toDateInputValue(monday), rangeEnd: toDateInputValue(addDays(monday, 6)) };
}

function readStoredBillingPrefs(userId: string, workspaceId: string, timezone: string): BillingPrefs {
  const fallbackRange = defaultBillingRange(timezone);
  const fallback: BillingPrefs = {
    ...fallbackRange,
    statusFilter: DEFAULT_BILLING_STATUS_FILTER,
    sortOrder: DEFAULT_BILLING_SORT_ORDER,
    clientSearch: "",
    scrollTop: 0,
  };
  try {
    const raw = window.localStorage.getItem(billingPrefsStorageKey(userId, workspaceId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const p = parsed as Record<string, unknown>;
    // Every field is validated independently -- a corrupted or
    // partially-invalid stored blob falls back field-by-field to the exact
    // same default a first-ever visit sees, never trusted verbatim, same
    // rule as every other localStorage read in this app (see
    // useDashboardLayoutPrefs.ts's own readStoredPrefs).
    return {
      rangeStart: typeof p.rangeStart === "string" && BILLING_DATE_RE.test(p.rangeStart) ? p.rangeStart : fallback.rangeStart,
      rangeEnd: typeof p.rangeEnd === "string" && BILLING_DATE_RE.test(p.rangeEnd) ? p.rangeEnd : fallback.rangeEnd,
      statusFilter: isValidBillingStatusFilter(p.statusFilter) ? p.statusFilter : fallback.statusFilter,
      sortOrder: isValidBillingSortOrder(p.sortOrder) ? p.sortOrder : fallback.sortOrder,
      clientSearch: typeof p.clientSearch === "string" ? p.clientSearch : fallback.clientSearch,
      scrollTop: typeof p.scrollTop === "number" && Number.isFinite(p.scrollTop) && p.scrollTop >= 0 ? p.scrollTop : 0,
    };
  } catch {
    // Unavailable storage (e.g. Safari private mode throws on access) --
    // fall back to the defaults exactly as if nothing had ever been saved.
    return fallback;
  }
}

function writeStoredBillingPrefs(userId: string, workspaceId: string, prefs: BillingPrefs) {
  try {
    window.localStorage.setItem(billingPrefsStorageKey(userId, workspaceId), JSON.stringify(prefs));
  } catch {
    // Quota exceeded or storage disabled -- the in-memory selection still
    // works for the rest of this session, it just won't be remembered.
  }
}

// Unconditional read-modify-write of just the scrollTop field, used only by
// the unmount-flush below -- deliberately NOT a read of any in-memory
// "current prefs" snapshot (which would be stale by the time an unmount
// cleanup with an empty dependency array runs); re-reading storage here
// instead means this can never clobber a range/filter/search change the
// owner made after the component mounted.
function writeStoredScrollTop(userId: string, workspaceId: string, scrollTop: number) {
  try {
    const key = billingPrefsStorageKey(userId, workspaceId);
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem(key, JSON.stringify({ ...parsed, scrollTop }));
  } catch {
    // Unavailable storage -- nothing to flush.
  }
}

// Walks up from a node to the nearest ancestor that actually scrolls --
// BillingPanel has no ref to DashboardSettingsArea's own scroll container
// (a parent it doesn't own), so it finds it the same way a human eye would:
// the first ancestor whose own overflow-y is auto/scroll. Returns null if
// none is found (e.g. this component rendered outside that chrome, as in
// tests) -- callers treat that as "nothing to restore/track," never a crash.
function nearestScrollAncestor(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export default function BillingPanel({
  timezone,
  canMutateOperationalData,
  workspaceId,
  userId,
  focusAppointmentId,
  focusServiceDate,
  onBillingSaved,
}: {
  timezone: string;
  // Read-only (locked/canceled/read-only-grace workspace) disables every
  // inline edit control below, matching how every other owner-mutation
  // surface in this dashboard already gates on this exact prop.
  canMutateOperationalData: boolean;
  // UI-only scoping for the sort-order preference below -- same values
  // DashboardShell already threads to useDashboardLayoutPrefs, forwarded
  // here via DashboardSettingsArea -> SettingsPanel. Never sent to any
  // server route and never used for data access.
  workspaceId: string;
  userId: string;
  // Deep-link target from the Needs Attention control (DashboardShell):
  // when both are set, the initial date range is seeded around
  // focusServiceDate instead of "this week," so a job from another week is
  // actually visible rather than silently excluded by the default range --
  // and the matching row is highlighted/scrolled into view once loaded.
  // Read only at mount (via the lazy useState initializers below) --
  // BillingPanel remounts fresh every time Settings -> Billing is entered
  // (see SettingsPanel.tsx's own conditional render), so this never fights
  // the owner's own subsequent range edits.
  focusAppointmentId?: string | null;
  // Explicitly selecting a target job may temporarily navigate to its own
  // date range (and clear the status filter/client search, below) so that
  // row is actually visible -- but this is a ONE-TIME seed, never written
  // back as the owner's saved preference (see isDeepLinkRef and the
  // persistence effect below): leaving this job and returning to ordinary
  // Billing restores whatever custom range/filter/search the owner had
  // saved before the deep link, unchanged.
  focusServiceDate?: string | null;
  // Needs Attention: called after a billing field save actually succeeds
  // (invoice number entered, paid/payment method changed) -- lets
  // DashboardShell bump its own needsAttentionRefreshToken so the sidebar
  // control's issue labels/counts catch up without a full-page reload.
  // Optional: every other BillingPanel render path (tests, any future
  // caller that doesn't need this) is unaffected by its absence.
  onBillingSaved?: () => void;
}) {
  // Captured once, at mount, same convention as every other "read only at
  // mount" prop here (see focusServiceDate's own doc comment) -- a later
  // change to focusServiceDate while already mounted is not a thing this
  // component's own lifecycle produces (DashboardShell only ever sets it
  // before switching centerMode to "settings", never after).
  const isDeepLinkRef = useRef(!!focusServiceDate);

  // Read once per mount, never re-read after that (storedPrefsRef's lazy
  // init below). Safe to read localStorage synchronously here, UNLIKE most
  // other reads in this app (see useDashboardLayoutPrefs.ts's "never read
  // during the initial render, SSR has no window" rule): BillingPanel only
  // ever mounts client-side, after DashboardShell's own navigation-
  // preference hydration has already resolved centerMode/settingsSection to
  // "settings"/"billing" -- it is never part of the server-rendered output
  // or the very first client paint, so there is no pre-hydration window in
  // which this read could create a mismatch. A post-mount-effect read
  // instead (the pattern this component's own sort-order preference used
  // before this fix) would cause a visible flash of "this week" before
  // snapping to the saved range on every remount, which is exactly what
  // "a custom date range must remain selected... refreshing" rules out --
  // do not "fix" this back into an effect.
  const storedPrefsRef = useRef<BillingPrefs | null>(null);
  if (storedPrefsRef.current === null) {
    storedPrefsRef.current = readStoredBillingPrefs(userId, workspaceId, timezone);
  }
  const stored = storedPrefsRef.current;

  const [rangeStart, setRangeStart] = useState(() =>
    focusServiceDate ? toDateInputValue(mondayOfWeekContaining(focusServiceDate)) : stored.rangeStart
  );
  const [rangeEnd, setRangeEnd] = useState(() =>
    focusServiceDate ? toDateInputValue(addDays(mondayOfWeekContaining(focusServiceDate), 6)) : stored.rangeEnd
  );
  // A deep link resets the status filter and client search to their
  // defaults (never reads the saved ones) -- the owner's own saved filter
  // could otherwise hide the exact job they were just sent here to review
  // (e.g. a saved "Paid" filter would hide a newly-flagged missing-invoice
  // job). Sort order is purely cosmetic (never hides a row), so it still
  // reads from storage even on a deep link.
  const [statusFilter, setStatusFilter] = useState<BillingStatusFilter>(() =>
    isDeepLinkRef.current ? DEFAULT_BILLING_STATUS_FILTER : stored.statusFilter
  );
  const [clientSearch, setClientSearch] = useState(() => (isDeepLinkRef.current ? "" : stored.clientSearch));
  const [sortOrder, setSortOrderState] = useState<BillingSortOrder>(stored.sortOrder);
  const [data, setData] = useState<FetchState>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});

  // Persists range/filter/sort/search together, so every one of them
  // survives a save, a remount, or a refresh -- see BillingPrefs' own doc
  // comment. Skips exactly its first run when this mount was a deep link
  // (isDeepLinkRef), so the temporarily-seeded range/filter/search is shown
  // but never overwrites the owner's own saved preferences; any LATER
  // owner-driven change (This Week/Last Week, editing a date field,
  // changing a filter) persists normally from then on, same as an ordinary
  // (non-deep-link) mount persists from its very first render.
  const firstPersistRunRef = useRef(true);
  const scrollTopRef = useRef(stored.scrollTop);
  useEffect(() => {
    if (firstPersistRunRef.current) {
      firstPersistRunRef.current = false;
      if (isDeepLinkRef.current) return;
    }
    writeStoredBillingPrefs(userId, workspaceId, {
      rangeStart,
      rangeEnd,
      statusFilter,
      sortOrder,
      clientSearch,
      scrollTop: scrollTopRef.current,
    });
  }, [userId, workspaceId, rangeStart, rangeEnd, statusFilter, sortOrder, clientSearch]);

  // Tracks (but does not persist on every tick -- see scrollTopRef's own
  // use in the effect above and writeStoredScrollTop's doc comment) the
  // Settings scroll container's current position, and restores the saved
  // one exactly once, clamped, right after this mount's first successful
  // load -- "restore only after data/layout is ready; clamp it when
  // results are shorter." nearestScrollAncestor finds that container
  // without needing a ref from DashboardSettingsArea, which owns it.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollAncestorRef = useRef<HTMLElement | null>(null);
  const restoredScrollRef = useRef(false);

  useEffect(() => {
    const el = nearestScrollAncestor(rootRef.current);
    scrollAncestorRef.current = el;
    if (!el) return;
    function onScroll() {
      scrollTopRef.current = el!.scrollTop;
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // Flush on unmount (leaving Settings -> Billing) -- the write-effect
      // above only fires when a tracked field CHANGES, so without this the
      // very last scroll position before navigating away could otherwise
      // never make it to storage. Re-reads storage itself rather than
      // reconstructing the full prefs object from this closure's (by-then
      // possibly stale) values -- see writeStoredScrollTop's own comment.
      writeStoredScrollTop(userId, workspaceId, scrollTopRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading || restoredScrollRef.current) return;
    restoredScrollRef.current = true;
    const el = scrollAncestorRef.current;
    if (!el) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(stored.scrollTop, maxScrollTop);
  }, [loading]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/billing/completed-jobs?start=${rangeStart}&end=${rangeEnd}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
        return body as { completed: CompletedJobRow[]; reviewNeeded: ReviewNeededRow[] };
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setLoadError(e.message || "Failed to load the billing report");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rangeStart, rangeEnd]);

  // Client-name search narrows the in-range completed list BEFORE the
  // status filter and summary totals are computed from it, so the table,
  // the summary cards, and the review-needed list all stay consistent with
  // whatever the owner typed -- see matchesClientSearch's own doc comment
  // for why this is scoped to the selected date range, not all history.
  const searchedCompleted = useMemo(
    () => (data?.completed ?? []).filter((r) => matchesClientSearch(r.clientName, clientSearch)),
    [data, clientSearch]
  );
  const searchedReviewNeeded = useMemo(
    () => (data?.reviewNeeded ?? []).filter((r) => matchesClientSearch(r.clientName, clientSearch)),
    [data, clientSearch]
  );
  const filteredRows = useMemo(
    () => applyBillingStatusFilter(searchedCompleted, statusFilter),
    [searchedCompleted, statusFilter]
  );
  // Sort is applied LAST, over the full date-range + search + status
  // matched set -- i.e. every row that will actually be shown, not a
  // subset -- so there is nothing left to reorder after this (there is no
  // further server-side pagination of this list; see
  // app/api/billing/completed-jobs/route.ts's own doc comment on why it
  // returns the whole date-range result at once). A pure display-order
  // change only: it never touches searchedCompleted, so the summary totals
  // below are completely unaffected by which direction is selected.
  const sortedRows = useMemo(() => sortCompletedJobRows(filteredRows, sortOrder), [filteredRows, sortOrder]);
  // Totals always reflect the FULL in-range (and now in-search) completed
  // list, never the status-filtered subset -- see computeBillingSummary's
  // own doc comment.
  const summary = useMemo(() => computeBillingSummary(searchedCompleted), [searchedCompleted]);

  function selectThisWeek() {
    const monday = mondayOfWeek(0, timezone);
    setRangeStart(toDateInputValue(monday));
    setRangeEnd(toDateInputValue(addDays(monday, 6)));
  }
  function selectLastWeek() {
    const monday = mondayOfWeek(-1, timezone);
    setRangeStart(toDateInputValue(monday));
    setRangeEnd(toDateInputValue(addDays(monday, 6)));
  }

  async function saveBillingFields(appointmentId: string, patch: Record<string, unknown>) {
    setRowErrors((prev) => ({ ...prev, [appointmentId]: "" }));
    setSavingRows((prev) => ({ ...prev, [appointmentId]: true }));
    try {
      const res = await fetch("/api/billing/completed-jobs/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: appointmentId, ...patch }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowErrors((prev) => ({ ...prev, [appointmentId]: body?.error || `Save failed (${res.status})` }));
        return;
      }
      // Migration 033's upsert_completed_job_billing may have just
      // synchronized paid/payment_method onto every OTHER row sharing this
      // invoice group, but the PATCH response only carries the one row it
      // wrote -- applyGroupedBillingUpdate mirrors that same sync onto this
      // panel's own already-loaded rows so every visible sibling (and the
      // summary cards derived from them, via the existing useMemo below)
      // updates immediately, with no refetch. See its own doc comment
      // (lib/completedJobBilling.ts) for the production bug this fixes.
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          completed: applyGroupedBillingUpdate(prev.completed, body.billing),
        };
      });
      onBillingSaved?.();
    } catch {
      setRowErrors((prev) => ({ ...prev, [appointmentId]: "Could not save — please try again." }));
    } finally {
      setSavingRows((prev) => ({ ...prev, [appointmentId]: false }));
    }
  }

  return (
    // Settings -> Billing: rendered inside DashboardSettingsArea's own
    // scrollable content area (same as every other Settings section), which
    // already provides height/scroll -- this no longer needs its own
    // flex-1/min-h-0/overflow-auto (left over from when this was a
    // standalone centerMode rendered directly below TopBar). max-w-5xl
    // matches the width the 7-column table needs; every other Settings
    // section instead uses max-w-xl/max-w-4xl for narrower card content.
    <div className="max-w-5xl" ref={rootRef}>
      <div className="mb-3">
        <h1 className="text-lg font-semibold text-slate-900">Billing / Completed Jobs</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          Work straight down the list: confirm the job, create its invoice in QuickBooks, type the invoice number here, then mark it paid once confirmed.
        </p>
      </div>

      {/* Date range */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          onClick={selectThisWeek}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          This Week
        </button>
        <button
          onClick={selectLastWeek}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Last Week
        </button>
        <span className="text-slate-400">|</span>
        <DateField value={rangeStart} onChange={setRangeStart} label="Billing report start date" />
        <span className="text-slate-400">&#8594;</span>
        <DateField value={rangeEnd} onChange={setRangeEnd} label="Billing report end date" />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <span className="whitespace-nowrap">Sort:</span>
            <select
              value={sortOrder}
              onChange={(e) => setSortOrderState(e.target.value as BillingSortOrder)}
              aria-label="Sort by service date"
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {BILLING_SORT_ORDERS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BillingStatusFilter)}
            aria-label="Filter by billing status"
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {BILLING_STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Client-name search -- scoped to the date range selected above, see
          matchesClientSearch's own doc comment. Live-filters as the owner
          types; no submit button. */}
      <div className="mb-3">
        <input
          type="text"
          value={clientSearch}
          onChange={(e) => setClientSearch(e.target.value)}
          placeholder="Search client name"
          aria-label="Search client name"
          className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <SummaryStat label="Completed Jobs" value={String(summary.completedJobs)} />
        <SummaryStat label="Completed Work $" value={formatCents(summary.completedWorkCents)} />
        <SummaryStat label="Invoiced $" value={formatCents(summary.invoicedCents)} />
        <SummaryStat label="Unpaid $" value={formatCents(summary.unpaidCents)} />
      </div>

      {loadError && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{loadError}</div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400">Loading...</div>
      ) : (
        <>
          <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Service Date</th>
                  <th className="px-3 py-2">Client</th>
                  <th className="px-3 py-2">Service</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Invoice #</th>
                  <th className="px-3 py-2">Paid</th>
                  <th className="px-3 py-2">Payment Method</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                      {clientSearch.trim()
                        ? "No completed jobs found for this client in the selected date range."
                        : "No completed jobs match this range/filter."}
                    </td>
                  </tr>
                ) : (
                  sortedRows.map((row) => (
                    <BillingRow
                      key={row.appointmentId}
                      row={row}
                      disabled={!canMutateOperationalData}
                      saving={!!savingRows[row.appointmentId]}
                      error={rowErrors[row.appointmentId]}
                      onSave={(patch) => saveBillingFields(row.appointmentId, patch)}
                      isFocused={!!focusAppointmentId && row.appointmentId === focusAppointmentId}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {searchedReviewNeeded.length > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="text-xs font-semibold text-amber-800">Past jobs needing completion review</div>
              <p className="text-[11px] text-amber-700 mt-0.5 mb-2">
                These appointments are in the past and not cancelled, but Job Tracking was never completed for them -- they
                are not included in Completed Jobs or any total above until that&rsquo;s resolved.
              </p>
              <ul className="space-y-1">
                {searchedReviewNeeded.map((r) => (
                  <li key={r.appointmentId} className="text-[11px] text-amber-800 flex gap-2">
                    <span className="font-medium">{formatMMDDYY(r.serviceDate)}</span>
                    <span>{r.clientName}</span>
                    <span className="text-amber-600">&middot;</span>
                    <span>{r.serviceType}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// A MM/DD/YY-displaying date picker that still IS a native
// <input type="date"> underneath -- calendar popup, keyboard entry, and
// screen-reader date-field semantics are all the real browser
// implementation, never reimplemented here. Native date inputs render
// their VISIBLE text in whatever format the browser/OS locale dictates
// (there is no cross-browser way to make the input's own text read
// "MM/DD/YY" -- see this file's own investigation note), so the real
// input is kept but visually invisible (opacity-0, stacked on top via the
// relative/absolute pairing below) while a decorative span underneath
// shows the MM/DD/YY text the owner actually sees. The decorative span is
// pointer-events-none AND (being a non-positioned flex item under a
// position:absolute, z-10 sibling) already painted BELOW the real input in
// stacking order, so it was never actually the thing swallowing clicks.
//
// Real root cause of "clicking directly on the digits doesn't open the
// picker, but clicking beside them does": a native <input type="date">
// only OPENS the calendar dropdown when the click lands on the browser's
// own built-in calendar-icon affordance (::-webkit-calendar-picker-indicator)
// -- by default a small ~20px hotspot pinned to the input's right edge.
// Clicking anywhere else inside the input (e.g. over a date segment) just
// moves keyboard focus/selection into that segment; it never opens the
// dropdown. Because the real input is invisible (opacity-0), the owner has
// no way to see where that small native hotspot actually is, and it
// usually does NOT line up with where the decorative MM/DD/YY text sits.
// The fix expands that same pseudo-element to cover the ENTIRE input
// (inset-0/w-full/h-full) so every point inside the box -- including
// directly over the visible digits -- is the native "open calendar"
// hotspot, not just a sliver of it. This is Chromium/WebKit-specific
// (Firefox has no equivalent pseudo-element to target); Firefox's own
// native date-input affordance already spans more of the box by default,
// so this is a progressive enhancement, not a regression there.
function DateField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <span className="relative inline-flex">
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-pointer [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 whitespace-nowrap"
      >
        {formatMMDDYY(value)}
      </span>
    </span>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-base font-semibold text-slate-900 mt-0.5">{value}</div>
    </div>
  );
}

function BillingRow({
  row,
  disabled,
  saving,
  error,
  onSave,
  isFocused,
}: {
  row: CompletedJobRow;
  disabled: boolean;
  saving: boolean;
  error?: string;
  onSave: (patch: Record<string, unknown>) => void;
  // Needs Attention deep-link target (see BillingPanel's own focusAppointmentId
  // prop): scrolls this row into view once mounted/visible and applies a
  // brief visual highlight, so "open the corresponding job in Billing"
  // actually shows the owner WHICH row, not just the right date range.
  isFocused?: boolean;
}) {
  // Local draft state for the text input (can't be purely derived from
  // props on every render, or it would reset mid-typing). Resynced when the
  // SERVER value changes out from under this row (e.g. a background
  // date-range refetch returns an updated billing row for the same still-
  // mounted appointment) -- via the React-recommended "adjust state during
  // render" pattern (a conditional setState call in the render body, not
  // inside a useEffect) rather than an effect, which would cause an extra
  // render-then-reconcile pass for no benefit here.
  const serverInvoiceNumber = row.billing?.invoice_number ?? "";
  const [invoiceDraft, setInvoiceDraft] = useState(serverInvoiceNumber);
  const [lastSyncedInvoiceNumber, setLastSyncedInvoiceNumber] = useState(serverInvoiceNumber);
  if (serverInvoiceNumber !== lastSyncedInvoiceNumber) {
    setLastSyncedInvoiceNumber(serverInvoiceNumber);
    setInvoiceDraft(serverInvoiceNumber);
  }

  const paid = row.billing?.paid ?? false;
  const paymentMethod = row.billing?.payment_method ?? "";

  const rowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    if (isFocused && typeof rowRef.current?.scrollIntoView === "function") {
      rowRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // Only on mount of a row that's already the focus target -- a row
    // never becomes focused after the fact in this panel's own lifecycle
    // (focusAppointmentId is read once, at BillingPanel's mount), so this
    // never needs to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function commitInvoiceNumber() {
    if (invoiceDraft === (row.billing?.invoice_number ?? "")) return;
    onSave({ invoice_number: invoiceDraft });
  }

  return (
    <tr
      ref={rowRef}
      className={[
        "border-b border-slate-100 last:border-b-0 align-top",
        isFocused ? "bg-amber-50 ring-1 ring-inset ring-amber-300" : "",
      ].join(" ")}
    >
      <td className="px-3 py-2 whitespace-nowrap text-slate-700">{formatMMDDYY(row.serviceDate)}</td>
      <td className="px-3 py-2 text-slate-900 font-medium">{row.clientName}</td>
      <td className="px-3 py-2 text-slate-700">{row.serviceType}</td>
      <td className="px-3 py-2 text-right text-slate-900">{formatCents(row.priceCents)}</td>
      <td className="px-3 py-2">
        <input
          type="text"
          value={invoiceDraft}
          disabled={disabled}
          placeholder="—"
          onChange={(e) => setInvoiceDraft(e.target.value)}
          onBlur={commitInvoiceNumber}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={paid}
          disabled={disabled}
          onChange={(e) => onSave({ paid: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300"
        />
      </td>
      <td className="px-3 py-2 relative">
        <select
          value={paymentMethod}
          disabled={disabled}
          onChange={(e) => onSave({ payment_method: e.target.value || null })}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
        >
          <option value="">&mdash;</option>
          {PAYMENT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        {/* Absolutely positioned (relative to the <td> above) so this status
            text never participates in the row's own flow height -- it used
            to sit inline next to the select and, at narrow viewports, wrap
            onto a second line, growing the row and (via the Settings scroll
            container's overflow threshold) briefly shifting the whole screen
            left/right during every save. See DashboardSettingsArea.tsx's
            scrollbarGutter fix for the primary fix; this is defense in depth
            for browsers without scrollbar-gutter support. */}
        {saving && <span className="absolute left-3 top-full mt-0.5 text-[10px] text-slate-400 whitespace-nowrap">Saving...</span>}
        {error && <div className="absolute left-3 top-full mt-0.5 text-[10px] text-rose-600 whitespace-nowrap">{error}</div>}
      </td>
    </tr>
  );
}
