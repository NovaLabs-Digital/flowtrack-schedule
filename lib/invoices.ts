// SFT invoices (migration 049) -- pure helpers, no I/O. The routes under
// app/api/invoices/** stay thin; everything decidable without a database
// lives here and is unit-tested in lib/invoices.test.ts.
//
// The database is the authority on numbering, revisions and what an issued
// invoice contains (see migrations/049_invoices.sql). This module only
// prepares and validates what the owner edits on a draft.
import { toBusinessLocal } from "@/lib/timezone";
import { toDateInputValue } from "@/lib/payroll";

export type InvoiceTerms = "due_on_receipt" | "net_15" | "net_30";

// Order = the order shown in the Terms dropdown (QuickBooks' own wording).
export const INVOICE_TERMS: { value: InvoiceTerms; label: string; days: number }[] = [
  { value: "due_on_receipt", label: "Due on receipt", days: 0 },
  { value: "net_15", label: "Net 15", days: 15 },
  { value: "net_30", label: "Net 30", days: 30 },
];

export const DEFAULT_NOTE_TO_CLIENT = "Thank you for your business.";

export function isInvoiceTerms(value: unknown): value is InvoiceTerms {
  return typeof value === "string" && INVOICE_TERMS.some((t) => t.value === value);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar date in "YYYY-MM-DD" (rejects 2026-02-30).
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Calendar-day arithmetic on a date-only value (no time zone involved).
export function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function dueDateFor(invoiceDate: string, terms: InvoiceTerms): string {
  const t = INVOICE_TERMS.find((x) => x.value === terms)!;
  return addCalendarDays(invoiceDate, t.days);
}

// Exact integer arithmetic for money, matching PostgreSQL's round(numeric)
// (half away from zero; every value here is non-negative, so: half up).
// BigInt keeps even $1,000,000 x 99.999% exact -- no floating point.
function divideRoundHalfUp(numerator: bigint, denominator: bigint): number {
  return Number((numerator * BigInt(2) + denominator) / (denominator * BigInt(2)));
}

// Same rule as the database (invoices_amounts_valid): round(quantity * rate).
// Quantity has at most 2 decimals (validated), so it is an exact count of
// hundredths.
export function lineAmountCents(quantity: number, rateCents: number): number {
  const hundredths = BigInt(Math.round(quantity * 100));
  return divideRoundHalfUp(hundredths * BigInt(rateCents), BigInt(100));
}

// Sales tax rate, as typed: a percent greater than 0 and below 100 with at
// most 3 decimals ("6.5", "6.875"). Blank = tax off. Returns the canonical
// text (sent to the database) and the rate in thousandths of a percent (for
// exact arithmetic). Same rule as the database's invoice_draft_tax_rate.
export type TaxRateParse = { ok: true; rate: string | null; thousandths: number | null } | { ok: false; error: string };
export function parseTaxRate(input: unknown): TaxRateParse {
  if (input === null || input === undefined) return { ok: true, rate: null, thousandths: null };
  const text = String(input).trim();
  if (!text) return { ok: true, rate: null, thousandths: null };
  const m = /^(\d{1,2})(?:\.(\d{1,3}))?$/.exec(text);
  if (!m) return { ok: false, error: "Tax rate must be a percent below 100 with at most 3 decimals, like 6.5" };
  const thousandths = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  if (thousandths <= 0) return { ok: false, error: "Tax rate must be more than 0%" };
  const whole = Math.floor(thousandths / 1000);
  const frac = String(thousandths % 1000).padStart(3, "0").replace(/0+$/, "");
  return { ok: true, rate: frac ? `${whole}.${frac}` : String(whole), thousandths };
}

// Same rule as the database: tax = round(amount * rate / 100), to the cent,
// half a cent up. rateThousandths = rate x 1000 (6.875% -> 6875).
export function taxCents(amountCents: number, rateThousandths: number | null): number {
  if (rateThousandths === null) return 0;
  return divideRoundHalfUp(BigInt(amountCents) * BigInt(rateThousandths), BigInt(100000));
}

// Exactly the keys create_invoice_draft / update_invoice_draft read.
export type InvoiceDraftFields = {
  business_name: string;
  business_address: string | null;
  business_phone: string | null;
  business_email: string | null;
  bill_to_name: string;
  bill_to_address: string | null;
  bill_to_email: string | null;
  terms: InvoiceTerms;
  invoice_date: string;
  due_date: string;
  service_date: string;
  product_service: string;
  description: string | null;
  quantity: number;
  rate_cents: number;
  // Sales tax percent ("6.5"), or null = no sales tax (the default).
  tax_rate: string | null;
  payment_instructions: string | null;
  note_to_client: string | null;
};

const TEXT_LIMITS: Record<string, number> = {
  business_name: 200, business_address: 500, business_phone: 50, business_email: 200,
  bill_to_name: 200, bill_to_address: 500, bill_to_email: 200,
  product_service: 200, description: 2000, payment_instructions: 1000, note_to_client: 1000,
};
const REQUIRED_TEXT = new Set(["business_name", "bill_to_name", "product_service"]);
const FIELD_LABELS: Record<string, string> = {
  business_name: "Business name", bill_to_name: "Bill to", product_service: "Product/service",
};

const MAX_RATE_CENTS = 100_000_000; // $1,000,000.00
const MAX_QUANTITY = 9999;

export type DraftValidation = { ok: true; fields: InvoiceDraftFields } | { ok: false; error: string };

// Validates and normalizes the owner's draft edits (a full replacement of
// the printed content -- update_invoice_draft replaces every field). Text is
// trimmed; blank optional text becomes null.
export function normalizeDraftFields(input: unknown): DraftValidation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Invalid invoice details" };
  }
  const raw = input as Record<string, unknown>;
  const text: Record<string, string | null> = {};
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    const v = raw[key];
    if (v !== undefined && v !== null && typeof v !== "string") return { ok: false, error: `Invalid ${key.replace(/_/g, " ")}` };
    const trimmed = typeof v === "string" ? v.trim() : "";
    if (trimmed.length > max) return { ok: false, error: `${FIELD_LABELS[key] ?? key.replace(/_/g, " ")} is too long` };
    if (REQUIRED_TEXT.has(key) && !trimmed) return { ok: false, error: `${FIELD_LABELS[key]} is required` };
    text[key] = trimmed || null;
  }

  if (!isInvoiceTerms(raw.terms)) return { ok: false, error: "Choose the invoice terms" };
  if (!isCalendarDate(raw.invoice_date)) return { ok: false, error: "Invoice date is not a valid date" };
  if (!isCalendarDate(raw.due_date)) return { ok: false, error: "Due date is not a valid date" };
  if (raw.due_date < raw.invoice_date) return { ok: false, error: "Due date can't be before the invoice date" };
  if (!isCalendarDate(raw.service_date)) return { ok: false, error: "Service date is not a valid date" };

  const quantity = raw.quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY
      || Math.abs(Math.round(quantity * 100) - quantity * 100) > 1e-6) {
    return { ok: false, error: "Qty must be a positive number with at most 2 decimals" };
  }
  const rate = raw.rate_cents;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > MAX_RATE_CENTS) {
    return { ok: false, error: "Rate must be a dollar amount" };
  }
  if (raw.tax_rate !== undefined && raw.tax_rate !== null && typeof raw.tax_rate !== "string" && typeof raw.tax_rate !== "number") {
    return { ok: false, error: "Invalid tax rate" };
  }
  const tax = parseTaxRate(raw.tax_rate);
  if (!tax.ok) return { ok: false, error: tax.error };

  return {
    ok: true,
    fields: {
      business_name: text.business_name!,
      business_address: text.business_address,
      business_phone: text.business_phone,
      business_email: text.business_email,
      bill_to_name: text.bill_to_name!,
      bill_to_address: text.bill_to_address,
      bill_to_email: text.bill_to_email,
      terms: raw.terms,
      invoice_date: raw.invoice_date,
      due_date: raw.due_date,
      service_date: raw.service_date,
      product_service: text.product_service!,
      description: text.description,
      quantity: Math.round(quantity * 100) / 100,
      rate_cents: rate,
      tax_rate: tax.rate,
      payment_instructions: text.payment_instructions,
      note_to_client: text.note_to_client,
    },
  };
}

