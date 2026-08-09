// Phase 3 (Month Calendar View): pure, framework-agnostic calendar-math and
// appointment-grouping helpers behind ScheduleMonthGrid.tsx. Kept out of the
// .tsx component specifically so they can be unit-tested directly with real
// function calls -- ScheduleMonthGrid.tsx itself is a .tsx file and (like
// every other dashboard component in this repo) cannot be loaded by Node's
// built-in test runner, so its own test file is limited to source-level
// string/regex proof. This module carries the actual calendar arithmetic
// and gets real, executable test coverage instead.
import type { Appointment } from "@/app/components/dashboard/types";

export type MonthGridDay = {
  date: Date;
  inCurrentMonth: boolean;
};

// Monday=0 .. Sunday=6, converted from JS Date#getDay()'s Sunday=0..Saturday=6.
function mondayIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

function addDaysPure(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// True calendar-month arithmetic for Prev/Next/Today navigation -- never an
// approximated 30-day shift. Always anchored to day 1 of the target month,
// so there is no day-of-month clamping ambiguity to resolve (unlike
// appointment-instant month arithmetic, this never needs to preserve a
// specific day or time-of-day, only a month identity) -- JS's Date
// constructor already normalizes an out-of-range month index correctly
// (month 12 -> next January, month -1 -> previous December).
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

// Builds the calendar grid for (year, month) as complete Monday-start weeks
// -- exactly enough rows (4, 5, or 6, whatever the month actually needs) to
// contain every day of the month, including the adjacent-month leading/
// trailing days required to complete the first and last week.
export function buildMonthGrid(year: number, month: number): MonthGridDay[][] {
  const firstOfMonth = new Date(year, month, 1);
  const firstGridDay = addDaysPure(firstOfMonth, -mondayIndex(firstOfMonth.getDay()));

  const lastOfMonth = new Date(year, month + 1, 0); // day 0 of next month = last day of this month
  const lastGridDay = addDaysPure(lastOfMonth, 6 - mondayIndex(lastOfMonth.getDay()));

  const totalDays = Math.round((lastGridDay.getTime() - firstGridDay.getTime()) / 86_400_000) + 1;

  const allDays: MonthGridDay[] = [];
  for (let i = 0; i < totalDays; i++) {
    const date = addDaysPure(firstGridDay, i);
    allDays.push({ date, inCurrentMonth: date.getMonth() === month && date.getFullYear() === year });
  }

  const weeks: MonthGridDay[][] = [];
  for (let i = 0; i < allDays.length; i += 7) {
    weeks.push(allDays.slice(i, i + 7));
  }
  return weeks;
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatMonthYear(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Groups non-cancelled appointments by their business-local calendar date,
// ordered chronologically within each day -- mirrors ScheduleGrid.tsx's own
// existing visibility rule exactly (cancelled appointments are excluded from
// every schedule view, not just the hourly grid) and its own day-bucketing
// convention (toBusinessLocal, not a raw/UTC date read). `localize` is
// injected (rather than importing toBusinessLocal directly) so this pure
// module has no dependency on lib/timezone.ts's Luxon/business-tz machinery
// and stays trivially testable with plain local Dates.
export function groupAppointmentsByDate(
  appointments: Appointment[],
  localize: (iso: string) => Date
): Map<string, Appointment[]> {
  const byDate = new Map<string, Appointment[]>();
  for (const a of appointments) {
    if (a.status === "cancelled") continue;
    const key = dateKey(localize(a.scheduled_for));
    const list = byDate.get(key);
    if (list) list.push(a);
    else byDate.set(key, [a]);
  }
  for (const list of byDate.values()) {
    list.sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());
  }
  return byDate;
}

// Compact time label for a Month-view appointment chip -- matches the
// approved mockup exactly ("9:00 Judy – Regular", "1:00 Tami – Regular"):
// 12-hour, always includes minutes (even :00), no AM/PM suffix. Distinct
// from ScheduleGrid.tsx's own formatTime (which drops a :00 minute and
// keeps AM/PM) -- that format is for the hourly grid's larger cards, not
// this compact overview chip, so this is a deliberate second formatter, not
// a duplicate of the first.
export function formatChipTime(d: Date): string {
  const h12 = d.getHours() % 12 || 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The small, consistent maximum number of appointment chips shown per day
// cell before collapsing the rest into a "+N more" indicator -- Month view
// is an overview, not a place to display every detail of a heavily-booked
// day (see the approved Phase 3 spec).
export const MAX_VISIBLE_CHIPS_PER_DAY = 3;
