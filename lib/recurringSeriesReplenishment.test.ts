// Direct unit tests for lib/recurringSeriesReplenishment.ts (Block 2C-2A).
// This module is pure calendar/timezone math with no Supabase/env/React
// dependency, so every test here calls generateOccurrencesInWindow()
// directly -- no fixtures, no fake Supabase client, nothing async.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import {
  generateOccurrencesInWindow,
  generateOccurrencesInWindowWithDiagnostics,
  DEFENSIVE_ITERATION_CEILING,
  type GenerateOccurrencesInWindowParams,
  type GenerateOccurrencesResult,
  type GenerateOccurrencesFailureReason,
} from "./recurringSeriesReplenishment.ts";
import { TIMEZONE_OPTIONS } from "./timezone.ts";

// Constructs the exact UTC ISO instant for a given local wall-clock
// date/time in `tz`, via Luxon directly -- used to build both inputs
// (after/through) and expected outputs without ever hand-computing a UTC
// offset by hand (which would be a real source of test-authoring error
// across a DST boundary).
function isoAt(year: number, month: number, day: number, hour: number, minute: number, tz: string): string {
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone: tz });
  assert.equal(dt.isValid, true, `test premise invalid: ${year}-${month}-${day} ${hour}:${minute} in ${tz}`);
  return dt.toUTC().toISO()!;
}

// Like isoAt, but for a date reached by adding `days` to a base calendar
// date -- needed whenever the target day-of-month could legitimately roll
// past the end of its starting month (fromObject does NOT roll over; it
// simply rejects an out-of-range day, e.g. day 68 in January).
function isoAtPlusDays(year: number, month: number, day: number, days: number, hour: number, minute: number, tz: string): string {
  const base = DateTime.fromObject({ year, month, day }, { zone: tz });
  assert.equal(base.isValid, true, `test premise invalid base date: ${year}-${month}-${day} in ${tz}`);
  const dt = base.plus({ days }).set({ hour, minute, second: 0, millisecond: 0 });
  return dt.toUTC().toISO()!;
}

const NY = "America/New_York";

function baseParams(overrides: Partial<GenerateOccurrencesInWindowParams> = {}): GenerateOccurrencesInWindowParams {
  return {
    frequencyType: "daily",
    repeatWeeks: null,
    repeatMonths: null,
    anchorLocalDate: "2026-01-01",
    anchorLocalTime: "09:00",
    anchorTimezone: NY,
    after: isoAt(2026, 1, 1, 9, 0, NY),
    through: isoAt(2026, 1, 31, 9, 0, NY),
    maxOccurrences: 50,
    ...overrides,
  };
}

function expectOk(result: GenerateOccurrencesResult): { ok: true; occurrences: string[]; truncated: boolean } {
  assert.equal(result.ok, true, "reason" in result ? `expected ok, got failure: ${result.reason}` : undefined);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function expectFail(result: GenerateOccurrencesResult, reason: GenerateOccurrencesFailureReason) {
  assert.equal(result.ok, false, "occurrences" in result ? "expected failure, got ok:true" : undefined);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, reason);
  // Closed shape -- exactly {ok, reason}, nothing else leaked.
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"]);
}

