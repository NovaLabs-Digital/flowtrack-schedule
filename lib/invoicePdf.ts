// Renders an invoice PDF from the database's canonical render snapshot
// (invoice_render_snapshot, migration 049) -- and from nothing else, so the
// stored PDF always prints exactly what issue_invoice verified.
//
// STEP 2 INTERIM LAYOUT: a plain, complete, readable invoice so issuing
// produces a real PDF end to end. Step 3 replaces only the drawing below
// with the layout matched to the owner's QuickBooks "Print or download"
// preview; the contract (snapshot in, deterministic bytes out) stays.
//
// Deterministic: the same snapshot always produces the same bytes (no
// creation/modification dates or producer metadata are written).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export type InvoiceRenderSnapshot = {
  invoice_id: string;
  revision: number;
  invoice_number: string;
  business_name: string;
  business_address: string | null;
  business_phone: string | null;
  business_email: string | null;
  bill_to_name: string;
  bill_to_address: string | null;
  bill_to_email: string | null;
  terms: string;
  invoice_date: string;
  due_date: string;
  service_date: string;
  product_service: string;
  description: string | null;
  quantity: number | string;
  rate_cents: number;
  amount_cents: number;
  subtotal_cents: number;
  total_cents: number;
  balance_due_cents: number;
  payment_instructions: string | null;
  note_to_client: string | null;
};

const TERMS_LABEL: Record<string, string> = { due_on_receipt: "Due on receipt", net_15: "Net 15", net_30: "Net 30" };

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}
// "2026-11-12" -> "11/12/2026" (QuickBooks' date style).
export function formatInvoiceDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${m}/${d}/${y}`;
}
function formatQty(q: number | string): string {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

// Standard PDF fonts only cover WinAnsi; anything else becomes "?" rather
// than failing the issue.
function safe(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");
}

export async function renderInvoicePdf(s: InvoiceRenderSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`Invoice ${s.invoice_number}`, { showInWindowTitleBar: false });
  const page = doc.addPage([612, 792]); // US Letter
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.4, 0.4, 0.45);
  const left = 54;
  const right = 558;
  let y = 738;

  const text = (t: string, x: number, yy: number, size = 10, font = regular, color = ink) =>
    page.drawText(safe(t), { x, y: yy, size, font, color });
  const textRight = (t: string, xr: number, yy: number, size = 10, font = regular, color = ink) =>
    page.drawText(safe(t), { x: xr - font.widthOfTextAtSize(safe(t), size), y: yy, size, font, color });
  const lines = (t: string | null) => (t ? t.split("\n") : []);

  // Business
  text(s.business_name, left, y, 16, bold);
  textRight("INVOICE", right, y, 16, bold);
  y -= 18;
  for (const l of [...lines(s.business_address), s.business_phone ?? "", s.business_email ?? ""].filter(Boolean)) {
    text(l, left, y, 9, regular, muted);
    y -= 12;
  }

  // Bill to + invoice facts
  y -= 16;
  const factsTop = y;
  text("BILL TO", left, y, 8, bold, muted);
  y -= 13;
  for (const l of [s.bill_to_name, ...lines(s.bill_to_address), s.bill_to_email ?? ""].filter(Boolean)) {
    text(l, left, y, 10);
    y -= 13;
  }
  let fy = factsTop;
  for (const [label, value] of [
    ["Invoice no.", s.invoice_number],
    ["Terms", TERMS_LABEL[s.terms] ?? s.terms],
    ["Invoice date", formatInvoiceDate(s.invoice_date)],
    ["Due date", formatInvoiceDate(s.due_date)],
  ] as const) {
    text(label, 380, fy, 9, bold, muted);
    textRight(value, right, fy, 10);
    fy -= 14;
  }
  y = Math.min(y, fy) - 20;

  // Line
  const cols = { date: left, product: 128, desc: 250, qty: 410, rate: 480, amount: right };
  page.drawLine({ start: { x: left, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.7, color: muted });
  text("Service Date", cols.date, y, 8, bold, muted);
  text("Product/service", cols.product, y, 8, bold, muted);
  text("Description", cols.desc, y, 8, bold, muted);
  textRight("Qty", cols.qty + 30, y, 8, bold, muted);
  textRight("Rate", cols.rate + 40, y, 8, bold, muted);
  textRight("Amount", cols.amount, y, 8, bold, muted);
  y -= 16;
  text(formatInvoiceDate(s.service_date), cols.date, y, 10);
  text(s.product_service, cols.product, y, 10);
  const descLines = lines(s.description).length ? lines(s.description) : [""];
  textRight(formatQty(s.quantity), cols.qty + 30, y, 10);
  textRight(formatUsd(s.rate_cents), cols.rate + 40, y, 10);
  textRight(formatUsd(s.amount_cents), cols.amount, y, 10);
  for (const l of descLines) {
    text(l, cols.desc, y, 10);
    y -= 13;
  }
  page.drawLine({ start: { x: left, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 0.7, color: muted });

  // Totals
  y -= 14;
  for (const [label, cents, isBold] of [
    ["Subtotal", s.subtotal_cents, false],
    ["Invoice total", s.total_cents, true],
    ["Balance due", s.balance_due_cents, true],
  ] as const) {
    text(label, 400, y, 10, isBold ? bold : regular);
    textRight(formatUsd(cents), right, y, 10, isBold ? bold : regular);
    y -= 15;
  }

  // Payment instructions / note
  y -= 10;
  for (const [label, body] of [["Payment instructions", s.payment_instructions], ["Note to client", s.note_to_client]] as const) {
    if (!body) continue;
    text(label, left, y, 8, bold, muted);
    y -= 12;
    for (const l of lines(body)) {
      text(l, left, y, 10);
      y -= 13;
    }
    y -= 8;
  }

  return doc.save({ useObjectStreams: false });
}
