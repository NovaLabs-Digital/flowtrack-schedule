// Block 2C-2A: the pure, deterministic rolling-occurrence calendar
// generator for an ACTIVE recurring series' immutable snapshot anchor
// (migrations/026 + migrations/027a's activate_recurring_series --
// anchor_local_date/anchor_local_time/anchor_timezone/frequency_type/
// repeat_weeks/repeat_months). This module has NO Supabase, environment
// variable, Date.now(), network, filesystem, or React dependency -- it is
// pure calendar/timezone math, safe to unit-test exhaustively and safe to
// call from any future context without pulling any of those in. The only
// import from another project module is `RecurringFrequency`, taken as a
// TYPE ONLY (`import type`, fully erased at compile time -- zero runtime
// dependency on lib/recurringSeries.ts or the Supabase client it imports)
// and `isSupportedTimezone` from lib/timezone.ts, which is itself pure
// (Luxon only, no Supabase/env/React -- verified by reading that file).
//
// This is deliberately separate from lib/recurrence.ts's
// generateFutureDates/generateFutureDatesSafe (the fixed ~6-month/
// 24-month horizon generator used by appointment creation and This &
// Future editing) -- that API and its callers' behavior are completely
// unchanged by this file's existence. Nothing in the application imports
// this module yet: Block 2C-2A is calendar math only -- no RPC, no cron
// route, no migration, no wiring into any request path.
//
// ============================================================================
// Boundary contract: (after, through]
// ============================================================================
//
// `after` and `through` are both absolute UTC instants (ISO strings). For
// any candidate occurrence instant:
//   - exactly equal to `after`      -> EXCLUDED
//   - strictly greater than `after` -> eligible
//   - exactly equal to `through`      -> INCLUDED
//   - strictly greater than `through` -> EXCLUDED
//
// This is the standard "open on the near edge, closed on the far edge"
// interval a ROLLING generator needs: calling this function again later
// with `after` set to the previous call's own last returned occurrence (or
// to the previous `through`, if nothing was generated that time) can never
// regenerate a duplicate and can never skip a real occurrence -- exactly
// the property (after, through] guarantees, and the reason it is chosen
// over any other half-open convention.
//
// `through <= after` is rejected as invalid_input -- there is no window to
// generate into.
//
// ============================================================================
// Anchor semantics
// ============================================================================
//
// Every candidate occurrence is computed directly from the anchor
// (anchorLocalDate + anchorLocalTime, interpreted in anchorTimezone) plus
// a whole number of calendar steps -- NEVER from the previously generated
// or clamped candidate. This is what makes monthly's day-of-month recovery
// correct (Jan 31 + 1 month = Feb 28, but Jan 31 + 2 months is computed
// fresh from day 31 and lands on Mar 31, never Mar 28/29 -- the same
// technique lib/recurrence.ts's addCalendarMonths already uses, for the
// identical reason) and is what keeps every other frequency's local
// wall-clock time and weekday exact and non-drifting no matter how many
// occurrences have already been generated in prior calls.
import { DateTime } from "luxon";
import { isSupportedTimezone } from "./timezone";
import type { RecurringFrequency } from "./recurringSeries";

export interface GenerateOccurrencesInWindowParams {
  frequencyType: RecurringFrequency;
  // Only consulted for frequencyType === "weekly"/"monthly" respectively --
  // mirrors lib/recurrence.ts's generateFutureDates's own established
  // convention that an irrelevant interval parameter is simply ignored,
  // never required, for a frequency it doesn't apply to.
  repeatWeeks: number | null;
  repeatMonths: number | null;
  anchorLocalDate: string; // "YYYY-MM-DD", the immutable registry anchor
  anchorLocalTime: string; // "HH:mm", the immutable registry anchor
  anchorTimezone: string; // one of lib/timezone.ts's 7 approved IANA zones
  after: string; // absolute UTC instant, ISO -- exclusive lower bound
  through: string; // absolute UTC instant, ISO -- inclusive upper bound
  maxOccurrences: number; // mandatory positive safe integer
}