describe("generateOccurrencesInWindow -- general validation", () => {
  test("rejects an unsupported timezone", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ anchorTimezone: "Europe/London" })), "invalid_timezone");
  });

  test("rejects a malformed anchor date shape", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ anchorLocalDate: "01/01/2026" })), "invalid_input");
  });

  test("rejects a calendar-invalid anchor date (Feb 30)", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ anchorLocalDate: "2026-02-30" })), "invalid_input");
  });

  test("rejects a malformed anchor time shape", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ anchorLocalTime: "9:00" })), "invalid_input");
  });

  test("rejects an out-of-range anchor hour (25:00)", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ anchorLocalTime: "25:00" })), "invalid_input");
  });

  test("rejects an out-of-range anchor minute (09:60)", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ anchorLocalTime: "09:60" })), "invalid_input");
  });

  test("rejects through === after", () => {
    const instant = isoAt(2026, 1, 5, 9, 0, NY);
    expectFail(generateOccurrencesInWindow(baseParams({ after: instant, through: instant })), "invalid_input");
  });

  test("rejects through < after", () => {
    expectFail(
      generateOccurrencesInWindow(baseParams({ after: isoAt(2026, 1, 10, 9, 0, NY), through: isoAt(2026, 1, 5, 9, 0, NY) })),
      "invalid_input"
    );
  });

  test("rejects a malformed after/through string", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ after: "not-a-date" })), "invalid_input");
  });

  for (const bad of [0, -1, 1.5, Infinity, NaN, -Infinity]) {
    test(`rejects maxOccurrences = ${bad}`, () => {
      expectFail(generateOccurrencesInWindow(baseParams({ maxOccurrences: bad })), "invalid_input");
    });
  }

  test("rejects an unsafe (beyond MAX_SAFE_INTEGER) maxOccurrences", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ maxOccurrences: Number.MAX_SAFE_INTEGER + 10 })), "invalid_input");
  });

  test("rejects a missing maxOccurrences", () => {
    const params = baseParams();
    // @ts-expect-error -- deliberately simulating a caller omitting a
    // mandatory field, exactly as a not-fully-typed future caller (e.g. a
    // JSON body) could.
    delete params.maxOccurrences;
    expectFail(generateOccurrencesInWindow(params), "invalid_input");
  });

  test("rejects an unsupported frequency value", () => {
    const params = baseParams({ frequencyType: "yearly" as unknown as GenerateOccurrencesInWindowParams["frequencyType"] });
    expectFail(generateOccurrencesInWindow(params), "invalid_input");
  });

  test("weekly rejects a missing repeatWeeks", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ frequencyType: "weekly", repeatWeeks: null })), "invalid_input");
  });

  for (const bad of [0, 9, 2.5, -1]) {
    test(`weekly rejects repeatWeeks = ${bad}`, () => {
      expectFail(generateOccurrencesInWindow(baseParams({ frequencyType: "weekly", repeatWeeks: bad })), "invalid_input");
    });
  }

  test("monthly rejects a missing repeatMonths", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ frequencyType: "monthly", repeatMonths: null })), "invalid_input");
  });

  for (const bad of [0, 13, 2.5, -1]) {
    test(`monthly rejects repeatMonths = ${bad}`, () => {
      expectFail(generateOccurrencesInWindow(baseParams({ frequencyType: "monthly", repeatMonths: bad })), "invalid_input");
    });
  }

  test("output is strictly increasing and unique", () => {
    const result = expectOk(
      generateOccurrencesInWindow(baseParams({ through: isoAt(2026, 3, 1, 9, 0, NY), maxOccurrences: 1000 }))
    );
    for (let i = 1; i < result.occurrences.length; i++) {
      assert.ok(result.occurrences[i] > result.occurrences[i - 1], `not strictly increasing at index ${i}`);
    }
    assert.equal(new Set(result.occurrences).size, result.occurrences.length, "duplicate occurrence detected");
  });

  test("exact (after, through] boundaries: after excluded, through included", () => {
    // Anchor 2026-01-01 09:00. after = anchor+1day exactly (a real
    // candidate), through = anchor+3days exactly (a real candidate).
    const after = isoAt(2026, 1, 2, 9, 0, NY);
    const through = isoAt(2026, 1, 4, 9, 0, NY);
    const result = expectOk(generateOccurrencesInWindow(baseParams({ after, through, maxOccurrences: 10 })));
    assert.deepEqual(result.occurrences, [isoAt(2026, 1, 3, 9, 0, NY), isoAt(2026, 1, 4, 9, 0, NY)]);
    assert.ok(!result.occurrences.includes(after), "the `after` instant itself must be excluded");
  });

  test("deterministic: repeated calls with identical params return identical results", () => {
    const params = baseParams({ through: isoAt(2026, 2, 1, 9, 0, NY), maxOccurrences: 15 });
    const first = generateOccurrencesInWindow(params);
    const second = generateOccurrencesInWindow(params);
    assert.deepEqual(first, second);
  });

  test("truncated: true when maxOccurrences is reached before the window is exhausted", () => {
    const result = expectOk(
      generateOccurrencesInWindow(baseParams({ through: isoAt(2026, 3, 1, 9, 0, NY), maxOccurrences: 3 }))
    );
    assert.equal(result.occurrences.length, 3);
    assert.equal(result.truncated, true);
  });

  test("truncated: false when the window is exhausted before maxOccurrences is reached", () => {
    const result = expectOk(
      generateOccurrencesInWindow(baseParams({ through: isoAt(2026, 1, 5, 9, 0, NY), maxOccurrences: 100 }))
    );
    assert.equal(result.occurrences.length, 4);
    assert.equal(result.truncated, false);
  });

  test("defensive iteration ceiling: fails closed for a window far beyond any legitimate size, independent of maxOccurrences", () => {
    // Daily steps one calendar day per iteration -- a 60-year window
    // requires roughly 21,000+ iterations, safely beyond
    // DEFENSIVE_ITERATION_CEILING (20,000), regardless of the generous
    // maxOccurrences supplied (which is not the limiting factor here).
    const result = generateOccurrencesInWindow(
      baseParams({
        anchorLocalDate: "1990-01-01",
        after: isoAt(1990, 1, 1, 9, 0, NY),
        through: isoAt(2050, 1, 1, 9, 0, NY),
        maxOccurrences: 1_000_000,
      })
    );
    expectFail(result, "iteration_limit");
  });

  test("a legitimate window well under the ceiling still succeeds (sanity check against an overly aggressive ceiling)", () => {
    const result = generateOccurrencesInWindow(
      baseParams({ through: isoAt(2026, 6, 1, 9, 0, NY), maxOccurrences: 1_000_000 })
    );
    assert.equal(result.ok, true);
  });

  test("DEFENSIVE_ITERATION_CEILING is exported and is a positive safe integer", () => {
    assert.equal(Number.isSafeInteger(DEFENSIVE_ITERATION_CEILING) && DEFENSIVE_ITERATION_CEILING > 0, true);
  });
});

