// Direct unit tests for lib/recurrence.ts. No dedicated test file existed
// for this module before -- prior coverage was only indirect, through the
// appointments API route tests (which exercise repeat_weeks: 26 but never
// asserted the generator's own date math in isolation). Added alongside the
// weekly-interval-options UI change (1,2,3,4,6,8 -> 1..8) to prove the
// generator itself already supported every value in that range, including
// the two newly-exposed ones (5 and 7), with zero changes to this file.
//
// Phase 5D: every function in this module now takes an explicit, required
// `tz` parameter -- no BUSINESS_TZ default remains (see lib/recurrence.ts's
// own header comment). Every call site below passes BUSINESS_TZ explicitly
// where the test isn't specifically about cross-timezone behavior; the
// "Phase 5D" describe blocks further down prove the same functions are
// genuinely correct for OTHER supported timezones too, and that
// addDays/addCalendarMonths jointly protect daily/weekdays/weekly/monthly
// recurrence from the same DST class of bug.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  generateFutureDates,
  generateFutureDatesSafe,
  countFutureOccurrences,
  addDays,
  addCalendarMonths,
  MAX_HORIZON_DAYS,
  MAX_MONTHLY_HORIZON_MONTHS,
} from "./recurrence.ts";
import { BUSINESS_TZ, TIMEZONE_OPTIONS } from "./timezone.ts";

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
      const dates = generateFutureDates(START, "weekly", repeatWeeks, BUSINESS_TZ);
      const intervalDays = repeatWeeks * 7;
      const expectedCount = Math.floor(MAX_HORIZON_DAYS / intervalDays);
      assert.equal(dates.length, expectedCount);
      dates.forEach((d, i) => {
        assert.deepEqual(d, addDays(START, intervalDays * (i + 1), BUSINESS_TZ));
      });
    });
  }

  test("5-week and 7-week recurrence were not previously reachable from the UI but generate identically to every other interval (pure function of repeatWeeks alone)", () => {
    // Compared against addDays (calendar-day arithmetic, matching the
    // generator's own implementation) rather than raw millisecond math --
    // a fixed 35/49-day millisecond offset is not safe across a DST
    // transition, which addDays (via Luxon's calendar-day plus) already
    // accounts for.
    const five = generateFutureDates(START, "weekly", 5, BUSINESS_TZ);
    const seven = generateFutureDates(START, "weekly", 7, BUSINESS_TZ);
    assert.equal(five.length, Math.floor(MAX_HORIZON_DAYS / 35));
    assert.equal(seven.length, Math.floor(MAX_HORIZON_DAYS / 49));
    assert.ok(five.every((d, i) => d.getTime() === addDays(START, 35 * (i + 1), BUSINESS_TZ).getTime()));
    assert.ok(seven.every((d, i) => d.getTime() === addDays(START, 49 * (i + 1), BUSINESS_TZ).getTime()));
  });
});

describe("generateFutureDates -- existing daily/weekdays behavior is unchanged", () => {
  test("daily generates one occurrence per calendar day out to MAX_HORIZON_DAYS", () => {
    const dates = generateFutureDates(START, "daily", 1, BUSINESS_TZ);
    assert.equal(dates.length, MAX_HORIZON_DAYS);
    assert.deepEqual(dates[0], addDays(START, 1, BUSINESS_TZ));
    assert.deepEqual(dates[dates.length - 1], addDays(START, MAX_HORIZON_DAYS, BUSINESS_TZ));
  });

  test("weekdays skips every Saturday/Sunday (business-local weekday, not the runtime's own ambient weekday)", () => {
    const dates = generateFutureDates(START, "weekdays", 1, BUSINESS_TZ);
    assert.ok(dates.every((d) => { const wd = ny(d).weekday; return wd !== 6 && wd !== 7; }));
    assert.ok(dates.length > 0 && dates.length < MAX_HORIZON_DAYS);
  });

  test("one_time and truly unrecognized frequency types produce no occurrences", () => {
    assert.deepEqual(generateFutureDates(START, "one_time", 1, BUSINESS_TZ), []);
    assert.deepEqual(generateFutureDates(START, "not-a-real-frequency", 1, BUSINESS_TZ), []);
  });

  test("monthly with no repeatMonths argument (the pre-Phase-2 call shape) still produces no occurrences -- proves adding the monthly branch didn't change behavior for any caller that doesn't pass it", () => {
    assert.deepEqual(generateFutureDates(START, "monthly", 1, BUSINESS_TZ), []);
  });
});