export type GenerateOccurrencesFailureReason =
  | "invalid_input"
  | "invalid_timezone"
  | "dst_gap"
  | "iteration_limit";

export type GenerateOccurrencesResult =
  | { ok: true; occurrences: string[]; truncated: boolean }
  | { ok: false; reason: GenerateOccurrencesFailureReason };

const MIN_REPEAT_WEEKS = 1;
const MAX_REPEAT_WEEKS = 8;
const MIN_REPEAT_MONTHS = 1;
const MAX_REPEAT_MONTHS = 12;

// Production-review correction (algorithm audit): a fixed extra number of
// loop passes deliberately scanned BEFORE the true first eligible
// candidate, as cheap insurance against the starting-index estimate below
// ever landing on or after it (which would incorrectly skip a real
// occurrence). "One or two intervals early" is the task's own stated
// tolerance; 3 gives a small additional margin against integer-rounding at
// no meaningful cost (a handful of extra iterations, never thousands).
const START_INDEX_SAFETY_MARGIN = 3;

// A hard backstop against a runaway loop from a malformed or degenerate
// input, entirely independent of maxOccurrences (which only bounds the
// OUTPUT -- without this, a caller-supplied `through` far beyond `after`
// with a generous maxOccurrences could otherwise iterate for a very long
// time for "daily"/"weekdays", which step one calendar day per iteration).
// 20,000 iterations is already far beyond any legitimate replenishment
// window (over 54 years of daily stepping) and completes in low-single-
// digit milliseconds of pure arithmetic -- this is a defensive ceiling,
// not a tuning knob for real usage, and is intentionally NOT the same
// constant as any future cron batch limit (which bounds how many
// occurrences one cron run persists, an entirely different concern from
// how many calendar candidates this pure function is willing to examine).
export const DEFENSIVE_ITERATION_CEILING = 20_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Encodes the valid hour/minute RANGE directly (00-23 / 00-59), not just
// digit shape -- deliberately not relying solely on Luxon's own parser
// strictness for this specific check, matching this codebase's established
// belt-and-suspenders pattern (see migrations/027a's review_reason CHECK).
// Calendar-date validity (leap years, days-in-month) is NOT similarly
// hand-encoded here -- that is genuinely complex and Luxon's own `.isValid`
// (checked in resolveAnchor below) is the right tool for it.
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SUPPORTED_FREQUENCIES: ReadonlySet<string> = new Set(["daily", "weekdays", "weekly", "monthly"]);

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// Parses the immutable anchor into a zoned Luxon DateTime, and separately
// reports whether that exact local date/time is nonexistent (a DST
// spring-forward gap) -- using the identical round-trip technique
// lib/timezone.ts's zonedDateTimeToUTC already relies on (empirically
// verified against the installed Luxon version, both there and again here
// during this module's own implementation): Luxon does not mark a gapped
// local time invalid, it silently rolls the wall clock forward past the
// gap, so the only reliable detection is comparing the requested
// hour/minute against what Luxon actually produced. In practice a stored
// anchor was already validated this same way at snapshot-capture time
// (activate_recurring_series, migrations/027a), so this should never fire
// for real data -- it exists because this is a defensive pure function
// that does not trust its inputs.
function resolveAnchor(
  anchorLocalDate: string,
  anchorLocalTime: string,
  anchorTimezone: string
): { ok: true; dt: DateTime } | { ok: false; reason: "invalid_input" | "dst_gap" } {
  const dt = DateTime.fromFormat(`${anchorLocalDate} ${anchorLocalTime}`, "yyyy-MM-dd HH:mm", { zone: anchorTimezone });
  if (!dt.isValid) {
    return { ok: false, reason: "invalid_input" };
  }
  const [requestedHour, requestedMinute] = anchorLocalTime.split(":").map(Number);
  if (dt.hour !== requestedHour || dt.minute !== requestedMinute) {
    return { ok: false, reason: "dst_gap" };
  }
  return { ok: true, dt };
}

