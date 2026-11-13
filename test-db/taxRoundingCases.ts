// One table of rounding cases, run against BOTH the app's integer arithmetic
// (lib/invoices.test.ts) and PostgreSQL itself (test-db/invoices_049.test.ts),
// so the editor's preview and the stored invoice can never round differently.
//
// tax = round(amount_cents * rate / 100) to the cent, half a cent up.
export const TAX_ROUNDING_CASES: { amountCents: number; rate: string; taxCents: number; note: string }[] = [
  { amountCents: 10000, rate: "6.5", taxCents: 650, note: "$100.00 x 6.5% = $6.50 exactly" },
  { amountCents: 13333, rate: "7", taxCents: 933, note: "$133.33 x 7% = $9.3331 -> $9.33" },
  { amountCents: 15000, rate: "6.875", taxCents: 1031, note: "$150.00 x 6.875% = $10.3125 -> $10.31" },
  { amountCents: 150, rate: "7", taxCents: 11, note: "$1.50 x 7% = $0.105 -> $0.11 (half a cent rounds up)" },
  { amountCents: 10, rate: "5", taxCents: 1, note: "$0.10 x 5% = $0.005 -> $0.01 (half a cent rounds up)" },
  { amountCents: 21, rate: "2.5", taxCents: 1, note: "$0.21 x 2.5% = $0.00525 -> $0.01" },
  { amountCents: 5, rate: "6.5", taxCents: 0, note: "$0.05 x 6.5% = $0.00325 -> $0.00 (tax on, rounds to zero)" },
  { amountCents: 99, rate: "0.001", taxCents: 0, note: "smallest rate" },
  { amountCents: 0, rate: "8.25", taxCents: 0, note: "$0 line" },
  { amountCents: 15000, rate: "6.5", taxCents: 975, note: "$150.00 x 6.5% = $9.75" },
  { amountCents: 12345, rate: "8.875", taxCents: 1096, note: "$123.45 x 8.875% = $10.9561875 -> $10.96" },
  { amountCents: 100000000, rate: "99.999", taxCents: 99999000, note: "largest amount x largest rate" },
];

// Qty x Rate -> amount, same half-up rule (quantity has at most 2 decimals).
export const AMOUNT_ROUNDING_CASES: { quantity: number; rateCents: number; amountCents: number }[] = [
  { quantity: 1, rateCents: 15000, amountCents: 15000 },
  { quantity: 2.5, rateCents: 6400, amountCents: 16000 },
  { quantity: 1.33, rateCents: 3333, amountCents: 4433 },
  { quantity: 0.1, rateCents: 5, amountCents: 1 },
  { quantity: 0.01, rateCents: 50, amountCents: 1 },
  { quantity: 9999, rateCents: 10001, amountCents: 99999999 },
];
