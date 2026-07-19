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
export function nowInBusinessTz(): Date {
  const dt = DateTime.now().setZone(BUSINESS_TZ);
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
export function toBusinessLocal(iso: string): Date {
  const dt = DateTime.fromISO(iso).setZone(BUSINESS_TZ);
  return new Date(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond);
}

// The true UTC instant of midnight in the business timezone, `daysFromToday`
// days from today (0 = today, 1 = tomorrow, etc.) — for use in instant
// comparisons like `apptDate >= startOfBusinessDay(0) && apptDate <
// startOfBusinessDay(1)`. Unlike nowInBusinessTz()/toBusinessLocal(), this
// returns a Date whose getTime() is correct and environment-independent,
// because Luxon resolves the real UTC offset for America/New_York from the
// IANA tz database rather than relying on the runtime's own ambient offset.
export function startOfBusinessDay(daysFromToday = 0): Date {
  return DateTime.now().setZone(BUSINESS_TZ).plus({ days: daysFromToday }).startOf("day").toJSDate();
}
