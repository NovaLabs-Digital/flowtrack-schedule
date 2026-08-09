import { DateTime } from "luxon";

export const BUSINESS_TZ = "America/New_York";

// A JS Date representing "right now," but with its local getters/setters
// (getDate, getDay, getHours, setHours, toDateString, etc.) always reflecting
// the business's own timezone — regardless of the runtime's ambient system
// timezone. Use this anywhere "today"/"this week" is computed during render,
// instead of bare `new Date()`.
//
// Why this matters: dashboard/page.tsx is force-dynamic, so every load runs a
// fresh SSR pass (likely on a UTC server) followed by client hydration
// (in the browser's local timezone). If "today" is computed via ambient
// `new Date()` on both sides, they disagree for several hours every evening
// Eastern Time (the server's calendar date has already advanced past
// midnight UTC while the client's hasn't) — producing different rendered
// output (which day is highlighted as "today", which week is shown, which
// date range defaults) and triggering a React hydration-mismatch error
// (minified error #418). Anchoring both sides to the same explicit business
// timezone makes the computation identical no matter which system timezone
// actually ran it.
// `tz` is required, no default -- every real scheduling-critical consumer
// (calendars, AppointmentModal, appointment detail/mobile/employee views,
// Business Hours, public booking, recurrence generation, reminders,
// notification templates, and reporting/Worked-Hours/Projected-Revenue
// bucketing) now resolves and passes its own trusted workspace timezone
// explicitly. The Phase 5C-era `tz = BUSINESS_TZ` compatibility default was
// removed once every one of those consumers was wired through (Phases
// 5D/5E) -- the only place BUSINESS_TZ still acts as a fallback is
// effectiveTimezone's own NULL-workspace case, below.
export function nowInBusinessTz(tz: string): Date {
  const dt = DateTime.now().setZone(tz);
  return new Date(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond);
}

// Same idea as nowInBusinessTz(), but for a GIVEN timestamp (e.g. an
// appointment's scheduled_for) instead of "now". Use this before calling
// .getHours()/.getMinutes()/.toDateString()/.toLocaleDateString() etc. on a
// stored timestamp for display or day-bucketing — otherwise the same
// server/client field extraction disagrees exactly like the "now" case did,
// just for a fixed instant instead of the current one (e.g. an appointment
// at 2026-07-06T13:00:00Z renders as "1:00 PM" server-side in UTC but
// "9:00 AM" after client hydration in America/New_York).
//
// NOT for instant comparisons (`<`, `>=` against another Date) — the
// synthesized Date's absolute instant is shifted by the runtime's own
// ambient offset, so use the real Date/ISO value directly for those, or
// startOfBusinessDay() below for day-boundary comparisons.
//
// `tz` is required, no default -- see nowInBusinessTz's own note above.
export function toBusinessLocal(iso: string, tz: string): Date {
  const dt = DateTime.fromISO(iso).setZone(tz);
  return new Date(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond);
}

// The true UTC instant of midnight in the business timezone, `daysFromToday`
// days from today (0 = today, 1 = tomorrow, etc.) — for use in instant
// comparisons like `apptDate >= startOfBusinessDay(0, tz) && apptDate <
// startOfBusinessDay(1, tz)`. Unlike nowInBusinessTz()/toBusinessLocal(),
// this returns a Date whose getTime() is correct and environment-
// independent, because Luxon resolves the real UTC offset for the given
// zone from the IANA tz database rather than relying on the runtime's own
// ambient offset.
//
// `tz` is required, no default -- see nowInBusinessTz's own note above.
// `daysFromToday` keeps its own default (0 = today) -- unrelated to timezone.
export function startOfBusinessDay(daysFromToday = 0, tz: string): Date {
  return DateTime.now().setZone(tz).plus({ days: daysFromToday }).startOf("day").toJSDate();
}

// ============================================================================
// Phase 5B (Workspace Time Zone Foundation) -- canonical timezone
// definitions/validation, added in Phase 5B for Settings storage/display.
//
// Phase 5C wired these into one-time owner appointment create/edit/display
// and calendar/mobile/employee-schedule rendering. Phase 5D wired Business
// Hours, public booking, and recurrence generation. Phase 5E wired
// notification templates, the reminder cron, Projected Revenue, Worked
// Hours/payroll (owner and employee), job-tracking timestamp display, and
// the owner billing banner's date display -- every remaining scheduling-
// critical consumer now receives an explicit `tz`/`timezone`
// parameter/prop resolved from that workspace's own company_settings row
// (see zonedDateValue/zonedTimeValue/zonedDateTimeToUTC below). Saving a
// non-default Time Zone in Settings now has an observable effect
// everywhere a business date/time is scheduled, displayed, formatted into
// a message, or bucketed for reporting. The only remaining non-explicit
// use of BUSINESS_TZ in this codebase is effectiveTimezone's own
// NULL-workspace fallback, immediately below -- by design, not an
// oversight.
// ============================================================================

export type TimezoneOption = { value: string; label: string };

// IANA identifiers only -- never a timezone abbreviation (EST/PST) or fixed
// UTC offset, both of which are not DST-aware and would silently drift
// twice a year. Curated to the U.S. zones relevant to SFT's current target
// customers (service businesses); expanding this list later is additive
// and requires no schema change (see migration 025's header).
export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: "America/New_York", label: "Eastern Time" },
  { value: "America/Chicago", label: "Central Time" },
  { value: "America/Denver", label: "Mountain Time" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Los_Angeles", label: "Pacific Time" },
  { value: "America/Anchorage", label: "Alaska Time" },
  { value: "Pacific/Honolulu", label: "Hawaii Time" },
];

