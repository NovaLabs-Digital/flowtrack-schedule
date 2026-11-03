import { DateTime } from "luxon";
import { stepLocalWallClock } from "./timezone";

// "This & future" rescheduling moves every later occurrence by the same
// change the owner made to the selected one -- measured in the BUSINESS'S
// local calendar and clock, never as a fixed number of elapsed milliseconds.
// A fixed offset is wrong whenever the selected occurrence's old and new
// positions sit on opposite sides of a daylight-saving change: moving
// Fri Mar 12 9:00 AM to Mon Mar 15 9:00 AM is 3 days minus 1 hour of
// elapsed time, and adding that to Fri Apr 9 9:00 AM lands on 8:00 AM.
// Here the same move is "+3 days, same clock time", which lands on
// Mon Apr 12 9:00 AM.
//
// Each later occurrence keeps its OWN clock time plus the clock change, so an
// occurrence that was deliberately at a different time (10:00 among 9:00s)
// stays exactly that far apart.

export type LocalMove = { days: number; minutes: number };

function zoned(iso: string, tz: string): DateTime {
  return DateTime.fromJSDate(new Date(iso)).setZone(tz);
}

// Calendar days and clock minutes between two instants, both read in `tz`.
export function localMoveBetween(fromIso: string, toIso: string, tz: string): LocalMove {
  const a = zoned(fromIso, tz);
  const b = zoned(toIso, tz);
  const dayA = Date.UTC(a.year, a.month - 1, a.day);
  const dayB = Date.UTC(b.year, b.month - 1, b.day);
  return {
    days: Math.round((dayB - dayA) / 86_400_000),
    minutes: b.hour * 60 + b.minute - (a.hour * 60 + a.minute),
  };
}

export type LocalShiftResult =
  | { ok: true; iso: string }
  | { ok: false; reason: "nonexistent_local_time"; local: string };

// Applies `move` to `iso`'s local date and clock time in `tz`, under the one
// DST policy in lib/timezone.ts (a skipped time is refused; a repeated time
// resolves to the earlier one).
export function applyLocalMove(iso: string, move: LocalMove, tz: string): LocalShiftResult {
  const s = zoned(iso, tz);
  const instant = stepLocalWallClock(s, { days: move.days, minutes: move.minutes });
  if (!instant) {
    const target = DateTime.fromObject({ year: s.year, month: s.month, day: s.day, hour: s.hour, minute: s.minute }, { zone: "UTC" })
      .plus({ days: move.days, minutes: move.minutes });
    return { ok: false, reason: "nonexistent_local_time", local: target.toFormat("ccc LLL d, h:mm a") };
  }
  return { ok: true, iso: instant.toUTC().toISO()! };
}