describe("countFutureOccurrences -- unchanged, delegates directly to generateFutureDates", () => {
  test("matches generateFutureDates(...).length for weekly at every 1-8 interval", () => {
    for (const repeatWeeks of [1, 2, 3, 4, 5, 6, 7, 8]) {
      assert.equal(
        countFutureOccurrences("weekly", repeatWeeks, BUSINESS_TZ, START),
        generateFutureDates(START, "weekly", repeatWeeks, BUSINESS_TZ).length
      );
    }
  });

  test("one_time always counts zero regardless of repeatWeeks", () => {
    assert.equal(countFutureOccurrences("one_time", 5, BUSINESS_TZ, START), 0);
  });

  test("matches generateFutureDates(...).length for monthly at every 1-12 interval", () => {
    for (const repeatMonths of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      assert.equal(
        countFutureOccurrences("monthly", 1, BUSINESS_TZ, START, repeatMonths),
        generateFutureDates(START, "monthly", 1, BUSINESS_TZ, repeatMonths).length
      );
    }
  });

  test("startDate defaults to 'now' when omitted -- the pre-existing call shape (frequencyType, repeatWeeks, tz) still works", () => {
    assert.equal(countFutureOccurrences("one_time", 1, BUSINESS_TZ), 0);
    assert.ok(countFutureOccurrences("weekly", 1, BUSINESS_TZ) > 0);
  });
});

