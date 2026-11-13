"use client";

import { useEffect, useState } from "react";
import { parseStartingNumber, type InvoiceNumberingState } from "@/lib/invoices";

// Settings -> Billing / Completed Jobs, top: which number the next issued
// invoice gets, and the owner's "Starting invoice number" (to continue
// QuickBooks numbering) while it can still change -- until the first
// invoice is issued.
type Props = {
  canMutate: boolean;
  refreshKey?: number; // bump to refetch (e.g. after an invoice is issued from Billing)
};

const inputCls =
  "w-32 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50";

export default function InvoiceNumbersCard({ canMutate, refreshKey = 0 }: Props) {
  const [state, setState] = useState<InvoiceNumberingState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/invoices/numbering")
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `Could not load invoice numbers (${res.status})`);
        if (!cancelled) {
          setState(body.numbering as InvoiceNumberingState);
          setLoadError("");
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function save(startingNumber: number | null) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/invoices/numbering", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starting_number: startingNumber }),
      });
      const body = await res.json().catch(() => ({}));
      if (body?.numbering) setState(body.numbering as InvoiceNumberingState);
      if (!res.ok) {
        setError(body?.error || "Could not save the starting number. Please try again.");
        return;
      }
      setEditing(false);
    } catch {
      setError("Could not save the starting number. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function submit() {
    const parsed = parseStartingNumber(value);
    if (!parsed.ok) return setError(parsed.error);
    if (parsed.value === null) return setError("Enter a starting number, like 13485.");
    void save(parsed.value);
  }

  if (loadError) {
    return <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{loadError}</div>;
  }
  if (!state) return null;

  const canChange = canMutate && !state.locked;
  const highest = state.highest_recorded;

  return (
    <section data-testid="invoice-numbers" aria-label="Invoice numbers" className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Invoice numbers</h2>
          <div className="mt-1 text-xs text-slate-600">
            Next available invoice number{" "}
            <span className="font-semibold text-slate-900" data-testid="next-available-number">{state.next_available ?? "—"}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-slate-400">The final number is assigned when an invoice is issued.</p>
          {state.locked && (
            <p className="mt-1 text-[11px] text-slate-500">
              {state.series === "custom" ? "Continuing your own invoice numbers." : "Using the SFT invoice series."} Set when the first invoice was issued.
            </p>
          )}
        </div>
        {canChange && !editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setError("");
              setValue(state.starting_number !== null ? String(state.starting_number) : "");
            }}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {state.series === "custom" ? "Change starting number" : "Set starting number"}
          </button>
        )}
      </div>

      {canChange && editing && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            Before you set it, check QuickBooks for the last invoice number you actually issued. Billing may not include every QuickBooks invoice.
          </p>
          {highest && (
            <p className="text-[11px] text-slate-600" data-testid="highest-recorded">
              Highest invoice number recorded in Billing: <span className="font-semibold text-slate-900">{highest.number}</span>
              {highest.client_name ? ` (${highest.client_name})` : ""}. Your starting number must be higher.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="inv-starting-number" className="mb-0.5 block text-[11px] font-medium text-slate-500">Starting invoice number</label>
              <input
                id="inv-starting-number"
                inputMode="numeric"
                placeholder={highest ? String(Number(highest.value) + 1) : "13485"}
                className={inputCls}
                value={value}
                disabled={saving}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </div>
            <button type="button" onClick={submit} disabled={saving} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {saving ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={() => { setEditing(false); setError(""); }} disabled={saving} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            {state.series === "custom" && (
              <button type="button" onClick={() => void save(null)} disabled={saving} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">
                Use SFT-1001 instead
              </button>
            )}
          </div>
          <p className="text-[11px] text-slate-400">Invoices then continue from this number without the SFT prefix. You can change it until the first invoice is issued.</p>
          {error && <p className="text-xs text-rose-700" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
