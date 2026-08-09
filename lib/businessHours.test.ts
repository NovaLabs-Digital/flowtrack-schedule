import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  WEEKDAY_KEYS,
  DEFAULT_BUSINESS_HOURS,
  isValidTimeString,
  normalizeBusinessHours,
  effectiveBusinessHours,
  weekdayKeyForDate,
  rangesForDate,
  cloneBusinessHours,
} from "./businessHours.ts";

describe("isValidTimeString", () => {
  for (const good of ["00:00", "07:00", "08:00", "12:00", "17:30", "23:59"]) {
    test(`accepts "${good}"`, () => assert.equal(isValidTimeString(good), true));
  }
  for (const bad of ["8:00", "08:0", "24:00", "12:60", "8:00 AM", "", "17:00:00", 800, null, undefined]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(isValidTimeString(bad), false));
  }
});

describe("normalizeBusinessHours -- fallback", () => {
  test("null input normalizes to the Mon-Fri 07:00-17:00 default, Sat/Sun closed", () => {
    const result = normalizeBusinessHours(null);
    assert.ok(result.ok);
    if (!result.ok) return;
    for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday"] as const) {
      assert.deepEqual(result.value[day], [{ start: "07:00", end: "17:00" }]);
    }
    assert.deepEqual(result.value.saturday, []);
    assert.deepEqual(result.value.sunday, []);
  });

  test("undefined input also normalizes to the default", () => {
    const result = normalizeBusinessHours(undefined);
    assert.ok(result.ok);
  });
});

