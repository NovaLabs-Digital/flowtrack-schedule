"use client";

// One invoice, in one dialog (migration 049): a DRAFT opens as an editor
// laid out like the QuickBooks invoice editor (Bill to; Invoice no. / Terms /
// Invoice date / Due date; one Service Date / Product/service / Description
// / Qty / Rate / Amount line; Payment instructions; Note to client; totals).
// An ISSUED or VOID invoice opens as a preview of its stored PDF, with
// Download PDF and (issued only) Void & Reissue.
//
// Opened from Appointment Details' Invoice card and from Billing's Draft /
// invoice-number links -- the same component, so both places behave the same.
import { useEffect, useRef, useState } from "react";
import { centsToInputValue, formatCents, parsePriceToCents } from "@/lib/money";
import { formatMMDDYY } from "@/lib/dateDisplay";
import { INVOICE_TERMS, dueDateFor, lineAmountCents, parseTaxRate, taxCents, type InvoiceDraftFields, type InvoiceTerms, type InvoiceView } from "@/lib/invoices";

type Props = {
  invoiceId: string;
  canMutate: boolean;
  onClose: () => void;
  // Called after anything changed (saved, issued, discarded, voided,
  // reissued), so the opener can refresh Billing / the card / Needs Attention.
  onChanged: () => void;
};

type Form = {
  business_name: string; business_address: string; business_phone: string; business_email: string;
  bill_to_name: string; bill_to_address: string; bill_to_email: string;
  terms: InvoiceTerms; invoice_date: string; due_date: string;
  service_date: string; product_service: string; description: string;
  quantity: string; rate: string;
  // Sales tax: off by default; one rate per invoice when on.
  taxOn: boolean; taxRate: string;
  payment_instructions: string; note_to_client: string;
};

function toForm(inv: InvoiceView): Form {
  return {
    business_name: inv.business_name ?? "", business_address: inv.business_address ?? "",
    business_phone: inv.business_phone ?? "", business_email: inv.business_email ?? "",
    bill_to_name: inv.bill_to_name ?? "", bill_to_address: inv.bill_to_address ?? "", bill_to_email: inv.bill_to_email ?? "",
    terms: inv.terms, invoice_date: inv.invoice_date, due_date: inv.due_date,
    service_date: inv.service_date, product_service: inv.product_service ?? "", description: inv.description ?? "",
    quantity: String(Number(inv.quantity)), rate: centsToInputValue(inv.rate_cents),
    taxOn: inv.tax_rate !== null, taxRate: inv.tax_rate ?? "",
    payment_instructions: inv.payment_instructions ?? "", note_to_client: inv.note_to_client ?? "",
  };
}

function fromForm(f: Form): { ok: true; fields: InvoiceDraftFields } | { ok: false; error: string } {
  const quantity = Number(f.quantity);
  if (!f.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: "Qty must be a positive number." };
  const rate = parsePriceToCents(f.rate);
  if (rate === null) return { ok: false, error: "Rate must be a dollar amount, like 150 or 150.00." };
  let taxRate: string | null = null;
  if (f.taxOn) {
    if (!f.taxRate.trim()) return { ok: false, error: "Enter the sales tax rate, or turn sales tax off." };
    const parsed = parseTaxRate(f.taxRate);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    taxRate = parsed.rate;
  }
  return {
    ok: true,
    fields: {
      business_name: f.business_name, business_address: f.business_address || null,
      business_phone: f.business_phone || null, business_email: f.business_email || null,
      bill_to_name: f.bill_to_name, bill_to_address: f.bill_to_address || null, bill_to_email: f.bill_to_email || null,
      terms: f.terms, invoice_date: f.invoice_date, due_date: f.due_date,
      service_date: f.service_date, product_service: f.product_service, description: f.description || null,
      quantity, rate_cents: rate, tax_rate: taxRate,
      payment_instructions: f.payment_instructions || null, note_to_client: f.note_to_client || null,
    },
  };
}