describe("generateOccurrencesInWindow -- daily", () => {
  test("normal consecutive days, wall-clock time preserved", () => {
    const result = expectOk(
      generateOccurrencesInWindow(baseParams({ through: isoAt(2026, 1, 6, 9, 0, NY), maxOccurrences: 10 }))
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 1, 2, 9, 0, NY),
      isoAt(2026, 1, 3, 9, 0, NY),
      isoAt(2026, 1, 4, 9, 0, NY),
      isoAt(2026, 1, 5, 9, 0, NY),
      isoAt(2026, 1, 6, 9, 0, NY),
    ]);
  });

  test("crosses a month and year boundary correctly", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorLocalDate: "2025-12-29",
          after: isoAt(2025, 12, 29, 9, 0, NY),
          through: isoAt(2026, 1, 3, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2025, 12, 30, 9, 0, NY),
      isoAt(2025, 12, 31, 9, 0, NY),
      isoAt(2026, 1, 1, 9, 0, NY),
      isoAt(2026, 1, 2, 9, 0, NY),
      isoAt(2026, 1, 3, 9, 0, NY),
    ]);
  });

  test("spring DST transition: normal anchor time (09:00) generates successfully with wall-clock time preserved across the offset change", () => {
    // 2026 US spring-forward is 2026-03-08. Anchor a few days before it.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorLocalDate: "2026-03-05",
          after: isoAt(2026, 3, 5, 9, 0, NY),
          through: isoAt(2026, 3, 10, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 3, 6, 9, 0, NY),
      isoAt(2026, 3, 7, 9, 0, NY),
      isoAt(2026, 3, 8, 9, 0, NY), // the transition day itself -- 09:00 exists fine
      isoAt(2026, 3, 9, 9, 0, NY),
      isoAt(2026, 3, 10, 9, 0, NY),
    ]);
    // The UTC offset genuinely changed across this window (EST -> EDT) --
    // proving this isn't a coincidental pass because both sides happened
    // to share an offset.
    const beforeOffsetMinutes = DateTime.fromISO(result.occurrences[1]).setZone(NY).offset; // Mar 7, still EST
    const afterOffsetMinutes = DateTime.fromISO(result.occurrences[2]).setZone(NY).offset; // Mar 8, now EDT
    assert.notEqual(beforeOffsetMinutes, afterOffsetMinutes);
  });

  test("fall DST transition: normal anchor time (09:00) generates successfully across the offset change", () => {
    // 2026 US fall-back is 2026-11-01. Anchor a few days before it.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorLocalDate: "2026-10-29",
          after: isoAt(2026, 10, 29, 9, 0, NY),
          through: isoAt(2026, 11, 3, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 10, 30, 9, 0, NY),
      isoAt(2026, 10, 31, 9, 0, NY),
      isoAt(2026, 11, 1, 9, 0, NY), // the transition day itself
      isoAt(2026, 11, 2, 9, 0, NY),
      isoAt(2026, 11, 3, 9, 0, NY),
    ]);
    const beforeOffsetMinutes = DateTime.fromISO(result.occurrences[1]).setZone(NY).offset;
    const afterOffsetMinutes = DateTime.fromISO(result.occurrences[2]).setZone(NY).offset;
    assert.notEqual(beforeOffsetMinutes, afterOffsetMinutes);
  });
});

describe("generateOccurrencesInWindow -- weekdays", () => {
  test("Friday anchor -> next occurrence is Monday, weekend skipped", () => {
    // Premise verified: 2026-01-02 is a Friday (Luxon weekday 5).
    const anchor = DateTime.fromObject({ year: 2026, month: 1, day: 2 }, { zone: NY });
    assert.equal(anchor.weekday, 5);
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekdays",
          anchorLocalDate: "2026-01-02",
          after: isoAt(2026, 1, 2, 9, 0, NY),
          through: isoAt(2026, 1, 6, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    // Sat 1/3 and Sun 1/4 must be skipped -- the very next occurrence
    // after the Friday anchor is Monday 1/5.
    assert.deepEqual(result.occurrences, [isoAt(2026, 1, 5, 9, 0, NY), isoAt(2026, 1, 6, 9, 0, NY)]);
  });

  test("no Saturday/Sunday ever appears in the output across a multi-week range", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekdays",
          through: isoAt(2026, 2, 1, 9, 0, NY),
          maxOccurrences: 1000,
        })
      )
    );
    for (const iso of result.occurrences) {
      const weekday = DateTime.fromISO(iso).setZone(NY).weekday;
      assert.notEqual(weekday, 6, `Saturday found: ${iso}`);
      assert.notEqual(weekday, 7, `Sunday found: ${iso}`);
    }
    assert.ok(result.occurrences.length > 0);
  });

  test("range beginning and ending on weekend days is handled correctly", () => {
    // Premise: 2026-01-03 is Saturday, 2026-01-04 is Sunday.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekdays",
          anchorLocalDate: "2026-01-02", // Friday anchor
          after: isoAt(2026, 1, 3, 9, 0, NY), // starts mid-weekend (Saturday)
          through: isoAt(2026, 1, 4, 9, 0, NY), // ends mid-weekend (Sunday)
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, []);
  });

  test("weekend DST transition (fall-back 2026-11-01 is a Sunday): weekend day is correctly excluded, not just gap-avoided", () => {
    const dt = DateTime.fromObject({ year: 2026, month: 11, day: 1 }, { zone: NY });
    assert.equal(dt.weekday, 7); // confirm premise: it's a Sunday
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekdays",
          anchorLocalDate: "2026-10-29", // Thursday
          after: isoAt(2026, 10, 29, 9, 0, NY),
          through: isoAt(2026, 11, 3, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    // Fri 10/30, then Sat 10/31 + Sun 11/1 skipped (11/1 is also the DST
    // fall-back date, doubly proving it's excluded for being a weekend,
    // not merely resolved to some ambiguous instant), then Mon 11/2, Tue 11/3.
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 10, 30, 9, 0, NY),
      isoAt(2026, 11, 2, 9, 0, NY),
      isoAt(2026, 11, 3, 9, 0, NY),
    ]);
  });
});

