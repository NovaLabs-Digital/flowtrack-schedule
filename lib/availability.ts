import { DateTime } from "luxon";
import { rangesForDate, type BusinessHours } from "@/lib/businessHours";

export const SLOT_MINUTES = 30;

export type BusyRange = { start: Date; end: Date };

// Phase 5D: every timezone-sensitive function below now takes an explicit,
// required `tz` parameter -- the resolved workspace timezone, never the
// global BUSINESS_TZ default. Every caller (public booking availability,
// public appointment creation) must resolve and pass its own trusted
// timezone; there is no compatibility fallback left for this module.

export function todayBusinessDate(tz: string): string {
  return DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");
}

export function businessDateStringFromInstant(d: Date, tz: string): string {
  return DateTime.fromJSDate(d).setZone(tz).toFormat("yyyy-MM-dd");
}

function dayStart(dateStr: string, tz: string): DateTime {
  return DateTime.fromISO(dateStr, { zone: tz }).startOf("day");
}

export function isOpenDay(dateStr: string, hours: BusinessHours, tz: string): boolean {
  return rangesForDate(hours, dateStr, tz).length > 0;
}

// The real UTC instant bounds of a business-local calendar date — use this
// to query appointments by scheduled_for for a given customer-facing date,
// since the stored timestamps are UTC and the business-local day doesn't
// align with the UTC day.
export function businessDayBounds(dateStr: string, tz: string): { start: Date; end: Date } {
  const start = dayStart(dateStr, tz);
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

// All candidate slot start times for a given business-local calendar date,
// at SLOT_MINUTES granularity, that fit the service duration entirely
// within one of the workspace's saved open ranges for that weekday, aren't
// already in the past, and don't overlap any busy range. A slot never
// spans two ranges -- e.g. a split day of 08:00-12:00 / 13:00-17:00 never
// offers a slot crossing the 12:00-13:00 gap.
export function computeAvailableSlots(
  dateStr: string,
  durationMinutes: number,
  busy: BusyRange[],
  hours: BusinessHours,
  tz: string
): string[] {
  const day = dayStart(dateStr, tz);
  if (!day.isValid) return [];

  const ranges = rangesForDate(hours, dateStr, tz);
  const now = DateTime.now().setZone(tz);

  const slots: string[] = [];
  for (const range of ranges) {
    const [openHour, openMinute] = range.start.split(":").map(Number);
    const [closeHour, closeMinute] = range.end.split(":").map(Number);
    const rangeOpen = day.set({ hour: openHour, minute: openMinute });
    const rangeClose = day.set({ hour: closeHour, minute: closeMinute });

    // Defensive DST guard: if this range's open or close boundary itself
    // lands on a local time that doesn't exist that day (a spring-forward
    // gap), Luxon silently rolls it forward rather than marking it invalid
    // (same round-trip detection technique as lib/timezone.ts's
    // zonedDateTimeToUTC). Skip the whole range for that date rather than
    // silently offering a slot at the wrong wall-clock time. A workspace's
    // default hours never span 2-3 AM, so this is expected to never
    // actually trigger in practice, but saved Business Hours aren't
    // otherwise restricted from doing so.
    if (rangeOpen.hour !== openHour || rangeOpen.minute !== openMinute) continue;
    if (rangeClose.hour !== closeHour || rangeClose.minute !== closeMinute) continue;

    let cursor = rangeOpen;
    while (cursor.plus({ minutes: durationMinutes }) <= rangeClose) {
      const slotStart = cursor.toJSDate();
      const slotEnd = cursor.plus({ minutes: durationMinutes }).toJSDate();

      const inPast = cursor <= now;
      const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);

      if (!inPast && !overlaps) slots.push(cursor.toISO()!);
      cursor = cursor.plus({ minutes: SLOT_MINUTES });
    }
  }

  return slots;
}

// Defense-in-depth check for the create route: is this exact start/duration
// actually free, independent of whatever the availability endpoint showed
// the browser (a direct API request can't be trusted to have honored it).
// A pure real-instant overlap check -- no timezone involved.
export function isSlotAvailable(start: Date, end: Date, busy: BusyRange[]): boolean {
  return !busy.some((b) => start < b.end && end > b.start);
}

// True only if [start, end) fits entirely inside a single one of the
// workspace's saved open ranges for start's business-local weekday -- never
// true for a range that starts within hours but crosses into a closed gap
// or past closing.
export function isWithinBusinessHours(start: Date, end: Date, hours: BusinessHours, tz: string): boolean {
  const s = DateTime.fromJSDate(start).setZone(tz);
  const e = DateTime.fromJSDate(end).setZone(tz);
  if (!s.isValid || !e.isValid) return false;

  const dateStr = s.toFormat("yyyy-MM-dd");
  const ranges = rangesForDate(hours, dateStr, tz);

  return ranges.some((range) => {
    const [openHour, openMinute] = range.start.split(":").map(Number);
    const [closeHour, closeMinute] = range.end.split(":").map(Number);
    const rangeOpen = s.startOf("day").set({ hour: openHour, minute: openMinute });
    const rangeClose = s.startOf("day").set({ hour: closeHour, minute: closeMinute });
    return s >= rangeOpen && e <= rangeClose;
  });
}
