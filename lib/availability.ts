import { DateTime } from "luxon";
import { BUSINESS_TZ } from "@/lib/timezone";

// v1 defaults for Public Booking. There is no per-business hours schema yet
// — adding one is a database change, deliberately deferred to a future
// sprint rather than done here. These match the same Monday-Friday /
// 7:00 AM-5:00 PM values already shown as the (currently preview-only)
// Business Hours default in Settings, so the number shown to customers
// matches the number shown to the owner.
export const BUSINESS_OPEN_HOUR = 7; // 7:00 AM
export const BUSINESS_CLOSE_HOUR = 17; // 5:00 PM
export const SLOT_MINUTES = 30;
const OPEN_WEEKDAYS = new Set([1, 2, 3, 4, 5]); // Luxon weekday: 1=Mon..7=Sun

export type BusyRange = { start: Date; end: Date };

export function todayBusinessDate(): string {
  return DateTime.now().setZone(BUSINESS_TZ).toFormat("yyyy-MM-dd");
}

export function businessDateStringFromInstant(d: Date): string {
  return DateTime.fromJSDate(d).setZone(BUSINESS_TZ).toFormat("yyyy-MM-dd");
}

function dayStart(dateStr: string): DateTime {
  return DateTime.fromISO(dateStr, { zone: BUSINESS_TZ }).startOf("day");
}

export function isOpenDay(dateStr: string): boolean {
  const d = dayStart(dateStr);
  return d.isValid && OPEN_WEEKDAYS.has(d.weekday);
}

// The real UTC instant bounds of a business-local calendar date — use this
// to query appointments by scheduled_for for a given customer-facing date,
// since the stored timestamps are UTC and the business-local day doesn't
// align with the UTC day.
export function businessDayBounds(dateStr: string): { start: Date; end: Date } {
  const start = dayStart(dateStr);
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

// All candidate slot start times for a given business-local calendar date,
// at SLOT_MINUTES granularity, that fit the given service duration before
// closing, aren't already in the past, and don't overlap any busy range.
export function computeAvailableSlots(
  dateStr: string,
  durationMinutes: number,
  busy: BusyRange[]
): string[] {
  if (!isOpenDay(dateStr)) return [];

  const day = dayStart(dateStr);
  if (!day.isValid) return [];

  const closeTime = day.set({ hour: BUSINESS_CLOSE_HOUR });
  const now = DateTime.now().setZone(BUSINESS_TZ);

  const slots: string[] = [];
  let cursor = day.set({ hour: BUSINESS_OPEN_HOUR });

  while (cursor.plus({ minutes: durationMinutes }) <= closeTime) {
    const slotStart = cursor.toJSDate();
    const slotEnd = cursor.plus({ minutes: durationMinutes }).toJSDate();

    const inPast = cursor <= now;
    const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);

    if (!inPast && !overlaps) slots.push(cursor.toISO()!);
    cursor = cursor.plus({ minutes: SLOT_MINUTES });
  }

  return slots;
}

// Defense-in-depth check for the create route: is this exact start/duration
// actually free, independent of whatever the availability endpoint showed
// the browser (a direct API request can't be trusted to have honored it).
export function isSlotAvailable(start: Date, end: Date, busy: BusyRange[]): boolean {
  return !busy.some((b) => start < b.end && end > b.start);
}

export function isWithinBusinessHours(start: Date, end: Date): boolean {
  const s = DateTime.fromJSDate(start).setZone(BUSINESS_TZ);
  const e = DateTime.fromJSDate(end).setZone(BUSINESS_TZ);
  if (!s.isValid || !e.isValid || !OPEN_WEEKDAYS.has(s.weekday)) return false;
  const dayOpen = s.startOf("day").set({ hour: BUSINESS_OPEN_HOUR });
  const dayClose = s.startOf("day").set({ hour: BUSINESS_CLOSE_HOUR });
  return s >= dayOpen && e <= dayClose;
}