const newRequestId = () => crypto.randomUUID();

const inputCls =
  "w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50";
const labelCls = "block text-[11px] font-medium text-slate-500 mb-0.5";

export default function InvoiceDialog({ invoiceId, canMutate, onClose, onChanged }: Props) {
  const [currentId, setCurrentId] = useState(invoiceId);
  const [invoice, setInvoice] = useState<InvoiceView | null>(null);
  const [paid, setPaid] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "saving" | "issuing" | "discarding" | "voiding">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const reissueRequestId = useRef(newRequestId());

  function adopt(inv: InvoiceView) {
    setInvoice(inv);
    setForm(toForm(inv));
    setDirty(false);
  }

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    fetch(`/api/invoices/${currentId}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `Could not load the invoice (${res.status})`);
        if (cancelled) return;
        adopt(body.invoice as InvoiceView);
        setPaid(!!body.billing?.paid);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [key]: value };
      // Terms or invoice date move the due date, like QuickBooks.
      if ((key === "terms" || key === "invoice_date") && next.invoice_date) next.due_date = dueDateFor(next.invoice_date, next.terms);
      return next;
    });
    setDirty(true);
    setError("");
  }

  // Saves the draft; returns the saved invoice (or null when not saved).
  async function saveDraft(): Promise<InvoiceView | null> {
    if (!invoice || !form) return null;
    const parsed = fromForm(form);
    if (!parsed.ok) {
      setError(parsed.error);
      return null;
    }
    const res = await fetch(`/api/invoices/${invoice.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: invoice.revision, fields: parsed.fields }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      adopt(body.invoice);
      onChanged();
      return body.invoice as InvoiceView;
    }
    if (body?.code === "DRAFT_CHANGED" && body.invoice) {
      adopt(body.invoice);
      setNotice("This draft was changed somewhere else. Review the latest version below, then save or issue.");
      return null;
    }
    if (body?.code === "NOT_DRAFT" && body.invoice) {
      adopt(body.invoice);
      setNotice("This invoice was already issued.");
      return null;
    }
    setError(body?.error || `Could not save (${res.status})`);
    return null;
  }

  async function handleSave() {
    setBusy("saving");
    setNotice("");
    try {
      await saveDraft();
    } catch {
      setError("Could not save — please try again.");
    } finally {
      setBusy("");
    }
  }

  async function handleIssue() {
    if (!invoice) return;
    setBusy("issuing");
    setNotice("");
    try {
      let reviewed: InvoiceView | null = invoice;
      if (dirty) reviewed = await saveDraft();
      if (!reviewed) return;
      const res = await fetch(`/api/invoices/${reviewed.id}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: reviewed.revision }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        adopt(body.invoice);
        onChanged();
        return;
      }
      if (body?.code === "DRAFT_CHANGED" && body.invoice) {
        adopt(body.invoice);
        setNotice("This draft was changed before it was issued. Review the updated draft below, then issue it.");
        return;
      }
      setError(body?.error || `Could not issue (${res.status})`);
    } catch {
      setError("Could not issue — please try again.");
    } finally {
      setBusy("");
    }
  }

  async function handleDiscard() {
    if (!invoice) return;
    setBusy("discarding");
    try {
      const res = await fetch(`/api/invoices/${invoice.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Could not discard (${res.status})`);
        return;
      }
      onChanged();
      onClose();
    } catch {
      setError("Could not discard — please try again.");
    } finally {
      setBusy("");
    }
  }

  // Void & Reissue: void this invoice (kept forever, number retired), then
  // open a new draft copied from it for the correction.
  async function handleVoidAndReissue() {
    if (!invoice) return;
    if (!voidReason.trim()) {
      setError("Enter a reason for voiding this invoice.");
      return;
    }
    setBusy("voiding");
    setError("");
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Could not void (${res.status})`);
        return;
      }
      onChanged();
      const re = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: invoice.appointment_id, request_id: reissueRequestId.current, reissue_from_invoice_id: invoice.id }),
      });
      const reBody = await re.json().catch(() => ({}));
      if (!re.ok) {
        adopt(body.invoice);
        setVoidOpen(false);
        setError(`Invoice ${invoice.invoice_number} was voided, but the new draft could not be created: ${reBody?.error || re.status}`);
        return;
      }
      reissueRequestId.current = newRequestId();
      setVoidOpen(false);
      setVoidReason("");
      setNotice(`Invoice ${invoice.invoice_number} was voided and kept on record. This new draft copies it — correct it, then issue.`);
      setCurrentId(reBody.invoice.id);
      onChanged();
    } catch {
      setError("Could not void — please try again.");
    } finally {
      setBusy("");
    }
  }

  const isDraft = invoice?.status === "draft";
  const disabled = !canMutate || !!busy;
  const parsedQty = form ? Number(form.quantity) : NaN;
  const parsedRate = form ? parsePriceToCents(form.rate) : null;
  const amount = form && Number.isFinite(parsedQty) && parsedQty > 0 && parsedRate !== null ? lineAmountCents(parsedQty, parsedRate) : null;
  // Same integer rounding as the database (lib/invoices.ts taxCents).
  const parsedTax = form?.taxOn ? parseTaxRate(form.taxRate) : null;
  const tax = amount === null ? null : !form?.taxOn ? 0 : parsedTax?.ok && parsedTax.thousandths !== null ? taxCents(amount, parsedTax.thousandths) : null;
  const total = amount !== null && tax !== null ? amount + tax : null;
  const priceDiffers = !!invoice && invoice.job_price_cents !== null && amount !== null && amount !== invoice.job_price_cents;

  const title = !invoice ? "Invoice" : isDraft ? "Draft invoice" : `Invoice ${invoice.invoice_number}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-3xl rounded-2xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {invoice && invoice.status === "issued" && (
              <span className={["rounded-full px-2 py-0.5 text-[11px] font-medium", paid ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"].join(" ")}>
                {paid ? "Paid" : "Unpaid"}
              </span>
            )}
            {invoice?.status === "void" && <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">Void</span>}
          </div>
          <button type="button" onClick={onClose} disabled={!!busy} className="rounded-lg px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" aria-label="Close">
            &#10005;
          </button>
        </div>

        <div className="px-5 py-4">
          {loadError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{loadError}</div>}
          {!invoice && !loadError && <div className="text-sm text-slate-400">Loading...</div>}
          {notice && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</div>}

          {invoice && form && isDraft && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <div>
                    <label className={labelCls} htmlFor="inv-bill-to">Bill to</label>
                    <input id="inv-bill-to" className={inputCls} value={form.bill_to_name} disabled={disabled} onChange={(e) => set("bill_to_name", e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="inv-bill-address">Address</label>
                    <textarea id="inv-bill-address" rows={2} className={inputCls} value={form.bill_to_address} disabled={disabled} onChange={(e) => set("bill_to_address", e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="inv-bill-email">Email</label>
                    <input id="inv-bill-email" className={inputCls} value={form.bill_to_email} disabled={disabled} onChange={(e) => set("bill_to_email", e.target.value)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <div>
                    <span className={labelCls}>Invoice no.</span>
                    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-500">Assigned when you issue it</div>
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="inv-terms">Terms</label>
                    <select id="inv-terms" className={inputCls} value={form.terms} disabled={disabled} onChange={(e) => set("terms", e.target.value as InvoiceTerms)}>
                      {INVOICE_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={labelCls} htmlFor="inv-date">Invoice date</label>
                      <input id="inv-date" type="date" className={inputCls} value={form.invoice_date} disabled={disabled} onChange={(e) => set("invoice_date", e.target.value)} />
                    </div>
                    <div>
                      <label className={labelCls} htmlFor="inv-due">Due date</label>
                      <input id="inv-due" type="date" className={inputCls} value={form.due_date} disabled={disabled} onChange={(e) => set("due_date", e.target.value)} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="overflow-auto rounded-xl border border-slate-200">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="px-2 py-2">Service Date</th>
                      <th className="px-2 py-2">Product/service</th>
                      <th className="px-2 py-2">Description</th>
                      <th className="px-2 py-2 text-right">Qty</th>
                      <th className="px-2 py-2 text-right">Rate</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="align-top">
                      <td className="px-2 py-2 w-32"><input aria-label="Service date" type="date" className={inputCls} value={form.service_date} disabled={disabled} onChange={(e) => set("service_date", e.target.value)} /></td>
                      <td className="px-2 py-2 w-40"><input aria-label="Product/service" className={inputCls} value={form.product_service} disabled={disabled} onChange={(e) => set("product_service", e.target.value)} /></td>
                      <td className="px-2 py-2"><textarea aria-label="Description" rows={2} className={inputCls} value={form.description} disabled={disabled} onChange={(e) => set("description", e.target.value)} /></td>
                      <td className="px-2 py-2 w-16"><input aria-label="Qty" inputMode="decimal" className={`${inputCls} text-right`} value={form.quantity} disabled={disabled} onChange={(e) => set("quantity", e.target.value)} /></td>
                      <td className="px-2 py-2 w-24"><input aria-label="Rate" inputMode="decimal" className={`${inputCls} text-right`} value={form.rate} disabled={disabled} onChange={(e) => set("rate", e.target.value)} /></td>
                      <td className="px-2 py-2 w-24 text-right font-medium text-slate-900">{amount === null ? "—" : formatCents(amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <div>
                    <label className={labelCls} htmlFor="inv-pay">Payment instructions</label>
                    <textarea id="inv-pay" rows={2} placeholder="Tell your client how you want to get paid." className={inputCls} value={form.payment_instructions} disabled={disabled} onChange={(e) => set("payment_instructions", e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="inv-note">Note to client</label>
                    <textarea id="inv-note" rows={2} className={inputCls} value={form.note_to_client} disabled={disabled} onChange={(e) => set("note_to_client", e.target.value)} />
                  </div>
                </div>
                <div className="self-end space-y-1 text-xs">
                  <label className="flex items-center justify-end gap-2 text-slate-600">
                    <input type="checkbox" checked={form.taxOn} disabled={disabled} onChange={(e) => set("taxOn", e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" />
                    Charge sales tax
                  </label>
                  {form.taxOn && (
                    <div className="flex items-center justify-end gap-1.5 text-slate-600">
                      <label htmlFor="inv-tax-rate">Tax rate</label>
                      <input id="inv-tax-rate" inputMode="decimal" placeholder="6.5" className={`${inputCls} w-20 text-right`} value={form.taxRate} disabled={disabled} onChange={(e) => set("taxRate", e.target.value)} />
                      <span>%</span>
                    </div>
                  )}
                  <div className="flex justify-between text-slate-600"><span>Subtotal</span><span data-testid="invoice-subtotal">{amount === null ? "—" : formatCents(amount)}</span></div>
                  {form.taxOn && (
                    <div className="flex justify-between text-slate-600"><span>Tax</span><span data-testid="invoice-tax">{tax === null ? "—" : formatCents(tax)}</span></div>
                  )}
                  <div className="flex justify-between border-t border-slate-200 pt-1 text-sm font-semibold text-slate-900"><span>Invoice total</span><span data-testid="invoice-total">{total === null ? "—" : formatCents(total)}</span></div>
                  {priceDiffers && <div className="text-right text-[11px] text-slate-400">Job price {formatCents(invoice.job_price_cents)}</div>}
                </div>
              </div>

              <details className="rounded-xl border border-slate-200 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-slate-600">Your business on this invoice: {form.business_name || "—"}</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div><label className={labelCls} htmlFor="inv-biz">Business name</label><input id="inv-biz" className={inputCls} value={form.business_name} disabled={disabled} onChange={(e) => set("business_name", e.target.value)} /></div>
                  <div><label className={labelCls} htmlFor="inv-biz-phone">Phone</label><input id="inv-biz-phone" className={inputCls} value={form.business_phone} disabled={disabled} onChange={(e) => set("business_phone", e.target.value)} /></div>
                  <div><label className={labelCls} htmlFor="inv-biz-address">Address</label><textarea id="inv-biz-address" rows={2} className={inputCls} value={form.business_address} disabled={disabled} onChange={(e) => set("business_address", e.target.value)} /></div>
                  <div><label className={labelCls} htmlFor="inv-biz-email">Email</label><input id="inv-biz-email" className={inputCls} value={form.business_email} disabled={disabled} onChange={(e) => set("business_email", e.target.value)} /></div>
                </div>
              </details>
            </div>
          )}

          {invoice && !isDraft && (
            <div className="space-y-3">
              {invoice.status === "void" && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  Voided{invoice.voided_at ? ` ${new Date(invoice.voided_at).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" })}` : ""}: {invoice.void_reason}. This record and its number are kept; the number is never reused.
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                <span>Total <span className="font-semibold text-slate-900" data-testid="invoice-total">{formatCents(invoice.total_cents)}</span></span>
                {invoice.tax_rate !== null && <span data-testid="invoice-tax">incl. {invoice.tax_rate}% tax {formatCents(invoice.tax_cents)}</span>}
                <span>Dated {formatMMDDYY(invoice.invoice_date)}</span>
                <span>{invoice.bill_to_name}</span>
              </div>
              <iframe title={`Invoice ${invoice.invoice_number} preview`} src={`/api/invoices/${invoice.id}/pdf?inline=1`} className="h-[60vh] w-full rounded-xl border border-slate-200 bg-slate-50" />
              {voidOpen && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <label className={labelCls} htmlFor="inv-void-reason">Why are you voiding {invoice.invoice_number}?</label>
                  <input id="inv-void-reason" className={inputCls} value={voidReason} disabled={!!busy} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. wrong rate" />
                  <p className="mt-1 text-[11px] text-slate-500">The invoice and its PDF stay on record as Void. A new draft opens with the same details for you to correct.</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" onClick={handleVoidAndReissue} disabled={!!busy} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50">
                      {busy === "voiding" ? "Voiding..." : "Void and create new draft"}
                    </button>
                    <button type="button" onClick={() => { setVoidOpen(false); setError(""); }} disabled={!!busy} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {error && <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">{error}</div>}
        </div>

        {invoice && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-5 py-3">
            {isDraft ? (
              <>
                <div>
                  {confirmDiscard ? (
                    <span className="text-xs text-slate-600">
                      Discard this draft?{" "}
                      <button type="button" onClick={handleDiscard} disabled={disabled} className="font-medium text-rose-600 hover:text-rose-700">Discard</button>{" "}
                      <button type="button" onClick={() => setConfirmDiscard(false)} className="text-slate-500">Keep</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDiscard(true)} disabled={disabled} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50">Discard draft</button>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={handleSave} disabled={disabled || !dirty} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                    {busy === "saving" ? "Saving..." : "Save draft"}
                  </button>
                  <button type="button" onClick={handleIssue} disabled={disabled} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                    {busy === "issuing" ? "Issuing..." : "Issue invoice"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  {invoice.status === "issued" && canMutate && !voidOpen && (
                    <button type="button" onClick={() => setVoidOpen(true)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50">Void &amp; Reissue</button>
                  )}
                </div>
                <a href={`/api/invoices/${invoice.id}/pdf`} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Download PDF</a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
