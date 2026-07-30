// Shared money helpers (Phase 5.7D-R17). Every price in this app is stored
// as integer cents (services.default_price_cents, appointments.price_cents
// — migration 020) and only ever converted to/from a decimal dollar string
// at the UI/API boundary, never floating-point dollars in between — avoids
// rounding error for anything persisted or compared.

// Generous ceiling against malformed/pathological input (an accidental
// extra digit, a copy-paste error), not a real business limit on job price.
export const MAX_PRICE_CENTS = 99_999_999; // $999,999.99

// Parses a user-typed dollar-amount string (e.g. "45", "45.5", "0.00") into
// integer cents, or null if the input is blank, malformed, negative, or
// exceeds MAX_PRICE_CENTS. A blank string and "0"/"0.00" are deliberately
// distinct: blank -> null ("no price set"), "0" -> 0 (an intentional $0.00
// price). Never throws.
export function parsePriceToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

  const [dollarsPart, centsPart = ""] = trimmed.split(".");
  const totalCents = Number(dollarsPart) * 100 + Number(centsPart.padEnd(2, "0"));

  if (!Number.isFinite(totalCents) || !Number.isInteger(totalCents)) return null;
  if (totalCents < 0 || totalCents > MAX_PRICE_CENTS) return null;
  return totalCents;
}

// Formats integer cents as a plain decimal string suitable for a text
// input's controlled value (e.g. 4550 -> "45.50"). "" for null/undefined —
// a blank field, matching "no price set."
export function centsToInputValue(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2);
}

// Formats integer cents as a currency display string (e.g. 4550 -> "$45.50",
// 0 -> "$0.00"). Distinct fallback for null/undefined so "no price set" is
// never confused with a real $0.00 price in any read-only display.
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

// Server-side safety check: is this a safe, storable price_cents value?
// Deliberately does not accept undefined/null — callers decide what those
// mean (leave unchanged vs. explicitly clear) before ever calling this.
export function isValidPriceCents(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_PRICE_CENTS;
}