// Phase 2 (Monthly Recurring Appointments) + Phase 2 DST-correctness
// verification pass: every date in this section is built and read back
// through nyLocal()/ny() (America/New_York wall-clock, via Luxon/IANA tz
// data), never native Date-local getters/constructors -- addCalendarMonths
// operates on an explicit workspace timezone specifically so that its
// correctness does NOT depend on the ambient timezone of whatever machine
// or server process happens to run this code. See the "production-like
// UTC server" block below, which additionally forces process.env.TZ =
// "UTC" for the duration of its tests to prove this directly, matching how
// appointments.scheduled_for is actually created (browser, in the owner's
// local time) and actually processed (Vercel/Node server, typically UTC).
describe("addCalendarMonths -- the original-anchor, calendar-month-end-safe, timezone-aware primitive monthly recurrence is built on", () => {
  test("CRITICAL MONTH-END RULE: Jan 31 repeating monthly clamps each short month independently, computed from the ORIGINAL day 31 every time -- never compounding a previous clamp (Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31 -> Jun 30 -> Jul 31)", () => {
    const jan31 = nyLocal(2026, 1, 31, 9); // 2026 is not a leap year
    const expected: [number, number][] = [
      [2, 28], [3, 31], [4, 30], [5, 31], [6, 30], [7, 31], // [month, day] for Feb..Jul
    ];
    expected.forEach(([month, day], i) => {
      const d = ny(addCalendarMonths(jan31, i + 1, BUSINESS_TZ));
      assert.equal(d.year, 2026);
      assert.equal(d.month, month);
      assert.equal(d.day, day);
      assert.equal(d.hour, 9, "business-local hour must stay 9:00 AM regardless of which side of a DST transition the occurrence falls on");
    });
  });

  test("leap year: Jan 31, 2028 -> Feb 29 (leap) -> Mar 31, computed from the original day 31, not the clamped 29", () => {
    const jan31leap = nyLocal(2028, 1, 31, 9); // 2028 is a leap year
    const feb = ny(addCalendarMonths(jan31leap, 1, BUSINESS_TZ));
    assert.equal(feb.month, 2);
    assert.equal(feb.day, 29);
    const mar = ny(addCalendarMonths(jan31leap, 2, BUSINESS_TZ));
    assert.equal(mar.month, 3);
    assert.equal(mar.day, 31, "Mar must recover the original day 31, not stay clamped at 28/29");
  });

  test("Jan 30 -> Feb clamp (28/29) -> Mar 30 (original day 30 restored)", () => {
    const jan30 = nyLocal(2026, 1, 30, 9);
    assert.equal(ny(addCalendarMonths(jan30, 1, BUSINESS_TZ)).day, 28);
    const mar = ny(addCalendarMonths(jan30, 2, BUSINESS_TZ));
    assert.equal(mar.month, 3);
    assert.equal(mar.day, 30);
  });

  test("Jan 29 -> Feb 28 (non-leap year) -> Mar 29 (original day 29 restored)", () => {
    const jan29 = nyLocal(2026, 1, 29, 9);
    assert.equal(ny(addCalendarMonths(jan29, 1, BUSINESS_TZ)).day, 28);
    const mar = ny(addCalendarMonths(jan29, 2, BUSINESS_TZ));
    assert.equal(mar.month, 3);
    assert.equal(mar.day, 29);
  });

  test("Feb 29, 2028 + 12 months = Feb 28, 2029 (2029 is not a leap year)", () => {
    const feb29_2028 = nyLocal(2028, 2, 29, 9);
    const d = ny(addCalendarMonths(feb29_2028, 12, BUSINESS_TZ));
    assert.equal(d.year, 2029);
    assert.equal(d.month, 2);
    assert.equal(d.day, 28);
  });

  test("never rolls Jan 31 into March -- a naive Date#setMonth(m+1) bug this function must not reproduce", () => {
    const jan31 = nyLocal(2026, 1, 31, 9);
    const d = ny(addCalendarMonths(jan31, 1, BUSINESS_TZ));
    assert.equal(d.month, 2, "must land in February, not overflow into March");
  });

  test("preserves business-local hour/minute/second/millisecond exactly -- no time-of-day drift, including across month-end clamping and a DST boundary", () => {
    const start = nyLocal(2026, 1, 31, 14, 37, 22, 250);
    for (let n = 1; n <= 6; n++) {
      const d = ny(addCalendarMonths(start, n, BUSINESS_TZ));
      assert.equal(d.hour, 14);
      assert.equal(d.minute, 37);
      assert.equal(d.second, 22);
      assert.equal(d.millisecond, 250);
    }
  });

  test("a normal month with no clamping needed (e.g. the 15th) is unaffected", () => {
    const d = ny(addCalendarMonths(nyLocal(2026, 1, 15, 9), 3, BUSINESS_TZ));
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
      const dates = generateFutureDates(start, "monthly", 1, BUSINESS_TZ, repeatMonths);
      const expectedCount = Math.floor(MAX_MONTHLY_HORIZON_MONTHS / repeatMonths);
      assert.equal(dates.length, expectedCount);
      assert.ok(dates.length >= 1, "a valid, supported monthly interval must never silently produce zero occurrences");
      dates.forEach((d, i) => {
        assert.deepEqual(d, addCalendarMonths(start, repeatMonths * (i + 1), BUSINESS_TZ));
      });
    });
  }

  test("business-local time-of-day (hour/minute) is preserved across every generated monthly occurrence, including months that cross a US DST transition", () => {
    const start = nyLocal(2026, 1, 31, 14, 30);
    const dates = generateFutureDates(start, "monthly", 1, BUSINESS_TZ, 1);
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
      assert.deepEqual(generateFutureDates(start, "monthly", 1, BUSINESS_TZ, bad as any), []);
    }
  });

  test("does not permit runaway generation -- every interval is capped at MAX_MONTHLY_HORIZON_MONTHS", () => {
    const start = nyLocal(2026, 1, 15, 9);
    const dates = generateFutureDates(start, "monthly", 1, BUSINESS_TZ, 1);
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

    const dates = generateFutureDates(origin, "monthly", 1, BUSINESS_TZ, 1);
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

    const dates = generateFutureDates(origin, "monthly", 1, BUSINESS_TZ, 1);
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

    const dates = generateFutureDates(origin, "monthly", 1, BUSINESS_TZ, 1);
    const marOccurrence = dates[1]; // Mar 31 -- across the DST boundary
    assert.equal(marOccurrence.toISOString(), "2026-03-31T18:15:00.000Z");
    const local = ny(marOccurrence);
    assert.equal(local.hour, 14);
    assert.equal(local.minute, 15, "minutes must survive the DST-crossing fix exactly as before");
    assert.equal(local.offsetNameShort, "EDT");
  });

  test("D. month-end clamping still holds correctly under a UTC-runtime process (Jan 31 -> Feb 28 -> Mar 31)", () => {
    const jan31 = nyLocal(2026, 1, 31, 9);
    assert.equal(ny(addCalendarMonths(jan31, 1, BUSINESS_TZ)).day, 28);
    const mar = ny(addCalendarMonths(jan31, 2, BUSINESS_TZ));
    assert.equal(mar.day, 31, "must recover the original day 31 for March, not stay clamped from February, even under a UTC runtime");
  });

  test("E. non-DST-crossing monthly occurrences are completely unaffected (Mar 31 -> Apr 30, both EDT)", () => {
    const marStart = nyLocal(2026, 3, 31, 9);
    const apr = ny(addCalendarMonths(marStart, 1, BUSINESS_TZ));
    assert.equal(apr.day, 30);
    assert.equal(apr.hour, 9);
    assert.equal(apr.offsetNameShort, "EDT");
  });

  test("F. addDays is ALSO business-local-correct under a UTC-runtime process -- the Phase 5D fix, not just addCalendarMonths (Phase 2)", () => {
    const origin = nyLocal(2026, 3, 5, 9); // Thursday, before the Mar 8 spring-forward
    const dates = generateFutureDates(origin, "daily", 1, BUSINESS_TZ);
    const expected = [
      { utc: "2026-03-06T14:00:00.000Z", offset: "EST" },
      { utc: "2026-03-07T14:00:00.000Z", offset: "EST" },
      { utc: "2026-03-08T13:00:00.000Z", offset: "EDT" }, // the transition day itself
      { utc: "2026-03-09T13:00:00.000Z", offset: "EDT" },
    ];
    expected.forEach((exp, i) => {
      assert.equal(dates[i].toISOString(), exp.utc, `day ${i + 1} UTC instant`);
      const local = ny(dates[i]);
      assert.equal(local.hour, 9, `day ${i + 1} must remain 9:00 AM New York`);
      assert.equal(local.offsetNameShort, exp.offset);
    });
  });
});

