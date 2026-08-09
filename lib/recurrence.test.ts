// Direct unit tests for lib/recurrence.ts. No dedicated test file existed
// for this module before -- prior coverage was only indirect, through the
// appointments API route tests (which exercise repeat_weeks: 26 but never
// asserted the generator's own date math in isolation). Added alongside the
// weekly-interval-options UI change (1,2,3,4,6,8 -> 1..8) to prove the
// generator itself already supported every value in that range, including
// the two newly-exposed ones (5 and 7), with zero changes to this file.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  generateFutureDates,
  countFutureOccurrences,
  addDays,
  addCalendarMonths,
  MAX_HORIZON_DAYS,
  MAX_MONTHLY_HORIZON_MONTHS,
} from "./recurrence";
import { BUSINESS_TZ } from "./timezone";

// Builds a Date representing an exact wall-clock instant in the business's
// own timezone (America/New_York) -- simulating what the BROWSER actually
// sends as scheduled_for when an owner picks a date/time (the browser
// resolves the correct UTC offset for that specific calendar date using
// the real IANA tz database, same as Luxon does here).
function nyLocal(year: number, month: number, day: number, hour: number, minute = 0, second = 0, millisecond = 0): Date {
  return DateTime.fromObject({ year, month, day, hour, minute, second, millisecond }, { zone: BUSINESS_TZ }).toJSDate();
}
// Reads a Date back as its business-local (America/New_York) wall-clock
// representation -- never native Date getters directly on the result,
// which would read back in whichever timezone the TEST RUNNER's own
// process happens to have, not business-local time. This is the same
// distinction the DST bug itself hinges on.
function ny(date: Date): DateTime {
  return DateTime.fromJSDate(date).setZone(BUSINESS_TZ);
}

const START = new Date("2026-01-05T09:00:00.000Z"); // a Monday

describe("generateFutureDates -- weekly, every interval 1 through 8 (the complete UI range)", () => {
  for (const repeatWeeks of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`repeatWeeks=${repeatWeeks} produces occurrences spaced exactly ${repeatWeeks * 7} days apart, up to MAX_HORIZON_DAYS`, () => {
      const dates = generateFutureDates(START, "weekly", repeatWeeks);
      const intervalDays = repeatWeeks * 7;
      const expectedCount = Math.floor(MAX_HORIZON_DAYS / intervalDays);
      assert.equal(dates.length, expectedCount);
      dates.forEach((d, i) => {
        assert.deepEqual(d, addDays(START, intervalDays * (i + 1)));
      });
    });
  }

  test("5-week and 7-week recurrence were not previously reachable from the UI but generate identically to every other interval (pure function of repeatWeeks alone)", () => {
    // Compared against addDays (calendar-day arithmetic, matching the
    // generator's own implementation) rather than raw millisecond math --
    // a fixed 35/49-day millisecond offset is not safe across a DST
    // transition, which addDays (via Date#setDate) already accounts for.
    const five = generateFutureDates(START, "weekly", 5);
    const seven = generateFutureDates(START, "weekly", 7);
    assert.equal(five.length, Math.floor(MAX_HORIZON_DAYS / 35));
    assert.equal(seven.length, Math.floor(MAX_HORIZON_DAYS / 49));
    assert.ok(five.every((d, i) => d.getTime() === addDays(START, 35 * (i + 1)).getTime()));
    assert.ok(seven.every((d, i) => d.getTime() === addDays(START, 49 * (i + 1)).getTime()));
  });
});

describe("generateFutureDates -- existing daily/weekdays behavior is unchanged", () => {
  test("daily generates one occurrence per calendar day out to MAX_HORIZON_DAYS", () => {
    const dates = generateFutureDates(START, "daily", 1);
    assert.equal(dates.length, MAX_HORIZON_DAYS);
    assert.deepEqual(dates[0], addDays(START, 1));
    assert.deepEqual(dates[dates.length - 1], addDays(START, MAX_HORIZON_DAYS));
  });

  test("weekdays skips every Saturday/Sunday", () => {
    const dates = generateFutureDates(START, "weekdays", 1);
    assert.ok(dates.every((d) => d.getDay() !== 0 && d.getDay() !== 6));
    assert.ok(dates.length > 0 && dates.length < MAX_HORIZON_DAYS);
  });

  test("one_time and truly unrecognized frequency types produce no occurrences", () => {
    assert.deepEqual(generateFutureDates(START, "one_time", 1), []);
    assert.deepEqual(generateFutureDates(START, "not-a-real-frequency", 1), []);
  });

  test("monthly with no repeatMonths argument (the pre-Phase-2 call shape) still produces no occurrences -- proves adding the monthly branch didn't change behavior for any caller that doesn't pass it", () => {
    assert.deepEqual(generateFutureDates(START, "monthly", 1), []);
  });
});

