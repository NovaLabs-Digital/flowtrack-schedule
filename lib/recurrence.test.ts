// Direct unit tests for lib/recurrence.ts. No dedicated test file existed
// for this module before -- prior coverage was only indirect, through the
// appointments API route tests (which exercise repeat_weeks: 26 but never
// asserted the generator's own date math in isolation). Added alongside the
// weekly-interval-options UI change (1,2,3,4,6,8 -> 1..8) to prove the
// generator itself already supported every value in that range, including
// the two newly-exposed ones (5 and 7), with zero changes to this file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateFutureDates, countFutureOccurrences, addDays, MAX_HORIZON_DAYS } from "./recurrence";

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

  test("one_time and unrecognized frequency types produce no occurrences", () => {
    assert.deepEqual(generateFutureDates(START, "one_time", 1), []);
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
});
