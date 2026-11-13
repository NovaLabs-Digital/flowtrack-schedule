// Review & Send for issued invoices (migration 050): the prefilled email, the
// owner's edits checked the same way the database checks them, and how each
// send attempt reads. Browser-safe (no PDF or server imports).

export type InvoiceSendState = "sending" | "sent" | "failed" | "uncertain" | "disabled";

export type InvoiceSendAttempt = {
  id: string;
  state: InvoiceSendState;
  label: string;
  to: string;
  subject: string | null;
  created_at: string;
};

export type InvoiceEmailFields = { to: string; subject: string; message: string };

// How long an attempt may stay "sending" before it counts as an unknown
// outcome (the server stopped mid-send). Same as invoice_send_state() in 050.
export const SENDING_STALE_MS = 2 * 60 * 1000;

const EMAIL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same rule as claim_invoice_send() in 050: one plain address.
const EMAIL_RE = /^[^@\s<>,;"()]+@[^@\s<>,;"()]+\.[^@\s<>,;"()]+$/;

export function invoiceSendState(providerId: string | null, createdAt: string, now: number = Date.now()): InvoiceSendState {
  if (providerId === "sending" && now - Date.parse(createdAt) < SENDING_STALE_MS) return "sending";
  if (providerId === "sending" || providerId === "unconfirmed") return "uncertain";
  if (providerId === "failed") return "failed";
  if (providerId === "disabled") return "disabled";
  if (providerId && EMAIL_ID_RE.test(providerId)) return "sent";
  return "uncertain";
}

export const SEND_STATE_LABEL: Record<InvoiceSendState, string> = {
  sending: "Sending...",
  sent: "Sent — delivery unconfirmed",
  failed: "Failed",
  uncertain: "Outcome unknown — not confirmed",
  disabled: "Not sent — email sending is turned off",
};

export function toSendAttempt(row: { id: string; provider_id: string | null; to_value: string; subject: string | null; created_at: string }, now: number = Date.now()): InvoiceSendAttempt {
  const state = invoiceSendState(row.provider_id, row.created_at, now);
  return { id: row.id, state, label: SEND_STATE_LABEL[state], to: row.to_value, subject: row.subject ?? null, created_at: row.created_at };
}

function usd(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
function mdy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y}`;
}

// The email the owner reviews: the client's email, "Invoice 13485 from ACS
// Cleaning", and a short message with the total, due date and the invoice's
// own payment instructions. Every field is editable before sending.
export function buildInvoiceEmailPrefill(
  inv: {
    invoice_number: string | null; business_name: string; bill_to_name: string; bill_to_email: string | null;
    total_cents: number; terms: string; due_date: string; payment_instructions: string | null;
  },
  clientEmail: string | null
): InvoiceEmailFields {
  const number = inv.invoice_number ?? "";
  const due = inv.terms === "due_on_receipt" ? "due on receipt" : `due ${mdy(inv.due_date)}`;
  const firstName = inv.bill_to_name.trim().split(/\s+/)[0] || inv.bill_to_name.trim();
  const lines = [
    `Hi ${firstName},`,
    "",
    `Attached is invoice ${number} for ${usd(inv.total_cents)}, ${due}.`,
  ];
  if (inv.payment_instructions?.trim()) lines.push("", inv.payment_instructions.trim());
  lines.push("", "Thank you for your business.", inv.business_name.trim());
  return {
    to: (clientEmail?.trim() || inv.bill_to_email?.trim() || ""),
    subject: `Invoice ${number} from ${inv.business_name.trim()}`,
    message: lines.join("\n"),
  };
}

export type InvoiceEmailValidation =
  | { ok: true; value: InvoiceEmailFields }
  | { ok: false; field: "to" | "subject" | "message"; error: string };

export function validateInvoiceEmail(raw: unknown): InvoiceEmailValidation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const to = typeof r.to === "string" ? r.to.trim() : "";
  const subject = typeof r.subject === "string" ? r.subject.trim() : "";
  const message = typeof r.message === "string" ? r.message.replace(/\r\n/g, "\n").trim() : "";
  if (!to || to.length > 254 || !EMAIL_RE.test(to)) return { ok: false, field: "to", error: "Enter one email address, like client@example.com." };
  if (!subject) return { ok: false, field: "subject", error: "Enter a subject." };
  if (subject.length > 200 || /[\r\n]/.test(subject)) return { ok: false, field: "subject", error: "Keep the subject to one line (200 characters at most)." };
  if (!message) return { ok: false, field: "message", error: "Enter a message." };
  if (message.length > 10000) return { ok: false, field: "message", error: "The message is too long (10,000 characters at most)." };
  return { ok: true, value: { to, subject, message } };
}
