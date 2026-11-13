"use client";

// Appointment Details -> Invoice (migration 049). Answers one question for a
// past job: "how is this job billed?" -- and offers the three ways to settle
// it: Create Invoice, Link Existing Invoice (a QuickBooks number), or Paid
// directly, no invoice. Uses the same completed-job rule as Billing
// (owner worked-time corrections count) -- decided by the server.
import { useCallback, useEffect, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import { formatMMDDYY } from "@/lib/dateDisplay";
import { PAYMENT_METHODS } from "@/lib/completedJobBilling";
import type { InvoiceView } from "@/lib/invoices";
import InvoiceDialog from "@/app/components/dashboard/invoices/InvoiceDialog";

type JobBilling = { invoice_number: string | null; paid: boolean; payment_method: string | null; no_invoice_required: boolean } | null;
type JobState = { completed: boolean; billing: JobBilling; invoice: InvoiceView | null; voided: InvoiceView[] };

const methodLabel = (m: string | null) => PAYMENT_METHODS.find((p) => p.value === m)?.label ?? "another method";
const newRequestId = () => crypto.randomUUID();

const btnPrimary = "rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const btnSecondary = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";
const link = "text-xs font-medium text-blue-600 hover:text-blue-700 disabled:text-slate-400";

export default function InvoiceCard({
  appointmentId,
  canMutate,
  onChanged,
}: {
  appointmentId: string;
  canMutate: boolean;
  // Billing / Needs Attention may have changed (DashboardShell refreshes).
  onChanged?: () => void;
}) {
  const [state, setState] = useState<JobState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [mode, setMode] = useState<"" | "link" | "direct">("");
  const [linkNumber, setLinkNumber] = useState("");
  const [method, setMethod] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const createRequestId = useRef(newRequestId());

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch(`/api/invoices?appointment_id=${encodeURIComponent(appointmentId)}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Could not load billing (${res.status})`);
      setState(body as JobState);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [appointmentId]);

  useEffect(() => {
    setState(null);
    setMode("");
    setError("");
    load();
  }, [load]);

  function changed() {
    load();
    onChanged?.();
  }

  async function run(fn: () => Promise<Response>, after?: (body: Record<string, unknown>) => void) {
    setBusy(true);
    setError("");
    try {
      const res = await fn();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body as { error?: string })?.error || `Could not save (${res.status})`);
        if (res.status === 409) load();
        return;
      }
      after?.(body);
      setMode("");
      changed();
    } catch {
      setError("Could not save — please try again.");
    } finally {
      setBusy(false);
    }
  }

  const post = (url: string, body: unknown, method = "POST") =>
    fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  function createInvoice() {
    run(
      () => post("/api/invoices", { appointment_id: appointmentId, request_id: createRequestId.current }),
      (body) => {
        createRequestId.current = newRequestId();
        setOpenInvoiceId((body.invoice as InvoiceView).id);
      }
    );
  }

  const disabled = !canMutate || busy;
  const billing = state?.billing ?? null;
  const invoice = state?.invoice ?? null;

  let content: React.ReactNode = null;
  if (loadError) {
    content = <div className="text-xs text-rose-700">{loadError}</div>;
  } else if (!state) {
    content = <div className="text-xs text-slate-400">Loading...</div>;
  } else if (invoice?.status === "issued") {
    content = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-700">
          <span className="font-semibold text-slate-900">{invoice.invoice_number}</span>
          {" "}&middot; Dated {formatMMDDYY(invoice.invoice_date)} &middot; {formatCents(invoice.total_cents)} &middot;{" "}
          <span className={billing?.paid ? "text-emerald-700" : "text-amber-700"}>{billing?.paid ? "Paid" : "Unpaid"}</span>
        </div>
        <div className="flex gap-2">
          <button type="button" className={btnSecondary} onClick={() => setOpenInvoiceId(invoice.id)}>Open</button>
          <a className={btnPrimary} href={`/api/invoices/${invoice.id}/pdf`}>Download PDF</a>
        </div>
      </div>
    );
  } else if (invoice?.status === "draft") {
    content = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-700">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Draft</span> {formatCents(invoice.total_cents)} &middot; not issued yet
        </div>
        <button type="button" className={btnPrimary} onClick={() => setOpenInvoiceId(invoice.id)}>Continue draft</button>
      </div>
    );
  } else if (billing?.invoice_number) {
    content = (
      <div className="text-xs text-slate-700">
        QuickBooks invoice <span className="font-semibold text-slate-900">#{billing.invoice_number}</span>
        <span className={billing.paid ? " text-emerald-700" : " text-amber-700"}> &middot; {billing.paid ? "Paid" : "Unpaid"}</span>
        <div className="mt-0.5 text-[11px] text-slate-400">Change the number or payment in Billing.</div>
      </div>
    );
  } else if (billing?.no_invoice_required) {
    content = (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-700">Paid directly by {methodLabel(billing.payment_method)} &middot; No invoice needed</div>
        <button type="button" className={link} disabled={disabled} onClick={() => run(() => post("/api/billing/completed-jobs/direct-payment", { appointment_id: appointmentId, no_invoice_required: false }))}>
          Undo
        </button>
      </div>
    );
  } else if (!state.completed) {
    content = <div className="text-xs text-slate-500">Resolve worked time before invoicing this job.</div>;
  } else if (mode === "link") {
    content = (
      <div className="space-y-2">
        <label className="block text-[11px] font-medium text-slate-500" htmlFor="link-invoice-number">QuickBooks invoice number</label>
        <div className="flex gap-2">
          <input id="link-invoice-number" autoFocus value={linkNumber} onChange={(e) => setLinkNumber(e.target.value)} disabled={busy}
            className="w-36 rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button type="button" className={btnPrimary} disabled={disabled || !linkNumber.trim()}
            onClick={() => run(() => post("/api/billing/completed-jobs/update", { appointment_id: appointmentId, invoice_number: linkNumber }, "PATCH"))}>
            Link
          </button>
          <button type="button" className="text-xs text-slate-500" onClick={() => setMode("")}>Cancel</button>
        </div>
      </div>
    );
  } else if (mode === "direct") {
    content = (
      <div className="space-y-2">
        <label className="block text-[11px] font-medium text-slate-500" htmlFor="direct-method">How did the client pay?</label>
        <div className="flex flex-wrap gap-2">
          <select id="direct-method" value={method} onChange={(e) => setMethod(e.target.value)} disabled={busy}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">Choose...</option>
            {PAYMENT_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button type="button" className={btnPrimary} disabled={disabled || !method}
            onClick={() => run(() => post("/api/billing/completed-jobs/direct-payment", { appointment_id: appointmentId, no_invoice_required: true, payment_method: method }))}>
            Mark paid, no invoice
          </button>
          <button type="button" className="text-xs text-slate-500" onClick={() => setMode("")}>Cancel</button>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimary} disabled={disabled} onClick={createInvoice}>{busy ? "Creating..." : "Create Invoice"}</button>
          <button type="button" className={btnSecondary} disabled={disabled} onClick={() => { setLinkNumber(""); setMode("link"); }}>Link Existing Invoice</button>
        </div>
        <button type="button" className={link} disabled={disabled}
          onClick={() => { setMethod(billing?.payment_method ?? ""); setMode("direct"); }}>
          Paid directly, no invoice
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2" data-testid="invoice-card">
      <div className="mb-1.5 text-xs font-medium text-slate-600">Invoice</div>
      {content}
      {error && <div className="mt-2 text-[11px] text-rose-600" role="alert">{error}</div>}
      {state && state.voided.length > 0 && (
        <div className="mt-2 border-t border-slate-100 pt-1.5 space-y-0.5">
          {state.voided.map((v) => (
            <div key={v.id} className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Void: {v.invoice_number} &middot; {formatCents(v.total_cents)} &middot; {v.void_reason}</span>
              <button type="button" className="text-[11px] text-blue-600 hover:text-blue-700" onClick={() => setOpenInvoiceId(v.id)}>View</button>
            </div>
          ))}
        </div>
      )}
      {openInvoiceId && (
        <InvoiceDialog
          invoiceId={openInvoiceId}
          canMutate={canMutate}
          onClose={() => setOpenInvoiceId(null)}
          onChanged={changed}
        />
      )}
    </div>
  );
}