describe("normalizeBusinessHours -- valid inputs", () => {
  test("a valid single range per day", () => {
    const result = normalizeBusinessHours({ monday: [{ start: "08:00", end: "17:00" }] });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.monday, [{ start: "08:00", end: "17:00" }]);
    assert.deepEqual(result.value.tuesday, []); // omitted day -> closed
  });

  test("valid split ranges on the same day, already in order", () => {
    const result = normalizeBusinessHours({
      monday: [
        { start: "08:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.monday, [
      { start: "08:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ]);
  });

  test("out-of-order ranges are sorted chronologically", () => {
    const result = normalizeBusinessHours({
      monday: [
        { start: "13:00", end: "17:00" },
        { start: "08:00", end: "12:00" },
      ],
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.monday.map((r) => r.start), ["08:00", "13:00"]);
  });

  test("adjacent touching ranges are merged into one", () => {
    const result = normalizeBusinessHours({
      monday: [
        { start: "08:00", end: "12:00" },
        { start: "12:00", end: "17:00" },
      ],
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.monday, [{ start: "08:00", end: "17:00" }]);
  });

  test("explicit empty array on a day means Closed", () => {
    const result = normalizeBusinessHours({ monday: [] });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.monday, []);
  });

  test("all seven days Closed is a fully valid configuration", () => {
    const allClosed = Object.fromEntries(WEEKDAY_KEYS.map((d) => [d, []]));
    const result = normalizeBusinessHours(allClosed);
    assert.ok(result.ok);
    if (!result.ok) return;
    for (const day of WEEKDAY_KEYS) assert.deepEqual(result.value[day], []);
  });

  test("an omitted weekday key defaults to Closed, not an error", () => {
    const result = normalizeBusinessHours({});
    assert.ok(result.ok);
    if (!result.ok) return;
    for (const day of WEEKDAY_KEYS) assert.deepEqual(result.value[day], []);
  });
});

describe("normalizeBusinessHours -- rejected inputs", () => {
  test("malformed weekday structure (unknown key) is rejected", () => {
    const result = normalizeBusinessHours({ someday: [{ start: "08:00", end: "17:00" }] });
    assert.equal(result.ok, false);
  });

  test("a day value that isn't an array is rejected", () => {
    const result = normalizeBusinessHours({ monday: "closed" });
    assert.equal(result.ok, false);
  });

  test("a range missing start/end is rejected", () => {
    const result = normalizeBusinessHours({ monday: [{ start: "08:00" }] });
    assert.equal(result.ok, false);
  });

  for (const bad of ["8:00", "08:00am", "25:00", "08:60", "noon"]) {
    test(`invalid HH:mm "${bad}" is rejected`, () => {
      const result = normalizeBusinessHours({ monday: [{ start: bad, end: "17:00" }] });
      assert.equal(result.ok, false);
    });
  }

  test("start >= end is rejected (start equal to end)", () => {
    const result = normalizeBusinessHours({ monday: [{ start: "08:00", end: "08:00" }] });
    assert.equal(result.ok, false);
  });

  test("start > end is rejected, never silently interpreted as overnight", () => {
    const result = normalizeBusinessHours({ monday: [{ start: "20:00", end: "02:00" }] });
    assert.equal(result.ok, false);
  });

  test("overlapping ranges on the same day are rejected", () => {
    const result = normalizeBusinessHours({
      monday: [
        { start: "08:00", end: "13:00" },
        { start: "12:00", end: "17:00" },
      ],
    });
    assert.equal(result.ok, false);
  });

  test("the top-level value must be an object, not an array or primitive", () => {
    assert.equal(normalizeBusinessHours([]).ok, false);
    assert.equal(normalizeBusinessHours("monday").ok, false);
    assert.equal(normalizeBusinessHours(42).ok, false);
  });

  test("a malformed/dangerous extra property on a range object is simply ignored, not stored", () => {
    const result = normalizeBusinessHours({
      monday: [{ start: "08:00", end: "17:00", __proto__: { polluted: true } }],
    });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.deepEqual(result.value.monday, [{ start: "08:00", end: "17:00" }]);
    assert.equal((result.value.monday[0] as Record<string, unknown>).polluted, undefined);
  });
});

describe("effectiveBusinessHours", () => {
  test("NULL stored value falls back to the default", () => {
    assert.deepEqual(effectiveBusinessHours(null), DEFAULT_BUSINESS_HOURS);
  });

  test("undefined stored value falls back to the default", () => {
    assert.deepEqual(effectiveBusinessHours(undefined), DEFAULT_BUSINESS_HOURS);
  });

  test("a valid stored value is returned normalized", () => {
    const stored = { tuesday: [{ start: "09:00", end: "18:00" }] };
    const result = effectiveBusinessHours(stored);
    assert.deepEqual(result.tuesday, [{ start: "09:00", end: "18:00" }]);
    assert.deepEqual(result.monday, []);
  });

  test("a somehow-invalid stored value falls back to the default rather than throwing", () => {
    const result = effectiveBusinessHours({ monday: "not-an-array" });
    assert.deepEqual(result, DEFAULT_BUSINESS_HOURS);
  });
});

describe("weekdayKeyForDate / rangesForDate", () => {
  test("2026-08-03 (a Monday) maps to 'monday'", () => {
    assert.equal(weekdayKeyForDate("2026-08-03"), "monday");
  });

  test("2026-08-08 (a Saturday) maps to 'saturday'", () => {
    assert.equal(weekdayKeyForDate("2026-08-08"), "saturday");
  });

  test("2026-08-09 (a Sunday) maps to 'sunday'", () => {
    assert.equal(weekdayKeyForDate("2026-08-09"), "sunday");
  });

  test("an invalid date string returns null", () => {
    assert.equal(weekdayKeyForDate("not-a-date"), null);
  });

  test("rangesForDate looks up the correct day's ranges from a BusinessHours object", () => {
    const hours = effectiveBusinessHours({ monday: [{ start: "09:00", end: "12:00" }] });
    assert.deepEqual(rangesForDate(hours, "2026-08-03"), [{ start: "09:00", end: "12:00" }]);
    assert.deepEqual(rangesForDate(hours, "2026-08-08"), []); // Saturday, closed
  });
});

describe("cloneBusinessHours", () => {
  test("produces a deep copy -- mutating the clone never affects the original", () => {
    const original = effectiveBusinessHours(null);
    const clone = cloneBusinessHours(original);
    clone.monday.push({ start: "18:00", end: "19:00" });
    assert.equal(original.monday.length, 1, "the original must be unaffected by mutating the clone");
  });
});