describe("generateOccurrencesInWindow -- weekly", () => {
  for (let interval = 1; interval <= 8; interval++) {
    test(`repeatWeeks = ${interval}: correct spacing and weekday/wall-clock preservation`, () => {
      const result = expectOk(
        generateOccurrencesInWindow(
          baseParams({
            frequencyType: "weekly",
            repeatWeeks: interval,
            anchorLocalDate: "2026-01-05", // Monday
            anchorLocalTime: "14:00",
            after: isoAt(2026, 1, 5, 14, 0, NY),
            through: isoAtPlusDays(2026, 1, 5, interval * 7 * 3, 14, 0, NY),
            maxOccurrences: 10,
          })
        )
      );
      assert.equal(result.occurrences.length, 3);
      for (let i = 0; i < 3; i++) {
        const dt = DateTime.fromISO(result.occurrences[i]).setZone(NY);
        assert.equal(dt.weekday, 1, "weekday must remain Monday");
        assert.equal(dt.hour, 14, "wall-clock hour must remain 14:00");
        assert.equal(dt.minute, 0);
        const expectedDaysFromAnchor = (i + 1) * interval * 7;
        const expected = DateTime.fromObject({ year: 2026, month: 1, day: 5 }, { zone: NY }).plus({ days: expectedDaysFromAnchor });
        assert.equal(dt.toISODate(), expected.toISODate());
      }
    });
  }

  test("crosses a year boundary correctly", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekly",
          repeatWeeks: 2,
          anchorLocalDate: "2025-12-22",
          anchorLocalTime: "10:00",
          after: isoAt(2025, 12, 22, 10, 0, NY),
          through: isoAt(2026, 1, 20, 10, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 1, 5, 10, 0, NY),
      isoAt(2026, 1, 19, 10, 0, NY),
    ]);
  });

  test("spring DST offset change across the interval: local wall-clock time and weekday preserved, UTC offset genuinely differs", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekly",
          repeatWeeks: 1,
          anchorLocalDate: "2026-03-01", // Sunday, before spring-forward (3/8)
          anchorLocalTime: "09:00",
          after: isoAt(2026, 3, 1, 9, 0, NY),
          through: isoAt(2026, 3, 15, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 3, 8, 9, 0, NY),
      isoAt(2026, 3, 15, 9, 0, NY),
    ]);
    for (const iso of result.occurrences) {
      const dt = DateTime.fromISO(iso).setZone(NY);
      assert.equal(dt.weekday, 7);
      assert.equal(dt.hour, 9);
    }
    const beforeOffset = DateTime.fromObject({ year: 2026, month: 3, day: 1 }, { zone: NY }).offset;
    const afterOffset = DateTime.fromISO(result.occurrences[0]).setZone(NY).offset;
    assert.notEqual(beforeOffset, afterOffset);
  });

  test("fall DST offset change across the interval: local wall-clock time and weekday preserved, UTC offset genuinely differs", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekly",
          repeatWeeks: 1,
          anchorLocalDate: "2026-10-25", // Sunday, before fall-back (11/1)
          anchorLocalTime: "09:00",
          after: isoAt(2026, 10, 25, 9, 0, NY),
          through: isoAt(2026, 11, 8, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 11, 1, 9, 0, NY),
      isoAt(2026, 11, 8, 9, 0, NY),
    ]);
    const beforeOffset = DateTime.fromObject({ year: 2026, month: 10, day: 25 }, { zone: NY }).offset;
    const afterOffset = DateTime.fromISO(result.occurrences[0]).setZone(NY).offset;
    assert.notEqual(beforeOffset, afterOffset);
  });
});

describe("generateOccurrencesInWindow -- monthly", () => {
  for (let interval = 1; interval <= 12; interval++) {
    test(`repeatMonths = ${interval}: correct spacing`, () => {
      const result = expectOk(
        generateOccurrencesInWindow(
          baseParams({
            frequencyType: "monthly",
            repeatMonths: interval,
            anchorLocalDate: "2026-01-15",
            anchorLocalTime: "11:00",
            after: isoAt(2026, 1, 15, 11, 0, NY),
            through: isoAt(2029, 1, 15, 11, 0, NY),
            maxOccurrences: 3,
          })
        )
      );
      assert.equal(result.occurrences.length, 3);
      const anchor = DateTime.fromObject({ year: 2026, month: 1, day: 15 }, { zone: NY });
      for (let i = 0; i < 3; i++) {
        const expected = anchor.plus({ months: (i + 1) * interval });
        assert.equal(DateTime.fromISO(result.occurrences[i]).setZone(NY).toISODate(), expected.toISODate());
      }
    });
  }

  test("Jan 31 clamps to Feb 28/29 and recovers to Mar 31 (never Mar 28/29) -- non-leap year", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 1,
          anchorLocalDate: "2025-01-31", // 2025 is not a leap year
          anchorLocalTime: "09:00",
          after: isoAt(2025, 1, 31, 9, 0, NY),
          through: isoAt(2025, 4, 1, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2025, 2, 28, 9, 0, NY),
      isoAt(2025, 3, 31, 9, 0, NY),
    ]);
  });

  test("Jan 30 clamps to Feb 28 and recovers to Mar 30", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 1,
          anchorLocalDate: "2026-01-30",
          anchorLocalTime: "09:00",
          after: isoAt(2026, 1, 30, 9, 0, NY),
          through: isoAt(2026, 4, 1, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 2, 28, 9, 0, NY),
      isoAt(2026, 3, 30, 9, 0, NY),
    ]);
  });

  test("leap-year February: Jan 31 2024 + 1 month = Feb 29 2024", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 1,
          anchorLocalDate: "2024-01-31",
          anchorLocalTime: "09:00",
          after: isoAt(2024, 1, 31, 9, 0, NY),
          through: isoAt(2024, 2, 29, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [isoAt(2024, 2, 29, 9, 0, NY)]);
  });

  test("non-leap February: Jan 31 2025 + 1 month = Feb 28 2025", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 1,
          anchorLocalDate: "2025-01-31",
          anchorLocalTime: "09:00",
          after: isoAt(2025, 1, 31, 9, 0, NY),
          through: isoAt(2025, 2, 28, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [isoAt(2025, 2, 28, 9, 0, NY)]);
  });

  test("crosses a year boundary correctly", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 1,
          anchorLocalDate: "2025-12-15",
          anchorLocalTime: "09:00",
          after: isoAt(2025, 12, 15, 9, 0, NY),
          through: isoAt(2026, 1, 15, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [isoAt(2026, 1, 15, 9, 0, NY)]);
  });

  test("multi-year range with a coarse interval", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 6,
          anchorLocalDate: "2026-01-15",
          anchorLocalTime: "09:00",
          after: isoAt(2026, 1, 15, 9, 0, NY),
          through: isoAt(2029, 1, 15, 9, 0, NY),
          maxOccurrences: 100,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 7, 15, 9, 0, NY),
      isoAt(2027, 1, 15, 9, 0, NY),
      isoAt(2027, 7, 15, 9, 0, NY),
      isoAt(2028, 1, 15, 9, 0, NY),
      isoAt(2028, 7, 15, 9, 0, NY),
      isoAt(2029, 1, 15, 9, 0, NY),
    ]);
  });

  test("normal DST offset change across a monthly interval: local wall-clock time preserved, UTC offset genuinely differs", () => {
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "monthly",
          repeatMonths: 1,
          anchorLocalDate: "2026-02-15", // before spring-forward (3/8)
          anchorLocalTime: "09:00",
          after: isoAt(2026, 2, 15, 9, 0, NY),
          through: isoAt(2026, 3, 15, 9, 0, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.deepEqual(result.occurrences, [isoAt(2026, 3, 15, 9, 0, NY)]);
    const beforeOffset = DateTime.fromObject({ year: 2026, month: 2, day: 15 }, { zone: NY }).offset;
    const afterOffset = DateTime.fromISO(result.occurrences[0]).setZone(NY).offset;
    assert.notEqual(beforeOffset, afterOffset);
  });
});

