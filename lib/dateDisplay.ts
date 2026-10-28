import { zonedDateValue } from "@/lib/timezone";

// Shared numeric calendar-date display formatting (MM/DD/YY), used anywhere
// the UI shows a plain calendar date as digits rather than a descriptive
// heading like "Mon, Oct 26" (those stay on their own existing
// weekday-inclusive formatting -- see each component's own formatDay/
// formatWeekRange-style helper, none of which this module touches).
//
// "YY" is the last two digits of the year (26 for 2026), never a 4-digit
// year. MM/DD/YY (not DD/MM/YY -- a prior BillingPanel pass used DD/MM/YY,
// but that read as confusing against QuickBooks, which Alberto compares
// side-by-side with Billing and which always displays US-style MM/DD/YY).
// First introduced in BillingPanel.tsx; moved here so every other numeric
// date display in the app can reuse the exact same formatter instead of
// re-implementing its own slightly different one.

// DISPLAY FORMATTING ONLY -- this never touches storage, API query
// parameters, date-range math, sorting, or eligibility rules; it only
// changes what the owner SEES. Input is always a "YYYY-MM-DD" calendar-date
// string -- for a genuine date-only value (e.g. serviceDate, client_since,
// cancellation_reported_date), that string directly; for a real timestamp,
// the caller must resolve it to the workspace's own business-local calendar
// date FIRST (via lib/timezone.ts's zonedDateValue, see
// formatTimestampMMDDYY below) before it ever reaches this function. This
// function itself performs NO Date construction and NO timezone
// conversion -- plain substring rearrangement only, so it can never
// re-interpret a date-only value through an unrelated (and wrong) timezone,
// and can never disagree with whatever value was actually fetched/saved/
// displayed elsewhere for the same field.
export function formatMMDDYY(dateOnly: string): string {
  const [y, m, d] = dateOnly.split("-");
  if (!y || !m || !d) return dateOnly; // defensive: never throw on an unexpected shape
  return `${m}/${d}/${y.slice(-2)}`;
}

// Real UTC instant (e.g. scheduled_for, cancelled_at, actual_started_at) ->
// MM/DD/YY in the workspace's own business timezone. Resolves the
// business-local calendar date via the existing, already-timezone-correct
// zonedDateValue (Luxon, resolves the real IANA offset) rather than any
// local re-derivation, then formats it with the exact same formatMMDDYY
// used for genuine date-only values -- one formatter, two ways to reach a
// "YYYY-MM-DD" input, never two different rendering rules.
export function formatTimestampMMDDYY(iso: string, tz: string): string {
  return formatMMDDYY(zonedDateValue(iso, tz));
}