// The one place this module ever advances a calendar step -- always from
// the fixed `anchor`, using `k` (1, 2, 3, ...) as the whole number of
// steps, never from a previously computed candidate. daily/weekdays step
// by `k` calendar days; weekly steps by `k * repeatWeeks` whole weeks
// (expressed as days, matching lib/recurrence.ts's own
// `intervalDays = repeatWeeks * 7` convention, which automatically
// preserves the local weekday since a whole number of weeks never changes
// day-of-week regardless of any DST offset change crossed along the way);
// monthly steps by `k * repeatMonths` calendar months via Luxon's own
// month arithmetic, which clamps to the target month's last day when it
// doesn't contain the anchor's original day and -- because this is always
// computed fresh from `anchor`, never chained -- correctly recovers that
// original day again as soon as a later month can hold it.
function computeCandidate(
  frequencyType: RecurringFrequency,
  anchor: DateTime,
  k: number,
  repeatWeeks: number | null,
  repeatMonths: number | null
): DateTime {
  if (frequencyType === "daily" || frequencyType === "weekdays") {
    return anchor.plus({ days: k });
  }
  if (frequencyType === "weekly") {
    return anchor.plus({ days: k * (repeatWeeks as number) * 7 });
  }
  return anchor.plus({ months: k * (repeatMonths as number) });
}

// Production-review correction (algorithm audit): a rolling generator must
// not scan every historical step from k = 1 just to reach a caller's
// `after`, which could be years or decades after the anchor. This
// estimates a SAFE (never-too-large -- i.e. never past the true first
// eligible k, which would silently skip a real occurrence) starting index
// using ordinary business-local calendar distance between the anchor and
// `after`, per frequency:
//   - daily/weekdays: local calendar-day distance (weekdays still indexes
//     by calendar day, exactly like daily -- weekend filtering happens
//     per-candidate in the main loop, not in this estimate)
//   - weekly: whole-week distance divided by repeatWeeks
//   - monthly: whole-calendar-month distance divided by repeatMonths
// Luxon's `.diff()` with a calendar unit ("days"/"months") is itself
// calendar-aware (empirically verified: a 9-calendar-day span across a DST
// spring-forward transition still diffs to exactly 9.0, never a
// DST-distorted fraction), so no separate DST correction is needed here --
// only the ordinary integer floor plus a fixed safety margin, then a floor
// at 1 (this function only ever estimates a starting point for candidates
// AFTER the anchor; k = 0, the anchor itself, is never a candidate).
function estimateStartingK(
  frequencyType: RecurringFrequency,
  anchor: DateTime,
  afterDt: DateTime,
  repeatWeeks: number | null,
  repeatMonths: number | null
): number {
  const afterLocal = afterDt.setZone(anchor.zone);

  if (frequencyType === "daily" || frequencyType === "weekdays") {
    const daysDistance = Math.floor(afterLocal.diff(anchor, "days").days);
    return Math.max(1, daysDistance - START_INDEX_SAFETY_MARGIN);
  }
  if (frequencyType === "weekly") {
    const weeksDistance = Math.floor(afterLocal.diff(anchor, "weeks").weeks / (repeatWeeks as number));
    return Math.max(1, weeksDistance - START_INDEX_SAFETY_MARGIN);
  }
  const monthsDistance = Math.floor(afterLocal.diff(anchor, "months").months / (repeatMonths as number));
  return Math.max(1, monthsDistance - START_INDEX_SAFETY_MARGIN);
}