// Business address as printed: street, then "City, ST ZIP" -- each part
// only when present.
export function formatBusinessAddress(c: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string | null {
  const street = (c.address ?? "").trim();
  const city = (c.city ?? "").trim();
  const stateZip = [(c.state ?? "").trim(), (c.zip ?? "").trim()].filter(Boolean).join(" ");
  const cityLine = [city, stateZip].filter(Boolean).join(", ");
  const lines = [street, cityLine].filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

// The draft "Create Invoice" starts from: the job (date, service, price),
// the client (bill to), the business (Settings -> Company), and the payment
// instructions / note from the workspace's most recent issued invoice (so
// the owner types them once, with no extra settings screen).
export function buildInvoicePrefill(input: {
  appointment: { service_type: string; scheduled_for: string; price_cents: number | null };
  client: { name: string; address: string | null; email: string | null };
  company: { company_name: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; email: string | null } | null;
  previous: { payment_instructions: string | null; note_to_client: string | null } | null;
  today: string; // workspace-local "YYYY-MM-DD"
  timezone: string;
}): InvoiceDraftFields {
  const { appointment, client, company, previous, today, timezone } = input;
  return {
    business_name: (company?.company_name ?? "").trim(),
    business_address: company ? formatBusinessAddress(company) : null,
    business_phone: blankToNull(company?.phone),
    business_email: blankToNull(company?.email),
    bill_to_name: client.name.trim(),
    bill_to_address: blankToNull(client.address),
    bill_to_email: blankToNull(client.email),
    terms: "due_on_receipt",
    invoice_date: today,
    due_date: dueDateFor(today, "due_on_receipt"),
    service_date: toDateInputValue(toBusinessLocal(appointment.scheduled_for, timezone)),
    product_service: appointment.service_type.trim(),
    description: null,
    quantity: 1,
    rate_cents: appointment.price_cents ?? 0,
    tax_rate: null, // new invoices start with tax off
    payment_instructions: previous ? blankToNull(previous.payment_instructions) : null,
    note_to_client: previous ? blankToNull(previous.note_to_client) : DEFAULT_NOTE_TO_CLIENT,
  };
}

// The new draft for Void & Reissue: the voided invoice's details -- its
// sales tax rate included (the database recalculates the tax on the new
// draft's amount) -- dated today (due date recomputed from its terms).
export function reissueFields(voided: InvoiceDraftFields, today: string): InvoiceDraftFields {
  return { ...voided, invoice_date: today, due_date: dueDateFor(today, voided.terms) };
}

// Columns an invoice is read with for the app -- never the PDF bytes.
export const INVOICE_VIEW_COLUMNS =
  "id, workspace_id, appointment_id, client_id, reissued_from_invoice_id, status, revision, invoice_number, " +
  "business_name, business_address, business_phone, business_email, bill_to_name, bill_to_address, bill_to_email, " +
  "terms, invoice_date, due_date, service_date, product_service, description, quantity, rate_cents, amount_cents, " +
  "tax_rate, tax_cents, total_cents, payment_instructions, note_to_client, job_price_cents, issued_at, voided_at, void_reason, created_at, updated_at";

export type InvoiceView = InvoiceDraftFields & {
  id: string;
  workspace_id: string;
  appointment_id: string;
  client_id: string;
  reissued_from_invoice_id: string | null;
  status: "draft" | "issued" | "void";
  revision: number;
  invoice_number: string | null;
  amount_cents: number;
  tax_cents: number;
  total_cents: number;
  job_price_cents: number | null;
  issued_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};

// PostgREST may return numeric as a string or a number; the app works with
// a number for quantity and canonical text for the tax rate ("6.5").
export function toInvoiceView(row: Record<string, unknown>): InvoiceView {
  const tax = parseTaxRate(row.tax_rate);
  return {
    ...(row as unknown as InvoiceView),
    quantity: Number(row.quantity),
    tax_rate: tax.ok ? tax.rate : null,
    tax_cents: Number(row.tax_cents ?? 0),
  };
}

// The draft-editable fields of an invoice row (used by Void & Reissue).
export function draftFieldsOf(inv: InvoiceView): InvoiceDraftFields {
  return {
    business_name: inv.business_name, business_address: inv.business_address,
    business_phone: inv.business_phone, business_email: inv.business_email,
    bill_to_name: inv.bill_to_name, bill_to_address: inv.bill_to_address, bill_to_email: inv.bill_to_email,
    terms: inv.terms, invoice_date: inv.invoice_date, due_date: inv.due_date, service_date: inv.service_date,
    product_service: inv.product_service, description: inv.description,
    quantity: Number(inv.quantity), rate_cents: inv.rate_cents, tax_rate: inv.tax_rate,
    payment_instructions: inv.payment_instructions, note_to_client: inv.note_to_client,
  };
}

// "SFT-1003.pdf" for SFT's own series; "Invoice-13485.pdf" for a workspace
// continuing its QuickBooks numbers (a bare "13485.pdf" says nothing).
export function invoicePdfFileName(invoiceNumber: string): string {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9-]/g, "");
  return /^[0-9]+$/.test(safe) ? `Invoice-${safe}.pdf` : `${safe}.pdf`;
}

