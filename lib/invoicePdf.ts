// Renders an invoice PDF from the database's canonical render snapshot
// (invoice_render_snapshot, migration 049) -- and from nothing else, so the
// stored PDF always prints exactly what issue_invoice verified.
//
// Layout matched to the owner's QuickBooks "Print or download" invoice
// (redacted sample, 2026-11-12): business block top-left, "Invoice" title
// centered, BILL TO box, a six-column facts row (Invoice # / Date / Total
// due / Due date / Terms / Enclosed), the line table (Service date /
// Service type / Qty / Rate / Amount) with the product in bold over its
// description, the note bottom-left, and Subtotal / Total / Balance due
// bottom-right. Light-blue header bands with blue labels, thin gray rules.
//
// Not drawn (yet): the logo (no logo is stored -- the top-right stays
// empty) and the Tax line (invoices carry no tax; total = the line amount).
//
// Deterministic: the same snapshot always produces the same bytes (no
// creation/modification dates or producer metadata are written).
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

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

// "$1,234.56" (Total due, Balance due).
export function formatUsd(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${formatAmount(Math.abs(cents))}`;
}
// "1,234.56" without the dollar sign (Rate, Amount, Subtotal, Total -- as
// QuickBooks prints them).
export function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
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

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const LEFT = 24;
const RIGHT = PAGE_W - 24;

const INK = rgb(0, 0, 0);
const LABEL = rgb(0.31, 0.53, 0.71); // QuickBooks' blue header text
const BAND = rgb(0.863, 0.914, 0.953); // light-blue header band
const RULE = rgb(0.72, 0.75, 0.78); // thin gray borders

export async function renderInvoicePdf(s: InvoiceRenderSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(`Invoice ${s.invoice_number}`, { showInWindowTitleBar: false });
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // y is the BASELINE of the text being drawn (PDF origin bottom-left).
  const text = (t: string, x: number, y: number, size = 10, font: PDFFont = regular, color = INK) =>
    page.drawText(safe(t), { x, y, size, font, color });
  const textRight = (t: string, xr: number, y: number, size = 10, font: PDFFont = regular, color = INK) =>
    page.drawText(safe(t), { x: xr - font.widthOfTextAtSize(safe(t), size), y, size, font, color });
  const box = (x: number, yTop: number, w: number, h: number, fill?: ReturnType<typeof rgb>) =>
    page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: RULE, borderWidth: 0.6, ...(fill ? { color: fill } : {}) });
  const vline = (x: number, yTop: number, yBottom: number) =>
    page.drawLine({ start: { x, y: yTop }, end: { x, y: yBottom }, thickness: 0.6, color: RULE });
  const lines = (t: string | null) => (t ? t.split("\n") : []);
  // Word-wraps text to a width (points), keeping its own line breaks.
  const wrap = (t: string | null, width: number, size = 10, font: PDFFont = regular): string[] => {
    const out: string[] = [];
    for (const para of lines(t)) {
      let line = "";
      for (const word of safe(para).split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (!line || font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  };

  // ---- Business (top-left) and title (centered)
  let y = PAGE_H - 48;
  for (const l of wrap(s.business_name, 250, 11, bold)) {
    text(l, LEFT + 6, y, 11, bold);
    y -= 14;
  }
  for (const l of [...lines(s.business_address), s.business_phone ?? "", s.business_email ?? ""].filter(Boolean)) {
    text(l, LEFT + 6, y, 10);
    y -= 13.5;
  }
  text("Invoice", 272, PAGE_H - 54, 17);

  // ---- BILL TO box
  const billTop = Math.min(y - 4, PAGE_H - 142);
  const billX = 75;
  const billW = 184;
  const billH = 76;
  const headH = 12;
  box(billX, billTop, billW, billH);
  box(billX, billTop, billW, headH, BAND);
  text("BILL TO", billX + 6, billTop - 9, 8.5, regular, LABEL);
  let by = billTop - headH - 11;
  for (const l of [s.bill_to_name, ...lines(s.bill_to_address), s.bill_to_email ?? ""].filter(Boolean).flatMap((l) => wrap(l, billW - 12))) {
    if (by < billTop - billH + 4) break;
    text(l, billX + 6, by, 10);
    by -= 12;
  }

  // ---- Facts row: Invoice # | Date | Total due | Due date | Terms | Enclosed
  const factsTop = billTop - billH - 4;
  const fx = [LEFT, 120, 209, 313, 405, 499, RIGHT];
  const facts: [string, string][] = [
    ["INVOICE #", s.invoice_number],
    ["DATE", formatInvoiceDate(s.invoice_date)],
    ["TOTAL DUE", formatUsd(s.total_cents)],
    ["DUE DATE", formatInvoiceDate(s.due_date)],
    ["TERMS", TERMS_LABEL[s.terms] ?? s.terms],
    ["ENCLOSED", ""],
  ];
  box(LEFT, factsTop, RIGHT - LEFT, 30);
  box(LEFT, factsTop, RIGHT - LEFT, 15, BAND);
  facts.forEach(([label, value], i) => {
    if (i > 0) vline(fx[i], factsTop, factsTop - 30);
    text(label, fx[i] + 5, factsTop - 11, 8.5, regular, LABEL);
    if (value) text(value, fx[i] + 5, factsTop - 26, 10);
  });

  // ---- Line table: Service date | Service type | Qty | Rate | Amount
  const tableTop = factsTop - 30 - 40;
  const tx = [LEFT, 109, 213, 283, 352, RIGHT];
  const typeWidth = tx[2] - tx[1] - 10;
  const typeLines = [
    ...wrap(s.product_service, typeWidth, 10, bold).map((l) => ({ l, font: bold })),
    ...(s.description ? wrap(s.description, typeWidth).map((l) => ({ l, font: regular })) : []),
  ];
  const headerH = 18;
  const rowH = Math.max(1, typeLines.length) * 12 + 10;
  box(LEFT, tableTop, RIGHT - LEFT, headerH + rowH);
  box(LEFT, tableTop, RIGHT - LEFT, headerH, BAND);
  for (let i = 1; i < tx.length - 1; i++) vline(tx[i], tableTop, tableTop - headerH - rowH);
  const hy = tableTop - 12;
  text("SERVICE DATE", tx[0] + 5, hy, 8.5, regular, LABEL);
  text("SERVICE TYPE", tx[1] + 5, hy, 8.5, regular, LABEL);
  textRight("QTY", tx[3] - 5, hy, 8.5, regular, LABEL);
  textRight("RATE", tx[4] - 5, hy, 8.5, regular, LABEL);
  textRight("AMOUNT", tx[5] - 3, hy, 8.5, regular, LABEL);
  const ry = tableTop - headerH - 13;
  text(formatInvoiceDate(s.service_date), tx[0] + 5, ry, 10);
  typeLines.forEach(({ l, font }, i) => text(l, tx[1] + 5, ry - i * 12, 10, font));
  textRight(formatQty(s.quantity), tx[3] - 5, ry, 10);
  textRight(formatAmount(s.rate_cents), tx[4] - 5, ry, 10);
  textRight(formatAmount(s.amount_cents), tx[5] - 3, ry, 10);

  // ---- Note (bottom-left) and totals (bottom-right)
  const belowTop = tableTop - headerH - rowH - 13;
  let ny = belowTop;
  for (const body of [s.note_to_client, s.payment_instructions]) {
    if (!body) continue;
    for (const l of wrap(body, 290)) {
      text(l, LEFT + 1, ny, 10);
      ny -= 13;
    }
    ny -= 9;
  }
  let ty = belowTop;
  for (const [label, value] of [
    ["SUBTOTAL", formatAmount(s.subtotal_cents)],
    ["TOTAL", formatAmount(s.total_cents)],
  ] as const) {
    text(label, 320, ty, 10);
    textRight(value, RIGHT - 2, ty, 10);
    ty -= 15;
  }
  text("BALANCE DUE", 320, ty, 10);
  textRight(formatUsd(s.balance_due_cents), RIGHT - 2, ty - 6, 17);

  return doc.save({ useObjectStreams: false });
}