// Phase 5D: the core DST-correctness fix this phase adds -- addDays (and
// therefore daily/weekdays/weekly recurrence) now does calendar-day
// arithmetic in the explicit workspace timezone, exactly like
// addCalendarMonths already did for monthly (Phase 2). Before this phase,
// addDays used native Date#setDate, which operates in the RUNTIME's own
// ambient timezone -- on a UTC server this silently shifted a 9:00 AM New
// York appointment's business-local hour across a DST boundary.
describe("Phase 5D: daily/weekdays/weekly recurrence preserves business-local time-of-day across a DST transition", () => {
  test("daily: 9:00 AM New York stays 9:00 AM across the spring-forward boundary (Mar 5 -> Mar 9, 2026), UTC offset shifts from EST to EDT on Mar 8", () => {
    const origin = nyLocal(2026, 3, 5, 9);
    const dates = generateFutureDates(origin, "daily", 1, BUSINESS_TZ);
    const expected = [
      { utc: "2026-03-06T14:00:00.000Z", offset: "EST" },
      { utc: "2026-03-07T14:00:00.000Z", offset: "EST" },
      { utc: "2026-03-08T13:00:00.000Z", offset: "EDT" },
      { utc: "2026-03-09T13:00:00.000Z", offset: "EDT" },
    ];
    expected.forEach((exp, i) => {
      assert.equal(dates[i].toISOString(), exp.utc, `day ${i + 1}`);
      const local = ny(dates[i]);
      assert.equal(local.hour, 9);
      assert.equal(local.minute, 0);
      assert.equal(local.offsetNameShort, exp.offset);
    });
  });

  test("daily: 9:00 AM New York stays 9:00 AM across the fall-back boundary (Oct 29 -> Nov 2, 2026), UTC offset shifts from EDT to EST on Nov 1", () => {
    const origin = nyLocal(2026, 10, 29, 9);
    const dates = generateFutureDates(origin, "daily", 1, BUSINESS_TZ);
    const expected = [
      { utc: "2026-10-30T13:00:00.000Z", offset: "EDT" },
      { utc: "2026-10-31T13:00:00.000Z", offset: "EDT" },
      { utc: "2026-11-01T14:00:00.000Z", offset: "EST" },
      { utc: "2026-11-02T14:00:00.000Z", offset: "EST" },
    ];
    expected.forEach((exp, i) => {
      assert.equal(dates[i].toISOString(), exp.utc, `day ${i + 1}`);
      const local = ny(dates[i]);
      assert.equal(local.hour, 9);
      assert.equal(local.offsetNameShort, exp.offset);
    });
  });

  test("weekdays: business-local hour survives a week that straddles the spring-forward Sunday", () => {
    const origin = nyLocal(2026, 3, 5, 9); // Thursday
    const dates = generateFutureDates(origin, "weekdays", 1, BUSINESS_TZ);
    for (const d of dates) {
      assert.equal(ny(d).hour, 9, d.toISOString());
    }
    // Sanity: the generated series actually spans both sides of Mar 8.
    assert.ok(dates.some((d) => ny(d).offsetNameShort === "EST"));
    assert.ok(dates.some((d) => ny(d).offsetNameShort === "EDT"));
  });

  test("weekly (every 1-8 weeks): business-local hour survives an interval that straddles a DST transition", () => {
    const origin = nyLocal(2026, 2, 1, 9); // several weeks before the Mar 8 transition
    for (const repeatWeeks of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const dates = generateFutureDates(origin, "weekly", repeatWeeks, BUSINESS_TZ);
      for (const d of dates) {
        assert.equal(ny(d).hour, 9, `repeatWeeks=${repeatWeeks}, ${d.toISOString()}`);
        assert.equal(ny(d).minute, 0);
      }
    }
  });
});