describe("generateOccurrencesInWindow -- timezone matrix (all 7 approved workspace zones)", () => {
  for (const { value: tz, label } of TIMEZONE_OPTIONS) {
    test(`${label} (${tz}): generates correctly and round-trips to the same local wall-clock time`, () => {
      const result = expectOk(
        generateOccurrencesInWindow(
          baseParams({
            anchorTimezone: tz,
            after: isoAt(2026, 6, 1, 9, 0, tz),
            through: isoAt(2026, 6, 5, 9, 0, tz),
            maxOccurrences: 10,
          })
        )
      );
      assert.equal(result.occurrences.length, 4);
      for (const iso of result.occurrences) {
        const local = DateTime.fromISO(iso).setZone(tz);
        assert.equal(local.hour, 9);
        assert.equal(local.minute, 0);
      }
    });
  }

  test("Arizona (no DST) remains stable across the U.S. spring-forward date -- no offset change, no gap", () => {
    const tz = "America/Phoenix";
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorTimezone: tz,
          anchorLocalDate: "2026-03-05",
          after: isoAt(2026, 3, 5, 9, 0, tz),
          through: isoAt(2026, 3, 10, 9, 0, tz),
          maxOccurrences: 10,
        })
      )
    );
    const offsets = result.occurrences.map((iso) => DateTime.fromISO(iso).setZone(tz).offset);
    assert.ok(offsets.every((o) => o === offsets[0]), "Arizona's UTC offset must never change");
  });

  test("Hawaii (no DST) remains stable across the U.S. fall-back date -- no offset change, no ambiguity", () => {
    const tz = "Pacific/Honolulu";
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorTimezone: tz,
          anchorLocalDate: "2026-10-29",
          after: isoAt(2026, 10, 29, 9, 0, tz),
          through: isoAt(2026, 11, 3, 9, 0, tz),
          maxOccurrences: 10,
        })
      )
    );
    const offsets = result.occurrences.map((iso) => DateTime.fromISO(iso).setZone(tz).offset);
    assert.ok(offsets.every((o) => o === offsets[0]), "Hawaii's UTC offset must never change");
  });

  test("the identical local anchor (date/time) produces DIFFERENT UTC instants in different zones", () => {
    const eastern = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorTimezone: "America/New_York",
          after: isoAt(2026, 6, 1, 9, 0, "America/New_York"),
          through: isoAt(2026, 6, 2, 9, 0, "America/New_York"),
          maxOccurrences: 1,
        })
      )
    );
    const pacific = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorTimezone: "America/Los_Angeles",
          after: isoAt(2026, 6, 1, 9, 0, "America/Los_Angeles"),
          through: isoAt(2026, 6, 2, 9, 0, "America/Los_Angeles"),
          maxOccurrences: 1,
        })
      )
    );
    assert.notEqual(eastern.occurrences[0], pacific.occurrences[0]);
    // Exactly a 3-hour difference in June (both observing DST: EDT -04:00 vs PDT -07:00).
    const diffMs = DateTime.fromISO(pacific.occurrences[0]).toMillis() - DateTime.fromISO(eastern.occurrences[0]).toMillis();
    assert.equal(diffMs, 3 * 60 * 60 * 1000);
  });
});

