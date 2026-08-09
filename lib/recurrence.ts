import { DateTime } from "luxon";
import { BUSINESS_TZ } from "@/lib/timezone";

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

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Adds `months` calendar months to `date`, always measured from `date`'s
// OWN day-of-month -- never from a previously clamped result -- so a short
// month never permanently shifts a later occurrence's day. When the target
// month doesn't have `date`'s day (e.g. day 31 in a 30-day month), clamps
// to that month's actual last day; the ORIGINAL day is used again for every
// later occurrence, so Jan 31 + 1 month = Feb 28, but Jan 31 + 2 months is
// computed fresh from day 31 and lands on Mar 31, not Mar 28.
//
// Deliberately does the month-and-clamp arithmetic in BUSINESS_TZ (via
// Luxon), not in whatever local timezone the executing runtime happens to
// have -- `date` is always an absolute instant (its own getDate()/getHours()
// are meaningless without a zone), and appointments.scheduled_for's real
// meaning is a wall-clock time in the business's own timezone
// (America/New_York), which the browser correctly encoded into that UTC
// instant at creation time. Computing this with plain Date-local methods
// instead (as an earlier version of this function did) inherits whatever
// zone the Node process happens to run in -- on a UTC production server
// that means the UTC hour gets preserved across a DST transition instead
// of the business-local hour, silently shifting a 9:00 AM New York
// appointment to 10:00 AM (or 8:00 AM) New York after crossing a DST
// boundary. Luxon resolves the real IANA DST offset for the target
// date/zone, so the business-local wall-clock hour is what's preserved,
// exactly like the existing BUSINESS_TZ-aware helpers in lib/timezone.ts
// and lib/availability.ts already do for "now"/business-hours -- this is a
// Phase 2 correctness fix using the EXISTING global BUSINESS_TZ, not new
// per-workspace Time Zone support (see the same file's docs for the
// boundary between the two).
export function addCalendarMonths(date: Date, months: number): Date {
  return DateTime.fromJSDate(date).setZone(BUSINESS_TZ).plus({ months }).toJSDate();
}

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

// repeatMonths is only consulted when frequencyType === "monthly" -- every
// existing caller/behavior for "daily" | "weekdays" | "weekly" is completely
// unaffected by this parameter's presence, including callers that don't
// pass it at all.
export function generateFutureDates(
  startDate: Date,
  frequencyType: string,
  repeatWeeks: number,
  repeatMonths?: number,
): Date[] {
  const dates: Date[] = [];

  if (frequencyType === "daily") {
    for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
      dates.push(addDays(startDate, d));
    }
  } else if (frequencyType === "weekdays") {
    for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
      const candidate = addDays(startDate, d);
      if (isWeekday(candidate)) {
        dates.push(candidate);
      }
    }
  } else if (frequencyType === "weekly" && repeatWeeks >= 1) {
    const intervalDays = repeatWeeks * 7;
    for (let d = intervalDays; d <= MAX_HORIZON_DAYS; d += intervalDays) {
      dates.push(addDays(startDate, d));
    }
  } else if (
    frequencyType === "monthly" &&
    Number.isInteger(repeatMonths) &&
    (repeatMonths as number) >= 1 &&
    (repeatMonths as number) <= 12
  ) {
    const interval = repeatMonths as number;
    for (let m = interval; m <= MAX_MONTHLY_HORIZON_MONTHS; m += interval) {
      dates.push(addCalendarMonths(startDate, m));
    }
  }

  return dates;
}

export function countFutureOccurrences(
  frequencyType: string,
  repeatWeeks: number,
  startDate?: Date,
  repeatMonths?: number,
): number {
  if (frequencyType === "one_time" || !frequencyType) return 0;
  return generateFutureDates(startDate ?? new Date(), frequencyType, repeatWeeks, repeatMonths).length;
}