const SUPPORTED_TIMEZONE_VALUES = new Set(TIMEZONE_OPTIONS.map((o) => o.value));

// Deliberately an allowlist membership check, never "does Intl/Luxon
// recognize this as a valid IANA zone" -- the IANA database contains
// hundreds of identifiers SFT does not yet support (and a caller could
// otherwise submit a technically-valid-but-unapproved zone, or a
// technically-invalid string that some environments' Intl still tolerates).
// Trusting parseability instead of an explicit allowlist is exactly the
// mistake this function exists to avoid.
export function isSupportedTimezone(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_TIMEZONE_VALUES.has(value.trim());
}

// The friendly label for a supported IANA zone (e.g. "Eastern Time") --
// falls back to the raw value itself for anything not in TIMEZONE_OPTIONS,
// so this never throws for an already-effectiveTimezone()-resolved value.
// Phase 5D: used by the public booking page to tell customers which
// timezone the displayed times are in, without making them choose one.
export function timezoneLabel(tz: string): string {
  const found = TIMEZONE_OPTIONS.find((o) => o.value === tz);
  return found ? found.label : tz;
}

export type TimezoneValidation = { ok: true; value: string } | { ok: false; error: string };

// Validates and normalizes an arbitrary (untrusted) value into one of the
// canonical allowlisted IANA identifiers -- never accepts NULL/undefined
// (that is effectiveTimezone's job, below, not this function's), a blank
// string, a non-string, an abbreviation, or an otherwise-valid-but-
// unapproved IANA zone.
export function normalizeTimezone(value: unknown): TimezoneValidation {
  if (typeof value !== "string") {
    return { ok: false, error: "Time zone must be a valid selection." };
  }
  const trimmed = value.trim();
  if (!isSupportedTimezone(trimmed)) {
    return { ok: false, error: "Please choose a supported time zone." };
  }
  return { ok: true, value: trimmed };
}

// The timezone actually in effect for a workspace: the saved value if
// present and valid, otherwise the canonical America/New_York fallback --
// never a partially-applied or rejected value. Use this to read
// company_settings.timezone (GET response, etc.), never normalizeTimezone
// directly, since a stored row is already trusted (validated at save time)
// and a NULL/missing column must fall back rather than error -- mirrors
// lib/businessHours.ts's effectiveBusinessHours precedent exactly.
export function effectiveTimezone(stored: unknown): string {
  if (stored === null || stored === undefined) return BUSINESS_TZ;
  const result = normalizeTimezone(stored);
  return result.ok ? result.value : BUSINESS_TZ;
}

// ============================================================================
// Phase 5C -- explicit UTC-instant <-> workspace-local conversion helpers.
//
// These back AppointmentModal's create/edit form fields and every other
// "what date/time does this UTC instant represent in the owner's own
// business" round trip. Never use `new Date(`${date}T${time}`)` (interprets
// the string in the BROWSER's own local timezone) or bare native
// getters/toLocaleDateString on a raw `new Date(iso)` (same problem) for
// business-appointment semantics -- both silently substitute the device's
// timezone for the workspace's.
// ============================================================================

// UTC instant -> the "YYYY-MM-DD" the workspace's own wall clock shows for
// it -- for populating a date form field on open/reopen.
export function zonedDateValue(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toFormat("yyyy-MM-dd");
}

// UTC instant -> the "HH:mm" (24-hour) the workspace's own wall clock shows
// for it -- for populating a time form field on open/reopen.
export function zonedTimeValue(iso: string, tz: string): string {
  return DateTime.fromISO(iso).setZone(tz).toFormat("HH:mm");
}

export type ZonedInstantResult = { ok: true; iso: string } | { ok: false; error: string };

// Workspace-local "YYYY-MM-DD" + "HH:mm" (as entered/displayed in a form) ->
// the true UTC instant, resolved with an explicit IANA zone via Luxon --
// never the browser/device's ambient zone.
//
// DST handling (empirically verified against the installed Luxon version --
// see the DST probe referenced in the Phase 5C report):
//
// - Nonexistent local time (spring-forward gap, e.g. 2027-03-14 02:30
//   America/New_York): Luxon does NOT mark this invalid -- it silently
//   rolls the wall-clock time forward past the gap (02:30 -> 03:30) and
//   returns isValid: true. Left unchecked this would silently save the
//   WRONG appointment. This function catches it by round-tripping the
//   requested hour/minute against what Luxon actually produced -- a
//   mismatch means the requested time never existed, and is rejected with
//   a clear error rather than silently shifted.
// - Ambiguous local time (fall-back, e.g. 2027-11-07 01:30
//   America/New_York, which occurs twice): Luxon deterministically resolves
//   to the FIRST/earlier occurrence (the still-DST-active offset, before
//   the clocks fall back) -- exactly the documented preferred policy, so no
//   special-case handling is needed here, only this test-backed reliance on
//   that deterministic behavior.
export function zonedDateTimeToUTC(date: string, time: string, tz: string): ZonedInstantResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { ok: false, error: "Please enter a valid date and time." };
  }

  const dt = DateTime.fromFormat(`${date} ${time}`, "yyyy-MM-dd HH:mm", { zone: tz });
  if (!dt.isValid) {
    return { ok: false, error: "Please enter a valid date and time." };
  }

  const [requestedHour, requestedMinute] = time.split(":").map(Number);
  if (dt.hour !== requestedHour || dt.minute !== requestedMinute) {
    return { ok: false, error: "That time doesn't exist due to a daylight-saving change. Please choose another time." };
  }

  return { ok: true, iso: dt.toUTC().toISO()! };
}