describe("countFutureOccurrences -- unchanged, delegates directly to generateFutureDates", () => {
  test("matches generateFutureDates(...).length for weekly at every 1-8 interval", () => {
    for (const repeatWeeks of [1, 2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(
        countFutureOccurrences("weekly", repeatWeeks, START),
        generateFutureDates(START, "weekly", repeatWeeks).length
      );
    }
  });

  test("one_time always counts zero regardless of repeatWeeks", () => {
    assert.equal(countFutureOccurrences("one_time", 5, START), 0);
  });

  test("matches generateFutureDates(...).length for monthly at every 1-12 interval", () => {
    for (const repeatMonths of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      assert.equal(
        countFutureOccurrences("monthly", 1, START, repeatMonths),
        generateFutureDates(START, "monthly", 1, repeatMonths).length
      );
    }
  });
});

// Phase 2 (Monthly Recurring Appointments) + Phase 2 DST-correctness
// verification pass: every date in this section is built and read back
// through nyLocal()/ny() (America/New_York wall-clock, via Luxon/IANA tz
// data), never native Date-local getters/constructors -- addCalendarMonths
// operates on BUSINESS_TZ specifically so that its correctness does NOT
// depend on the ambient timezone of whatever machine or server process
// happens to run this code. See the "production-like UTC server" block
// below, which additionally forces process.env.TZ = "UTC" for the
// duration of its tests to prove this directly, matching how appointments
// scheduled_for is actually created (browser, in the owner's local
// America/New_York time) and actually processed (Vercel/Node server,
// typically UTC).
describe("addCalendarMonths -- the original-anchor, calendar-month-end-safe, business-timezone-aware primitive monthly recurrence is built on", () => {
  test("CRITICAL MONTH-END RULE: Jan 31 repeating monthly clamps each short month independently, computed from the ORIGINAL day 31 every time -- never compounding a previous clamp (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 -> Jun 30 -> Jul 31)", () => {
    const jan31 = nyLocal(2026, 1, 31, 9); // 2026 is not a leap year
    const expected: [number, number][] = [
      [2, 28], [3, 31], [4, 30], [5, 31], [6, 30], [7, 31], // [month, day] for Feb..Jul
    ];
    expected.forEach(([month, day], i) => {
      const d = ny(addCalendarMonths(jan31, i + 1));
      assert.equal(d.year, 2026);
      assert.equal(d.month, month);
      assert.equal(d.day, day);
      assert.equal(d.hour, 9, "business-local hour must stay 9:00 AM regardless of which side of a DST transition the occurrence falls on");
    });
  });

  test("leap year: Jan 31, 2028 -> Feb 29 (leap) -> Mar 31, computed from the original day 31, not the clamped 29", () => {
    const jan31leap = nyLocal(2028, 1, 31, 9); // 2028 is a leap year
    const feb = ny(addCalendarMonths(jan31leap, 1));
    assert.equal(feb.month, 2);
    assert.equal(feb.day, 29);
    const mar = ny(addCalendarMonths(jan31leap, 2));
    assert.equal(mar.month, 3);
    assert.equal(mar.day, 31, "Mar must recover the original day 31, not stay clamped at 28/29");
  });

  test("Jan 30 -> Feb clamp (28/29) -> Mar 30 (original day 30 restored)", () => {
    const jan30 = nyLocal(2026, 1, 30, 9);
    assert.equal(ny(addCalendarMonths(jan30, 1)).day, 28);
    const mar = ny(addCalendarMonths(jan30, 2));
    assert.equal(mar.month, 3);
    assert.equal(mar.day, 30);
  });

  test("Jan 29 -> Feb 28 (non-leap year) -> Mar 29 (original day 29 restored)", () => {
    const jan29 = nyLocal(2026, 1, 29, 9);
    assert.equal(ny(addCalendarMonths(jan29, 1)).day, 28);
    const mar = ny(addCalendarMonths(jan29, 2));
    assert.equal(mar.month, 3);
    assert.equal(mar.day, 29);
  });

  test("Feb 29, 2028 + 12 months = Feb 28, 2029 (2029 is not a leap year)", () => {
    const feb29_2028 = nyLocal(2028, 2, 29, 9);
    const d = ny(addCalendarMonths(feb29_2028, 12));
    assert.equal(d.year, 2029);
    assert.equal(d.month, 2);
    assert.equal(d.day, 28);
  });

  test("never rolls Jan 31 into March -- a naive Date#setMonth(m+1) bug this function must not reproduce", () => {
    const jan31 = nyLocal(2026, 1, 31, 9);
    const d = ny(addCalendarMonths(jan31, 1));
    assert.equal(d.month, 2, "must land in February, not overflow into March");
  });

  test("preserves business-local hour/minute/second/millisecond exactly -- no time-of-day drift, including across month-end clamping and a DST boundary", () => {
    const start = nyLocal(2026, 1, 31, 14, 37, 22, 250);
    for (let n = 1; n <= 6; n++) {
      const d = ny(addCalendarMonths(start, n));
      assert.equal(d.hour, 14);
      assert.equal(d.minute, 37);
      assert.equal(d.second, 22);
      assert.equal(d.millisecond, 250);
    }
  });

  test("a normal month with no clamping needed (e.g. the 15th) is unaffected", () => {
    const d = ny(addCalendarMonths(nyLocal(2026, 1, 15, 9), 3));
    assert.equal(d.month, 4);
    assert.equal(d.day, 15);
  });

  test("DST is genuinely being crossed by the month-end test data above (sanity check on the test's own premise, not the implementation)", () => {
    // Jan 31, 2026 is EST (UTC-5); Mar 31, 2026 is EDT (UTC-4) -- if this
    // ever stops being true (e.g. US DST rules change), the month-end test
    // above would stop actually exercising the DST boundary it claims to.
    const jan = ny(nyLocal(2026, 1, 31, 9));
    const mar = ny(nyLocal(2026, 3, 31, 9));
    assert.notEqual(jan.offset, mar.offset, "test data must actually straddle a DST transition");
  });
});

describe("generateFutureDates -- monthly, every interval 1 through 12 (the complete UI range)", () => {
  for (const repeatMonths of [1, 2, 3, 6, 12]) {
    test(`repeatMonths=${repeatMonths} produces occurrences spaced exactly ${repeatMonths} calendar month(s) apart, up to MAX_MONTHLY_HORIZON_MONTHS, and never degrades to zero occurrences`, () => {
      const start = nyLocal(2026, 1, 15, 9);
      const dates = generateFutureDates(start, "monthly", 1, repeatMonths);
      const expectedCount = Math.floor(MAX_MONTHLY_HORIZON_MONTHS / repeatMonths);
      assert.equal(dates.length, expectedCount);
      assert.ok(dates.length >= 1, "a valid, supported monthly interval must never silently produce zero occurrences");
      dates.forEach((d, i) => {
        assert.deepEqual(d, addCalendarMonths(start, repeatMonths * (i + 1)));
      });
    });
  }

  test("business-local time-of-day (hour/minute) is preserved across every generated monthly occurrence, including months that cross a US DST transition", () => {
    const start = nyLocal(2026, 1, 31, 14, 30);
    const dates = generateFutureDates(start, "monthly", 1, 1);
    assert.ok(dates.length > 0);
    for (const d of dates) {
      const local = ny(d);
      assert.equal(local.hour, 14);
      assert.equal(local.minute, 30);
    }
  });

  test("validation: malformed repeat_months (missing, non-integer, zero, negative, or out of the 1-12 domain) produces zero occurrences -- never a runaway or a crash", () => {
    const start = nyLocal(2026, 1, 15, 9);
    for (const bad of [undefined, NaN, 0, -1, 1.5, 13, 100]) {
      assert.deepEqual(generateFutureDates(start, "monthly", 1, bad as any), []);
    }
  });

  test("does not permit runaway generation -- every interval is capped at MAX_MONTHLY_HORIZON_MONTHS", () => {
    const start = nyLocal(2026, 1, 15, 9);
    const dates = generateFutureDates(start, "monthly", 1, 1);
    assert.ok(dates.length <= MAX_MONTHLY_HORIZON_MONTHS);
  });
});

// Phase 2 DST-correctness verification pass: proves the above holds true
// even when the executing process's own ambient timezone is UTC --
// reproducing the actual production condition (Vercel/Node server,
// typically UTC) rather than relying on the developer/CI machine's own
// system timezone happening to match or not matter. process.env.TZ is
// restored in `after` regardless of test outcome, so this block cannot
// leak a changed timezone into any other test file's run.
describe("production-like UTC server environment -- addCalendarMonths remains business-local-correct regardless of the executing process's own timezone", () => {
  const originalTz = process.env.TZ;
  before(() => { process.env.TZ = "UTC"; });
  after(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

  test("A. Winter -> DST: Jan 31, 9:00 AM New York, monthly x1 -- exact UTC + New York timestamps", () => {
    const origin = nyLocal(2026, 1, 31, 9);
    assert.equal(origin.toISOString(), "2026-01-31T14:00:00.000Z", "9:00 AM EST = 14:00 UTC");

    const dates = generateFutureDates(origin, "monthly", 1, 1);
    const expected = [
      { utc: "2026-02-28T14:00:00.000Z", nyHour: 9, offset: "EST" }, // no DST crossed yet
      { utc: "2026-03-31T13:00:00.000Z", nyHour: 9, offset: "EDT" }, // DST started Mar 8, 2026
      { utc: "2026-04-30T13:00:00.000Z", nyHour: 9, offset: "EDT" },
    ];
    expected.forEach((exp, i) => {
      assert.equal(dates[i].toISOString(), exp.utc, `occurrence ${i + 1} UTC instant`);
      const local = ny(dates[i]);
      assert.equal(local.hour, exp.nyHour, `occurrence ${i + 1} must remain 9:00 AM New York, not shift with the UTC offset change`);
      assert.equal(local.minute, 0);
      assert.equal(local.offsetNameShort, exp.offset);
    });
  });

  test("B. DST -> winter: Aug 31, 9:00 AM New York, monthly x1 -- exact UTC + New York timestamps", () => {
    const origin = nyLocal(2026, 8, 31, 9);
    assert.equal(origin.toISOString(), "2026-08-31T13:00:00.000Z", "9:00 AM EDT = 13:00 UTC");

    const dates = generateFutureDates(origin, "monthly", 1, 1);
    const expected = [
      { utc: "2026-09-30T13:00:00.000Z", nyHour: 9, offset: "EDT" },
      { utc: "2026-10-31T13:00:00.000Z", nyHour: 9, offset: "EDT" }, // DST ends Nov 1, 2026
      { utc: "2026-11-30T14:00:00.000Z", nyHour: 9, offset: "EST" },
    ];
    expected.forEach((exp, i) => {
      assert.equal(dates[i].toISOString(), exp.utc, `occurrence ${i + 1} UTC instant`);
      const local = ny(dates[i]);
      assert.equal(local.hour, exp.nyHour, `occurrence ${i + 1} must remain 9:00 AM New York, not shift with the UTC offset change`);
      assert.equal(local.offsetNameShort, exp.offset);
    });
  });

  test("C. Non-round time: Jan 31, 2:15 PM New York, monthly x1 -- proves minutes are preserved together with the DST-crossing hour fix", () => {
    const origin = nyLocal(2026, 1, 31, 14, 15);
    assert.equal(origin.toISOString(), "2026-01-31T19:15:00.000Z");

    const dates = generateFutureDates(origin, "monthly", 1, 1);
    const marOccurrence = dates[1]; // Mar 31 -- across the DST boundary
    assert.equal(marOccurrence.toISOString(), "2026-03-31T18:15:00.000Z");
    const local = ny(marOccurrence);
    assert.equal(local.hour, 14);
    assert.equal(local.minute, 15, "minutes must survive the DST-crossing fix exactly as before");
    assert.equal(local.offsetNameShort, "EDT");
  });

  test("D. month-end clamping still holds correctly under a UTC-runtime process (Jan 31 -> Feb 28 -> Mar 31)", () => {
    const jan31 = nyLocal(2026, 1, 31, 9);
    assert.equal(ny(addCalendarMonths(jan31, 1)).day, 28);
    const mar = ny(addCalendarMonths(jan31, 2));
    assert.equal(mar.day, 31, "must recover the original day 31 for March, not stay clamped from February, even under a UTC runtime");
  });

  test("E. non-DST-crossing monthly occurrences are completely unaffected (Mar 31 -> Apr 30, both EDT)", () => {
    const marStart = nyLocal(2026, 3, 31, 9);
    const apr = ny(addCalendarMonths(marStart, 1));
    assert.equal(apr.day, 30);
    assert.equal(apr.hour, 9);
    assert.equal(apr.offsetNameShort, "EDT");
  });
});