describe("generateOccurrencesInWindow -- DST gap", () => {
  test("exact closed dst_gap result when the anchor's own local time is nonexistent", () => {
    // 2026-03-08 02:30 America/New_York does not exist (spring-forward gap).
    const result = generateOccurrencesInWindow(
      baseParams({
        anchorLocalDate: "2026-03-08",
        anchorLocalTime: "02:30",
        after: isoAt(2026, 3, 1, 9, 0, NY),
        through: isoAt(2026, 3, 15, 9, 0, NY),
      })
    );
    expectFail(result, "dst_gap");
  });

  test("no partial result: a gap on a LATER candidate within the window fails the whole call, not just that one candidate", () => {
    // Anchor at 02:30 on 2026-03-01 (valid). Adding 7 days lands on
    // 2026-03-08 02:30, which does not exist. Several valid daily
    // candidates precede it within the window.
    const result = generateOccurrencesInWindow(
      baseParams({
        anchorLocalDate: "2026-03-01",
        anchorLocalTime: "02:30",
        after: isoAt(2026, 3, 1, 2, 30, NY),
        through: isoAt(2026, 3, 12, 2, 30, NY),
        maxOccurrences: 100,
      })
    );
    expectFail(result, "dst_gap");
  });

  test("a gapped candidate OUTSIDE the requested window does not fail the call", () => {
    // Same gapped date (2026-03-08 02:30) exists 7 days after the anchor,
    // but `through` stops short of it -- the window never reaches the gap.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorLocalDate: "2026-03-01",
          anchorLocalTime: "02:30",
          after: isoAt(2026, 3, 1, 2, 30, NY),
          through: isoAt(2026, 3, 6, 2, 30, NY),
          maxOccurrences: 100,
        })
      )
    );
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 3, 2, 2, 30, NY),
      isoAt(2026, 3, 3, 2, 30, NY),
      isoAt(2026, 3, 4, 2, 30, NY),
      isoAt(2026, 3, 5, 2, 30, NY),
      isoAt(2026, 3, 6, 2, 30, NY),
    ]);
  });
});

describe("generateOccurrencesInWindow -- fall ambiguity", () => {
  test("deterministic earlier/first occurrence for an ambiguous fall-back local time", () => {
    // Anchor a week before the fall-back date (2026-11-01), at 01:30 --
    // the next weekly occurrence lands exactly on the ambiguous instant.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          frequencyType: "weekly",
          repeatWeeks: 1,
          anchorLocalDate: "2026-10-25",
          anchorLocalTime: "01:30",
          after: isoAt(2026, 10, 25, 1, 30, NY),
          through: isoAt(2026, 11, 2, 1, 30, NY),
          maxOccurrences: 10,
        })
      )
    );
    assert.equal(result.occurrences.length, 1);
    // The project's already-approved policy (lib/timezone.ts's
    // zonedDateTimeToUTC, empirically documented there): the FIRST/earlier
    // occurrence -- still-DST-active offset (-04:00), before the clocks
    // fall back -- computed independently here via direct construction.
    const expected = DateTime.fromFormat("2026-11-01 01:30", "yyyy-MM-dd HH:mm", { zone: NY }).toUTC().toISO()!;
    assert.equal(result.occurrences[0], expected);
    assert.equal(DateTime.fromISO(result.occurrences[0]).setZone(NY).offset, -240);
  });

  test("repeated calls into the same ambiguous instant are always identical (determinism proof)", () => {
    const params = baseParams({
      frequencyType: "weekly",
      repeatWeeks: 1,
      anchorLocalDate: "2026-10-25",
      anchorLocalTime: "01:30",
      after: isoAt(2026, 10, 25, 1, 30, NY),
      through: isoAt(2026, 11, 2, 1, 30, NY),
      maxOccurrences: 10,
    });
    const results = Array.from({ length: 5 }, () => generateOccurrencesInWindow(params));
    for (const r of results) assert.deepEqual(r, results[0]);
  });
});

