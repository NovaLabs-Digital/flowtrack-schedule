"use client";

import { useEffect, useMemo, useState } from "react";
import { nowInBusinessTz } from "@/lib/timezone";
import { formatCents } from "@/lib/money";
import {
  PAYMENT_METHODS,
  BILLING_STATUS_FILTERS,
  applyBillingStatusFilter,
  computeBillingSummary,
  type BillingStatusFilter,
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
function toDateInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// DISPLAY FORMATTING ONLY -- this never touches storage, API query
// parameters, date-range math, or timezone resolution; it only changes
// what the owner SEES. Input is always the existing canonical
// "YYYY-MM-DD" workspace-local calendar-date string (the same value
// already used for fetch query params, <input type="date"> values, and
// isInDateRange's own range math) -- never re-parsed through `new Date()`
// (which would reinterpret it in the browser's own local timezone and
// risks shifting the displayed day). Plain substring rearrangement only,
// so it can never disagree with the date that was actually fetched/saved.
// "YY" is the last two digits of the year (26 for 2026), per the approved
// DD/MM/YY spec -- never a 4-digit year.
function formatDDMMYY(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate; // defensive: never throw on an unexpected shape
  return `${d}/${m}/${y.slice(-2)}`;
}

type FetchState = { completed: CompletedJobRow[]; reviewNeeded: ReviewNeededRow[] } | null;

export default function BillingPanel({
  timezone,
  canMutateOperationalData,
}: {
  timezone: string;
  // Read-only (locked/canceled/read-only-grace workspace) disables every
  // inline edit control below, matching how every other owner-mutation
  // surface in this dashboard already gates on this exact prop.
  canMutateOperationalData: boolean;
}) {
  const [rangeStart, setRangeStart] = useState(() => toDateInputValue(mondayOfWeek(0, timezone)));
  const [rangeEnd, setRangeEnd] = useState(() => toDateInputValue(addDays(mondayOfWeek(0, timezone), 6)));
  const [statusFilter, setStatusFilter] = useState<BillingStatusFilter>("all");
  const [data, setData] = useState<FetchState>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savingRows, setSavingRows] = useState<Record<string, boolean>>({});

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

  const filteredRows = useMemo(
    () => applyBillingStatusFilter(data?.completed ?? [], statusFilter),
    [data, statusFilter]
  );
  // Totals always reflect the FULL in-range completed list, never the
  // status-filtered subset -- see computeBillingSummary's own doc comment.
  const summary = useMemo(() => computeBillingSummary(data?.completed ?? []), [data]);

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
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          completed: prev.completed.map((r) => (r.appointmentId === appointmentId ? { ...r, billing: body.billing } : r)),
        };
      });
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
    <div className="max-w-5xl">
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

        <div className="ml-auto">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BillingStatusFilter)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {BILLING_STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
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
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-400">
                      No completed jobs match this range/filter.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => (
                    <BillingRow
                      key={row.appointmentId}
                      row={row}
                      disabled={!canMutateOperationalData}
                      saving={!!savingRows[row.appointmentId]}
                      error={rowErrors[row.appointmentId]}
                      onSave={(patch) => saveBillingFields(row.appointmentId, patch)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          {(data?.reviewNeeded?.length ?? 0) > 0 && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <div className="text-xs font-semibold text-amber-800">Past jobs needing completion review</div>
              <p className="text-[11px] text-amber-700 mt-0.5 mb-2">
                These appointments are in the past and not cancelled, but Job Tracking was never completed for them -- they
                are not included in Completed Jobs or any total above until that&rsquo;s resolved.
              </p>
              <ul className="space-y-1">
                {data!.reviewNeeded.map((r) => (
                  <li key={r.appointmentId} className="text-[11px] text-amber-800 flex gap-2">
                    <span className="font-medium">{formatDDMMYY(r.serviceDate)}</span>
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

// A DD/MM/YY-displaying date picker that still IS a native
// <input type="date"> underneath -- calendar popup, keyboard entry, and
// screen-reader date-field semantics are all the real browser
// implementation, never reimplemented here. Native date inputs render
// their VISIBLE text in whatever format the browser/OS locale dictates
// (there is no cross-browser way to make the input's own text read
// "DD/MM/YY" -- see this file's own investigation note), so the real
// input is kept but visually invisible (opacity-0, stacked on top via the
// relative/absolute pairing below) while a decorative span underneath
// shows the DD/MM/YY text the owner actually sees. Clicking anywhere in
// the box hits the real (invisible) input on top, which opens the native
// picker exactly as before -- nothing about selection, keyboard access,
// or the underlying "YYYY-MM-DD" value changes. aria-hidden on the
// decorative span prevents a screen reader from announcing the date
// twice (once for the real input, once for the visible text).
function DateField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <span className="relative inline-flex">
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-pointer"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 whitespace-nowrap"
      >
        {formatDDMMYY(value)}
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
}: {
  row: CompletedJobRow;
  disabled: boolean;
  saving: boolean;
  error?: string;
  onSave: (patch: Record<string, unknown>) => void;
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

  function commitInvoiceNumber() {
    if (invoiceDraft === (row.billing?.invoice_number ?? "")) return;
    onSave({ invoice_number: invoiceDraft });
  }

  return (
    <tr className="border-b border-slate-100 last:border-b-0 align-top">
      <td className="px-3 py-2 whitespace-nowrap text-slate-700">{formatDDMMYY(row.serviceDate)}</td>
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
      <td className="px-3 py-2">
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
        {saving && <span className="ml-2 text-[10px] text-slate-400">Saving...</span>}
        {error && <div className="text-[10px] text-rose-600 mt-1">{error}</div>}
      </td>
    </tr>
  );
}