// Internal core -- returns both the public result AND the number of loop
// iterations this call actually performed. The iteration count is NOT
// part of the production result contract (generateOccurrencesInWindow,
// below, discards it) -- it exists so tests can directly assert the
// starting-index optimization's effect (bounded iteration count,
// independent of how far in the past the anchor is) without inferring it
// indirectly from wall-clock timing.
function runGeneration(
  params: GenerateOccurrencesInWindowParams
): { result: GenerateOccurrencesResult; iterationsUsed: number } {
  const {
    frequencyType,
    repeatWeeks,
    repeatMonths,
    anchorLocalDate,
    anchorLocalTime,
    anchorTimezone,
    after,
    through,
    maxOccurrences,
  } = params;

  if (!isPositiveSafeInteger(maxOccurrences)) {
    return { result: { ok: false, reason: "invalid_input" }, iterationsUsed: 0 };
  }
  if (!SUPPORTED_FREQUENCIES.has(frequencyType)) {
    return { result: { ok: false, reason: "invalid_input" }, iterationsUsed: 0 };
  }
  // Production-review correction (algorithm audit): mirrors
  // migrations/026's own recurring_series CHECK constraint exactly --
  // (weekly: repeat_weeks BETWEEN 1 AND 8 AND repeat_months IS NULL) OR
  // (monthly: repeat_months BETWEEN 1 AND 12 AND repeat_weeks IS NULL) OR
  // (daily/weekdays: both IS NULL) -- never merely "the relevant interval
  // is in range," which previously left the IRRELEVANT interval
  // unvalidated (e.g. frequencyType: "daily" with a stray repeatWeeks: 3
  // was silently accepted and simply ignored). A caller-observed row that
  // violates this exact shape cannot have legitimately come from the
  // database (the CHECK constraint would have rejected it at write time),
  // so this is defense-in-depth against a malformed/forged input, not a
  // rule this module invents independently of the schema it mirrors.
  const isWeeklyShapeValid =
    frequencyType === "weekly" &&
    Number.isInteger(repeatWeeks) &&
    (repeatWeeks as number) >= MIN_REPEAT_WEEKS &&
    (repeatWeeks as number) <= MAX_REPEAT_WEEKS &&
    repeatMonths === null;
  const isMonthlyShapeValid =
    frequencyType === "monthly" &&
    Number.isInteger(repeatMonths) &&
    (repeatMonths as number) >= MIN_REPEAT_MONTHS &&
    (repeatMonths as number) <= MAX_REPEAT_MONTHS &&
    repeatWeeks === null;
  const isDailyOrWeekdaysShapeValid =
    (frequencyType === "daily" || frequencyType === "weekdays") && repeatWeeks === null && repeatMonths === null;
  if (!isWeeklyShapeValid && !isMonthlyShapeValid && !isDailyOrWeekdaysShapeValid) {
    return { result: { ok: false, reason: "invalid_input" }, iterationsUsed: 0 };
  }
  if (!DATE_RE.test(anchorLocalDate) || !TIME_RE.test(anchorLocalTime)) {
    return { result: { ok: false, reason: "invalid_input" }, iterationsUsed: 0 };
  }
  if (!isSupportedTimezone(anchorTimezone)) {
    return { result: { ok: false, reason: "invalid_timezone" }, iterationsUsed: 0 };
  }

  const afterDt = DateTime.fromISO(after, { zone: "utc" });
  const throughDt = DateTime.fromISO(through, { zone: "utc" });
  if (!afterDt.isValid || !throughDt.isValid || throughDt <= afterDt) {
    return { result: { ok: false, reason: "invalid_input" }, iterationsUsed: 0 };
  }

  const anchorResult = resolveAnchor(anchorLocalDate, anchorLocalTime, anchorTimezone);
  if (!anchorResult.ok) {
    return { result: anchorResult, iterationsUsed: 0 };
  }
  const anchorDt = anchorResult.dt;
  const anchorHour = anchorDt.hour;
  const anchorMinute = anchorDt.minute;

  const occurrences: string[] = [];
  let truncated = false;

  // Production-review correction (algorithm audit): start near `after`
  // instead of at k = 1, so a decades-old anchor with a narrow current
  // window does not scan years of irrelevant history. This is a starting
  // POINT only -- every candidate is still computed as anchor + k*interval
  // (see computeCandidate), never chained from a prior candidate.
  const kStart = estimateStartingK(frequencyType, anchorDt, afterDt, repeatWeeks, repeatMonths);

  // Production-review correction (algorithm audit): the iteration budget
  // is counted independently of k's own magnitude (k can legitimately
  // start large, e.g. tens of thousands, for a very old anchor) -- it must
  // bound the WORK this call actually performs, not the raw step index,
  // or a large kStart would leave too little budget to validate the
  // requested window itself.
  let iterationsUsed = 0;

  for (let k = kStart; iterationsUsed < DEFENSIVE_ITERATION_CEILING; k++, iterationsUsed++) {
    const candidate = computeCandidate(frequencyType, anchorDt, k, repeatWeeks, repeatMonths);
    const candidateUtc = candidate.toUTC();

    // Stop-check FIRST, unconditionally, before any frequency-specific
    // filtering -- candidates are strictly increasing in k for every
    // supported frequency, so once one exceeds `through` no later k can
    // ever be back in range, and it is irrelevant whether this terminal,
    // out-of-window candidate happens to also be a weekend day or a DST
    // gap (a candidate outside the requested window never needs to be
    // gap-checked -- see this file's header, "no partial result if any
    // candidate IN THE REQUESTED WINDOW is nonexistent").
    if (candidateUtc > throughDt) {
      return { result: { ok: true, occurrences, truncated }, iterationsUsed };
    }

    if (frequencyType === "weekdays" && (candidate.weekday === 6 || candidate.weekday === 7)) {
      continue;
    }

    if (candidateUtc <= afterDt) {
      continue;
    }

    // This candidate IS in the requested window -- ALWAYS gap-checked,
    // whether or not `occurrences` has already reached maxOccurrences.
    // Production-review correction (algorithm audit): reaching
    // maxOccurrences must not stop validation of the REST of the
    // requested window -- a DST gap anywhere in (after, through], even
    // well beyond the cap, must still fail the whole call rather than
    // returning a truncated "success" that silently never mentions the
    // gap a later replenishment pass would otherwise hit.
    if (candidate.hour !== anchorHour || candidate.minute !== anchorMinute) {
      return { result: { ok: false, reason: "dst_gap" }, iterationsUsed };
    }

    if (occurrences.length < maxOccurrences) {
      occurrences.push(candidateUtc.toISO()!);
    } else {
      // A real, otherwise-valid occurrence exists beyond the cap --
      // exactly what `truncated` means. Do NOT return yet: the loop keeps
      // validating the remainder of the window (never collecting further)
      // so a later gap is still caught, per the correction above.
      truncated = true;
    }
  }

  return { result: { ok: false, reason: "iteration_limit" }, iterationsUsed };
}

// Deterministic, side-effect-free: generates every real occurrence of the
// given recurring pattern that falls in (after, through], derived directly
// from the immutable anchor, up to `maxOccurrences` results. See this
// file's header for the full boundary/anchor/DST contract. This is the
// ONLY production entry point -- its return shape is exactly
// GenerateOccurrencesResult, unchanged by the internal iteration-count
// diagnostic below.
export function generateOccurrencesInWindow(params: GenerateOccurrencesInWindowParams): GenerateOccurrencesResult {
  return runGeneration(params).result;
}

// Test-only: identical to generateOccurrencesInWindow, but also returns
// the number of loop iterations this call actually performed. Not part of
// the production contract -- exists solely so tests can directly assert
// the starting-index optimization keeps iteration count bounded and
// independent of how far in the past the anchor is, rather than inferring
// it indirectly from wall-clock timing.
export function generateOccurrencesInWindowWithDiagnostics(
  params: GenerateOccurrencesInWindowParams
): { result: GenerateOccurrencesResult; iterationsUsed: number } {
  return runGeneration(params);
}