describe("generateOccurrencesInWindow -- starting-index efficiency (algorithm audit)", () => {
  // A generous bound proving the fix -- without the starting-index
  // optimization, a 76-year-old daily anchor would require roughly 27,700
  // iterations just to reach `after` (exceeding DEFENSIVE_ITERATION_CEILING
  // outright); with it, reaching the window and generating a handful of
  // occurrences should take well under 100.
  const BOUND = 200;

  test("daily: a 76-year-old anchor with a narrow current window generates correctly, without iteration_limit, in a small bounded number of iterations", () => {
    const { result, iterationsUsed } = generateOccurrencesInWindowWithDiagnostics(
      baseParams({
        frequencyType: "daily",
        anchorLocalDate: "1950-01-01",
        anchorLocalTime: "09:00",
        after: isoAt(2026, 1, 1, 9, 0, NY),
        through: isoAt(2026, 1, 10, 9, 0, NY),
        maxOccurrences: 20,
      })
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.deepEqual(result.occurrences, [
      isoAt(2026, 1, 2, 9, 0, NY),
      isoAt(2026, 1, 3, 9, 0, NY),
      isoAt(2026, 1, 4, 9, 0, NY),
      isoAt(2026, 1, 5, 9, 0, NY),
      isoAt(2026, 1, 6, 9, 0, NY),
      isoAt(2026, 1, 7, 9, 0, NY),
      isoAt(2026, 1, 8, 9, 0, NY),
      isoAt(2026, 1, 9, 9, 0, NY),
      isoAt(2026, 1, 10, 9, 0, NY),
    ]);
    assert.ok(iterationsUsed < BOUND, `expected a bounded iteration count, got ${iterationsUsed}`);
  });

  test("weekdays: a decades-old anchor with a narrow current window jumps near the window (bounded iteration count)", () => {
    const { result, iterationsUsed } = generateOccurrencesInWindowWithDiagnostics(
      baseParams({
        frequencyType: "weekdays",
        anchorLocalDate: "1960-06-15",
        anchorLocalTime: "09:00",
        after: isoAt(2026, 1, 5, 9, 0, NY), // Monday
        through: isoAt(2026, 1, 9, 9, 0, NY), // Friday
        maxOccurrences: 20,
      })
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.occurrences.length, 4); // Tue, Wed, Thu, Fri
    assert.ok(iterationsUsed < BOUND, `expected a bounded iteration count, got ${iterationsUsed}`);
  });

  test("weekly: a decades-old anchor with a narrow current window jumps near the window (bounded iteration count)", () => {
    const { result, iterationsUsed } = generateOccurrencesInWindowWithDiagnostics(
      baseParams({
        frequencyType: "weekly",
        repeatWeeks: 2,
        anchorLocalDate: "1970-03-02", // a Monday
        anchorLocalTime: "10:00",
        after: isoAt(2026, 1, 5, 10, 0, NY),
        through: isoAt(2026, 3, 1, 10, 0, NY),
        maxOccurrences: 50,
      })
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.ok(result.occurrences.length > 0);
    for (const iso of result.occurrences) {
      assert.equal(DateTime.fromISO(iso).setZone(NY).weekday, 1, "weekday must remain Monday");
    }
    assert.ok(iterationsUsed < BOUND, `expected a bounded iteration count, got ${iterationsUsed}`);
  });

  test("monthly: a decades-old anchor with a narrow current window jumps near the window (bounded iteration count)", () => {
    const { result, iterationsUsed } = generateOccurrencesInWindowWithDiagnostics(
      baseParams({
        frequencyType: "monthly",
        repeatMonths: 3,
        anchorLocalDate: "1980-01-15",
        anchorLocalTime: "11:00",
        after: isoAt(2026, 1, 15, 11, 0, NY),
        through: isoAt(2027, 1, 15, 11, 0, NY),
        maxOccurrences: 50,
      })
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.ok(result.occurrences.length > 0);
    // Even the estimator's own crude approximation should never need more
    // than a handful of iterations for monthly (already coarse-grained).
    assert.ok(iterationsUsed < BOUND, `expected a bounded iteration count, got ${iterationsUsed}`);
  });

  test("iteration count is independent of historical age: a 5-year-old and a 75-year-old anchor cost roughly the same for an identical current window", () => {
    const recent = generateOccurrencesInWindowWithDiagnostics(
      baseParams({
        frequencyType: "daily",
        anchorLocalDate: "2021-01-01",
        anchorLocalTime: "09:00",
        after: isoAt(2026, 1, 1, 9, 0, NY),
        through: isoAt(2026, 1, 10, 9, 0, NY),
        maxOccurrences: 20,
      })
    );
    const ancient = generateOccurrencesInWindowWithDiagnostics(
      baseParams({
        frequencyType: "daily",
        anchorLocalDate: "1951-01-01",
        anchorLocalTime: "09:00",
        after: isoAt(2026, 1, 1, 9, 0, NY),
        through: isoAt(2026, 1, 10, 9, 0, NY),
        maxOccurrences: 20,
      })
    );
    assert.equal(recent.result.ok, true);
    assert.equal(ancient.result.ok, true);
    assert.deepEqual(recent.result, ancient.result);
    // The difference in iteration count between a 5-year-old and a
    // 70-years-older anchor, for the IDENTICAL requested window, must be
    // small (bounded by the estimator's own safety margin), never scale
    // with the ~25,550 extra days of history.
    assert.ok(Math.abs(recent.iterationsUsed - ancient.iterationsUsed) < 20);
  });
});

describe("generateOccurrencesInWindow -- exact truncated semantics (algorithm audit)", () => {
  test("truncated is FALSE when occurrences.length equals maxOccurrences AND the last returned occurrence is also the last eligible one through the boundary", () => {
    // Anchor 2026-01-01 09:00, daily. through set to EXACTLY the 5th
    // candidate's own instant -- no 6th candidate can ever be eligible.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({ through: isoAt(2026, 1, 6, 9, 0, NY), maxOccurrences: 5 })
      )
    );
    assert.equal(result.occurrences.length, 5);
    assert.equal(result.truncated, false);
  });

  test("truncated is TRUE when occurrences.length equals maxOccurrences and exactly ONE more eligible occurrence exists through the boundary", () => {
    // through now reaches exactly the 6th candidate -- one real occurrence
    // beyond the 5-occurrence cap.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({ through: isoAt(2026, 1, 7, 9, 0, NY), maxOccurrences: 5 })
      )
    );
    assert.equal(result.occurrences.length, 5);
    assert.equal(result.truncated, true);
  });
});