// Settings -> Billing's "Invoice numbers" (migration 049's
// invoice_numbering_state).
export type InvoiceNumberingState = {
  series: "sft" | "custom";
  starting_number: number | null; // the owner's start, while it can still change
  next_available: string | null;
  locked: boolean; // true from the first issued invoice on (even if voided)
  highest_recorded: { number: string; value: string; client_name: string | null } | null;
};

// A typed "Starting invoice number": whole number, 1..999,999,999. Blank
// means "use the default SFT-1001 series".
export type StartingNumberParse = { ok: true; value: number | null } | { ok: false; error: string };
export function parseStartingNumber(input: unknown): StartingNumberParse {
  if (input === null || input === undefined) return { ok: true, value: null };
  const text = String(input).trim();
  if (!text) return { ok: true, value: null };
  if (!/^[0-9]{1,9}$/.test(text) || Number(text) < 1) {
    return { ok: false, error: "Enter a whole number, like 13485." };
  }
  return { ok: true, value: Number(text) };
}

// What the 049 database functions return (jsonb), as the routes read it.
export type InvoiceRpcOutcome = {
  outcome?: string;
  invoice_id?: string;
  invoice_number?: string | null;
  status?: string;
  replayed?: boolean;
  revision?: number;
  pdf_sha256?: string;
  render_snapshot?: unknown;
  billing?: unknown;
};

export function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Server error";
}
