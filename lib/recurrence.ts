import { DateTime } from "luxon";

export const MAX_HORIZON_DAYS = 182;

// Monthly recurrence uses a month-counted horizon rather than reusing
// MAX_HORIZON_DAYS -- a day-based ~6-month window would make "Every 12
// months" (a supported UI option) generate zero future occurrences, which
// would make that choice silently useless. 24 months mirrors the same
// "several multiples of the largest supported interval" headroom
// MAX_HORIZON_DAYS already gives weekly (182 days covers more than 3
// occurrences even at the largest 8-week interval): every supported
// interval from 1 through 12 months yields at least 2 occurrences within
// this window.
export const MAX_MONTHLY_HORIZON_MONTHS = 24;

// Phase 5D: `tz` is an explicit, required parameter on every function in
// this module -- the resolved workspace timezone, never the global
// BUSINESS_TZ default (see lib/timezone.ts's own note on that default being
// a Phase 5C-era compatibility shim). `date`/`startDate` are always an
// absolute instant (their own getDate()/getHours() are meaningless without
// a zone) -- appointments.scheduled_for's real meaning is a wall-clock time
// in the WORKSPACE's own timezone, which the browser correctly encoded into
// that UTC instant at creation time. Computing this with plain Date-local
// methods instead (as an earlier version of addDays did) inherits whatever
// zone the Node process happens to run in -- on a UTC production server
// that means the UTC hour gets preserved across a DST transition instead of
// the business-local hour, silently shifting a 9:00 AM appointment to
// 10:00 AM (or 8:00 AM) after crossing a DST boundary. Luxon resolves the
// real IANA DST offset for the target date/zone, so the business-local
// wall-clock hour is what's preserved for daily/weekdays/weekly recurrence
// too, exactly like addCalendarMonths already did for monthly (Phase 2).
export function addDays(date: Date, days: number, tz: string): Date {
  return DateTime.fromJSDate(date).setZone(tz).plus({ days }).toJSDate();
}

// Adds `months` calendar months to `date`, always measured from `date`'s
// OWN day-of-month -- never from a previously clamped result -- so a short
// month never permanently shifts a later occurrence's day. When the target
// month doesn't have `date`'s day (e.g. day 31 in a 30-day month), clamps
// to that month's actual last day; the ORIGINAL day is used again for every
// later occurrence, so Jan 31 + 1 month = Feb 28, but Jan 31 + 2 months is
// computed fresh from day 31 and lands on Mar 31, not Mar 28.
export function addCalendarMonths(date: Date, months: number, tz: string): Date {
  return DateTime.fromJSDate(date).setZone(tz).plus({ months }).toJSDate();
}

function isWeekdayInTz(d: Date, tz: string): boolean {
  const weekday = DateTime.fromJSDate(d).setZone(tz).weekday; // 1=Monday..7=Sunday
  return weekday !== 6 && weekday !== 7;
}

// repeatMonths is only consulted when frequencyType === "monthly" -- every
// existing caller/behavior for "daily" | "weekdays" | "weekly" is completely
// unaffected by this parameter's presence, including callers that don't
// pass it at all.
export function generateFutureDates(
  startDate: Date,
  frequencyType: string,
  repeatWeeks: number,
  tz: string,
  repeatMonths?: number,
): Date[] {
  const dates: Date[] = [];

  if (frequencyType === "daily") {
    for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
      dates.push(addDays(startDate, d, tz));
    }
  } else if (frequencyType === "weekdays") {
    for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
      const candidate = addDays(startDate, d, tz);
      if (isWeekdayInTz(candidate, tz)) {
        dates.push(candidate);
      }
    }
  } else if (frequencyType === "weekly" && repeatWeeks >= 1) {
    const intervalDays = repeatWeeks * 7;
    for (let d = intervalDays; d <= MAX_HORIZON_DAYS; d += intervalDays) {
      dates.push(addDays(startDate, d, tz));
    }
  } else if (
    frequencyType === "monthly" &&
    Number.isInteger(repeatMonths) &&
    (repeatMonths as number) >= 1 &&
    (repeatMonths as number) <= 12
  ) {
    const interval = repeatMonths as number;
    for (let m = interval; m <= MAX_MONTHLY_HORIZON_MONTHS; m += interval) {
      dates.push(addCalendarMonths(startDate, m, tz));
    }
  }

  return dates;
}

export function countFutureOccurrences(
  frequencyType: string,
  repeatWeeks: number,
  tz: string,
  startDate?: Date,
  repeatMonths?: number,
): number {
  if (frequencyType === "one_time" || !frequencyType) return 0;
  return generateFutureDates(startDate ?? new Date(), frequencyType, repeatWeeks, tz, repeatMonths).length;
}

export type RecurrenceGenerationResult =
  | { ok: true; dates: Date[] }
  | { ok: false; error: string };

// Same generation as generateFutureDates, but additionally detects any
// occurrence whose business-local time-of-day drifted from the origin's own
// local hour/minute -- the signature of a generated occurrence silently
// landing on a DST spring-forward gap (Luxon rolls e.g. 2:30 AM forward to
// 3:30 AM rather than marking the result invalid; empirically verified the
// same way lib/timezone.ts's zonedDateTimeToUTC round-trip check was).
//
// Every caller that WRITES appointments (never the count-only preview,
// which uses generateFutureDates/countFutureOccurrences directly) must use
// this instead, and must reject the ENTIRE request -- zero appointment or
// assignment writes -- rather than silently dropping, shifting, or
// partially creating the series.
export function generateFutureDatesSafe(
  startDate: Date,
  frequencyType: string,
  repeatWeeks: number,
  tz: string,
  repeatMonths?: number,
): RecurrenceGenerationResult {
  const dates = generateFutureDates(startDate, frequencyType, repeatWeeks, tz, repeatMonths);
  const origin = DateTime.fromJSDate(startDate).setZone(tz);
  for (const d of dates) {
    const local = DateTime.fromJSDate(d).setZone(tz);
    if (local.hour !== origin.hour || local.minute !== origin.minute) {
      return {
        ok: false,
        error:
          "One or more appointments in this recurring series would fall on a time that doesn't exist due to a daylight-saving change. Please choose another time or frequency.",
      };
    }
  }
  return { ok: true, dates };
}