describe("generateOccurrencesInWindow -- DST gap beyond the output cap (algorithm audit)", () => {
  test("DST gap BEFORE the cap is reached: fails closed exactly as before", () => {
    // Anchor 2026-03-05 02:30 -- gap lands at the 3rd candidate (2026-03-08
    // 02:30, spring-forward). maxOccurrences is large (10), so the cap is
    // never reached before the gap.
    const result = generateOccurrencesInWindow(
      baseParams({
        anchorLocalDate: "2026-03-05",
        anchorLocalTime: "02:30",
        after: isoAt(2026, 3, 5, 2, 30, NY),
        through: isoAt(2026, 3, 15, 2, 30, NY),
        maxOccurrences: 10,
      })
    );
    expectFail(result, "dst_gap");
  });

  test("DST gap EXACTLY the candidate immediately after reaching the cap: still dst_gap, never a truncated success", () => {
    // Same anchor/gap as above, but maxOccurrences = 2 -- the gap (3rd
    // eligible candidate) is exactly the first one beyond the cap.
    const result = generateOccurrencesInWindow(
      baseParams({
        anchorLocalDate: "2026-03-05",
        anchorLocalTime: "02:30",
        after: isoAt(2026, 3, 5, 2, 30, NY),
        through: isoAt(2026, 3, 15, 2, 30, NY),
        maxOccurrences: 2,
      })
    );
    expectFail(result, "dst_gap");
  });

  test("DST gap much later in the same requested window, well past the cap and several valid occurrences: still dst_gap, no partial list", () => {
    // Anchor 2026-03-01 02:30 -- 5 valid candidates (Mar 2-6... actually
    // Mar2 through Mar7) precede the gap at Mar 8. maxOccurrences = 2 means
    // several valid, uncollected candidates exist between the cap and the
    // gap.
    const result = generateOccurrencesInWindow(
      baseParams({
        anchorLocalDate: "2026-03-01",
        anchorLocalTime: "02:30",
        after: isoAt(2026, 3, 1, 2, 30, NY),
        through: isoAt(2026, 3, 20, 2, 30, NY),
        maxOccurrences: 2,
      })
    );
    expectFail(result, "dst_gap");
  });

  test("no gap anywhere in the window, real additional occurrences beyond the cap: successful truncated result, DST transition crossed safely", () => {
    // Anchor 2026-03-01 09:00 (a safe hour, never gapped) -- window spans
    // the same spring-forward date (Mar 8) that caused a gap in the tests
    // above, proving the transition itself is handled fine at a normal
    // hour, and truncation is still reported correctly.
    const result = expectOk(
      generateOccurrencesInWindow(
        baseParams({
          anchorLocalDate: "2026-03-01",
          anchorLocalTime: "09:00",
          after: isoAt(2026, 3, 1, 9, 0, NY),
          through: isoAt(2026, 3, 10, 9, 0, NY),
          maxOccurrences: 2,
        })
      )
    );
    assert.equal(result.occurrences.length, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.occurrences, [isoAt(2026, 3, 2, 9, 0, NY), isoAt(2026, 3, 3, 9, 0, NY)]);
  });
});

describe("generateOccurrencesInWindow -- frequency-specific interval shape (mirrors migrations/026's own CHECK constraint)", () => {
  test("daily rejects an extraneous repeatWeeks", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ frequencyType: "daily", repeatWeeks: 3, repeatMonths: null })), "invalid_input");
  });

  test("daily rejects an extraneous repeatMonths", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ frequencyType: "daily", repeatWeeks: null, repeatMonths: 2 })), "invalid_input");
  });

  test("weekdays rejects an extraneous repeatWeeks", () => {
    expectFail(
      generateOccurrencesInWindow(baseParams({ frequencyType: "weekdays", repeatWeeks: 1, repeatMonths: null })),
      "invalid_input"
    );
  });

  test("weekdays rejects an extraneous repeatMonths", () => {
    expectFail(
      generateOccurrencesInWindow(baseParams({ frequencyType: "weekdays", repeatWeeks: null, repeatMonths: 1 })),
      "invalid_input"
    );
  });

  test("weekly rejects a contradictory repeatMonths alongside a valid repeatWeeks", () => {
    expectFail(
      generateOccurrencesInWindow(baseParams({ frequencyType: "weekly", repeatWeeks: 2, repeatMonths: 1 })),
      "invalid_input"
    );
  });

  test("monthly rejects a contradictory repeatWeeks alongside a valid repeatMonths", () => {
    expectFail(
      generateOccurrencesInWindow(baseParams({ frequencyType: "monthly", repeatWeeks: 1, repeatMonths: 3 })),
      "invalid_input"
    );
  });

  test("daily/weekdays/weekly/monthly with their own exactly-correct interval shape all succeed", () => {
    for (const params of [
      baseParams({ frequencyType: "daily", repeatWeeks: null, repeatMonths: null }),
      baseParams({ frequencyType: "weekdays", repeatWeeks: null, repeatMonths: null }),
      baseParams({ frequencyType: "weekly", repeatWeeks: 2, repeatMonths: null }),
      baseParams({ frequencyType: "monthly", repeatWeeks: null, repeatMonths: 3 }),
    ]) {
      const result = generateOccurrencesInWindow(params);
      assert.equal(result.ok, true, `expected ok for frequencyType ${params.frequencyType}`);
    }
  });
});

describe("generateOccurrencesInWindow -- strict input-format audit", () => {
  test("after/through with an explicit non-UTC offset resolve to the identical absolute instant as the equivalent Z-suffixed value -- never silently misinterpreted as UTC wall-clock", () => {
    const withOffset = generateOccurrencesInWindow(
      baseParams({
        after: "2026-01-01T04:00:00-05:00", // = 2026-01-01T09:00:00Z
        through: isoAt(2026, 1, 6, 9, 0, NY),
        maxOccurrences: 10,
      })
    );
    const withZ = generateOccurrencesInWindow(
      baseParams({
        after: "2026-01-01T09:00:00.000Z",
        through: isoAt(2026, 1, 6, 9, 0, NY),
        maxOccurrences: 10,
      })
    );
    assert.deepEqual(withOffset, withZ);
  });

  test("an ISO date-only after/through (no time component) is a valid absolute instant (midnight UTC), not rejected", () => {
    const result = generateOccurrencesInWindow(baseParams({ after: "2026-01-01", through: "2026-01-05" }));
    assert.equal(result.ok, true);
  });

  test("a plainly non-ISO garbage after value is rejected, never silently coerced", () => {
    expectFail(generateOccurrencesInWindow(baseParams({ after: "next Tuesday" })), "invalid_input");
  });
});