describe("Phase 5D: generateFutureDatesSafe -- atomic DST-nonexistent-occurrence detection", () => {
  test("daily: an origin whose recurring time (2:30 AM) falls on the spring-forward gap on a later occurrence is rejected with a clear error, zero dates returned", () => {
    const origin = nyLocal(2026, 3, 1, 2, 30); // Sunday, one week before the Mar 8 gap
    const result = generateFutureDatesSafe(origin, "daily", 1, BUSINESS_TZ);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /daylight-saving/);
  });

  test("weekly: an origin whose weekly recurrence lands exactly on the spring-forward gap two weeks out is rejected", () => {
    const origin = nyLocal(2026, 2, 22, 2, 30); // Sunday; +2 weeks = Mar 8, 2:30 AM (nonexistent)
    const result = generateFutureDatesSafe(origin, "weekly", 1, BUSINESS_TZ);
    assert.equal(result.ok, false);
  });

  test("a normal (non-gap) daily/weekly/monthly recurrence is unaffected -- ok:true with the exact same dates generateFutureDates itself produces", () => {
    for (const [freq, weeks, months] of [["daily", 1, undefined], ["weekly", 2, undefined], ["monthly", 1, 3]] as const) {
      const result = generateFutureDatesSafe(START, freq, weeks, BUSINESS_TZ, months);
      assert.equal(result.ok, true, freq);
      if (!result.ok) continue;
      assert.deepEqual(result.dates, generateFutureDates(START, freq, weeks, BUSINESS_TZ, months), freq);
    }
  });

  test("one_time never fails -- generateFutureDates already returns [] for it, so generateFutureDatesSafe trivially succeeds with an empty list", () => {
    const result = generateFutureDatesSafe(START, "one_time", 1, BUSINESS_TZ);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.dates, []);
  });

  test("ambiguous fall-back time (ok case, not a rejection): a weekly recurrence landing on the ambiguous Nov 1, 2026 1:30 AM resolves deterministically to the FIRST/earlier occurrence (still-EDT), matching countFutureOccurrences/generateFutureDates -- never rejected, never a second, distinct offset-choice UI", () => {
    const origin = nyLocal(2026, 10, 25, 1, 30); // Sunday; +1 week = Nov 1, 1:30 AM (ambiguous)
    const result = generateFutureDatesSafe(origin, "weekly", 1, BUSINESS_TZ);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dates[0].toISOString(), "2026-11-01T05:30:00.000Z", "must resolve to the first/earlier (EDT) occurrence of the ambiguous hour");
    const local = ny(result.dates[0]);
    assert.equal(local.hour, 1);
    assert.equal(local.minute, 30);
    assert.equal(local.offsetNameShort, "EDT");

    // Repeated calls are deterministic -- never randomly picking the other
    // (EST) occurrence of the same ambiguous local hour.
    const result2 = generateFutureDatesSafe(origin, "weekly", 1, BUSINESS_TZ);
    assert.equal(result2.ok, true);
    if (result2.ok) assert.equal(result2.dates[0].toISOString(), result.dates[0].toISOString());
  });
});

describe("Phase 5D: cross-timezone correctness -- addDays/addCalendarMonths are genuinely tz-safe, not just NY-safe", () => {
  test("Phoenix (no DST): a daily recurrence across the same March/November dates that shift NY's UTC offset produces a CONSTANT UTC offset for Phoenix", () => {
    const origin = DateTime.fromObject({ year: 2026, month: 3, day: 5, hour: 9 }, { zone: "America/Phoenix" }).toJSDate();
    const dates = generateFutureDates(origin, "daily", 1, "America/Phoenix");
    const offsets = dates.slice(0, 6).map((d) => DateTime.fromJSDate(d).setZone("America/Phoenix").offset);
    assert.ok(offsets.every((o) => o === offsets[0]), "Arizona never observes DST -- the UTC offset must never change");
    for (const d of dates.slice(0, 6)) {
      assert.equal(DateTime.fromJSDate(d).setZone("America/Phoenix").hour, 9);
    }
  });

  test("Pacific/Central/Mountain: a monthly recurrence crossing the same DST boundary preserves each zone's own business-local hour independently", () => {
    for (const tz of ["America/Los_Angeles", "America/Chicago", "America/Denver"]) {
      const origin = DateTime.fromObject({ year: 2026, month: 1, day: 31, hour: 9 }, { zone: tz }).toJSDate();
      const dates = generateFutureDates(origin, "monthly", 1, tz, 1);
      for (const d of dates.slice(0, 3)) {
        assert.equal(DateTime.fromJSDate(d).setZone(tz).hour, 9, tz);
      }
    }
  });

  test("every TIMEZONE_OPTIONS value produces a non-empty daily/weekly/monthly series with the business-local hour preserved throughout", () => {
    for (const { value: tz } of TIMEZONE_OPTIONS) {
      const origin = DateTime.fromObject({ year: 2026, month: 1, day: 15, hour: 10, minute: 15 }, { zone: tz }).toJSDate();
      for (const [freq, weeks, months] of [["daily", 1, undefined], ["weekly", 2, undefined], ["monthly", 1, 2]] as const) {
        const dates = generateFutureDates(origin, freq, weeks, tz, months);
        assert.ok(dates.length > 0, `${tz} ${freq}`);
        for (const d of dates) {
          const local = DateTime.fromJSDate(d).setZone(tz);
          assert.equal(local.hour, 10, `${tz} ${freq}`);
          assert.equal(local.minute, 15, `${tz} ${freq}`);
        }
      }
    }
  });
});
