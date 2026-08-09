import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  computeAvailableSlots,
  isSlotAvailable,
  isWithinBusinessHours,
  isOpenDay,
  businessDayBounds,
  businessDateStringFromInstant,
  todayBusinessDate,
} from "./availability.ts";
import { effectiveBusinessHours, DEFAULT_BUSINESS_HOURS } from "./businessHours.ts";
import { BUSINESS_TZ, effectiveTimezone, TIMEZONE_OPTIONS } from "./timezone.ts";

// A Monday and a Saturday, matching the date convention used elsewhere in
// this suite (e.g. app/api/book/availability/route.test.ts).
const MONDAY = "2026-08-03";
const SATURDAY = "2026-08-08";

// Phase 5D: every function in lib/availability.ts now requires an explicit
// workspace timezone -- no BUSINESS_TZ default remains. NY is used
// throughout as the fixed value for tests that aren't specifically about
// cross-timezone behavior (unchanged pre-Phase-5D expectations); a
// dedicated "Phase 5D" describe block further down proves the same
// functions are genuinely correct for every OTHER supported timezone too.
const NY = BUSINESS_TZ;

// Freezes "now" to a fixed instant safely before every date used below, so
// "is this slot in the past" resolves the same way regardless of when the
// suite actually runs (same fix already applied by
// app/api/book/availability/route.test.ts's own FULL_STATES block).
before(() => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-01T12:00:00.000Z").getTime() });
});
after(() => {
  mock.timers.reset();
});

describe("isOpenDay", () => {
  test("true for a weekday under the default hours", () => {
    assert.equal(isOpenDay(MONDAY, DEFAULT_BUSINESS_HOURS, NY), true);
  });
  test("false for a weekend day under the default hours", () => {
    assert.equal(isOpenDay(SATURDAY, DEFAULT_BUSINESS_HOURS, NY), false);
  });
  test("false for a day with an explicit empty range list", () => {
    const hours = effectiveBusinessHours({ monday: [] });
    assert.equal(isOpenDay(MONDAY, hours, NY), false);
  });
  test("true for a normally-closed day the workspace has opened", () => {
    const hours = effectiveBusinessHours({ saturday: [{ start: "09:00", end: "13:00" }] });
    assert.equal(isOpenDay(SATURDAY, hours, NY), true);
  });
});

describe("computeAvailableSlots -- default (single range) hours", () => {
  test("a closed day (weekend) yields zero slots", () => {
    assert.deepEqual(computeAvailableSlots(SATURDAY, 60, [], DEFAULT_BUSINESS_HOURS, NY), []);
  });

  test("an open day yields slots starting at open and ending by close", () => {
    const slots = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS, NY);
    assert.ok(slots.length > 0);
    assert.ok(slots[0].startsWith("2026-08-03T07:00"));
    assert.ok(slots[slots.length - 1] <= "2026-08-03T17:00");
  });

  test("existing collision rules still apply -- a busy range removes overlapping slots", () => {
    const busyStart = new Date("2026-08-03T13:00:00.000Z"); // 09:00 ET
    const busyEnd = new Date("2026-08-03T14:00:00.000Z"); // 10:00 ET
    const slots = computeAvailableSlots(MONDAY, 60, [{ start: busyStart, end: busyEnd }], DEFAULT_BUSINESS_HOURS, NY);
    assert.ok(!slots.includes("2026-08-03T09:00:00.000-04:00"));
  });
});

describe("computeAvailableSlots -- split hours (lunch gap)", () => {
  const splitHours = effectiveBusinessHours({
    monday: [
      { start: "08:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ],
  });

  test("no slot starts inside the 12:00-13:00 gap", () => {
    const slots = computeAvailableSlots(MONDAY, 30, [], splitHours, NY);
    for (const s of slots) {
      const localHourMinute = s.slice(11, 16);
      assert.ok(!(localHourMinute >= "12:00" && localHourMinute < "13:00"), `unexpected slot inside the gap: ${s}`);
    }
  });

  test("a slot may not start in the morning range and extend into the gap", () => {
    // 90-minute service starting at 11:00 would end at 12:30, crossing the
    // 12:00 close of the morning range -- must not be offered.
    const slots = computeAvailableSlots(MONDAY, 90, [], splitHours, NY);
    assert.ok(!slots.some((s) => s.slice(11, 16) === "11:00"));
  });

  test("slots resume at the start of the afternoon range", () => {
    const slots = computeAvailableSlots(MONDAY, 30, [], splitHours, NY);
    assert.ok(slots.some((s) => s.slice(11, 16) === "13:00"));
  });
});

describe("computeAvailableSlots -- different weekday hours are respected", () => {
  test("a workspace open Saturday but closed Monday reverses the default", () => {
    const hours = effectiveBusinessHours({ monday: [], saturday: [{ start: "09:00", end: "13:00" }] });
    assert.deepEqual(computeAvailableSlots(MONDAY, 60, [], hours, NY), []);
    assert.ok(computeAvailableSlots(SATURDAY, 60, [], hours, NY).length > 0);
  });
});

describe("computeAvailableSlots -- fallback hours when NULL", () => {
  test("effectiveBusinessHours(null) reproduces the exact pre-existing Mon-Fri 07:00-17:00 behavior", () => {
    const withNull = computeAvailableSlots(MONDAY, 60, [], effectiveBusinessHours(null), NY);
    const withDefault = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS, NY);
    assert.deepEqual(withNull, withDefault);
  });

  test("effectiveTimezone(null) (the NULL-workspace fallback) reproduces the exact same slots as passing BUSINESS_TZ directly", () => {
    const withNullTz = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS, effectiveTimezone(null));
    const withExplicitNY = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS, NY);
    assert.deepEqual(withNullTz, withExplicitNY);
  });
});

describe("isSlotAvailable", () => {
  test("unaffected by business hours -- pure busy-range collision check", () => {
    const start = new Date("2026-08-03T13:00:00.000Z");
    const end = new Date("2026-08-03T14:00:00.000Z");
    assert.equal(isSlotAvailable(start, end, []), true);
    assert.equal(isSlotAvailable(start, end, [{ start, end }]), false);
  });
});

describe("isWithinBusinessHours", () => {
  test("a time inside a single default range is within hours", () => {
    const start = new Date("2026-08-03T13:00:00.000Z"); // 09:00 ET
    const end = new Date("2026-08-03T14:00:00.000Z"); // 10:00 ET
    assert.equal(isWithinBusinessHours(start, end, DEFAULT_BUSINESS_HOURS, NY), true);
  });

  test("a closed day (weekend) is never within hours", () => {
    const start = new Date("2026-08-08T13:00:00.000Z");
    const end = new Date("2026-08-08T14:00:00.000Z");
    assert.equal(isWithinBusinessHours(start, end, DEFAULT_BUSINESS_HOURS, NY), false);
  });

  test("a time starting within hours but ending outside the range is rejected", () => {
    // Range: 08:00-12:00 ET. A 2-hour appointment starting at 11:00 would
    // end at 13:00, outside the range.
    const hours = effectiveBusinessHours({ monday: [{ start: "08:00", end: "12:00" }] });
    const start = new Date("2026-08-03T15:00:00.000Z"); // 11:00 ET
    const end = new Date("2026-08-03T17:00:00.000Z"); // 13:00 ET
    assert.equal(isWithinBusinessHours(start, end, hours, NY), false);
  });

  test("a time inside the split-hours lunch gap is rejected", () => {
    const hours = effectiveBusinessHours({
      monday: [
        { start: "08:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    });
    const start = new Date("2026-08-03T16:30:00.000Z"); // 12:30 ET
    const end = new Date("2026-08-03T17:00:00.000Z"); // 13:00 ET
    assert.equal(isWithinBusinessHours(start, end, hours, NY), false);
  });

  test("a time fully inside the afternoon half of a split day is within hours", () => {
    const hours = effectiveBusinessHours({
      monday: [
        { start: "08:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    });
    const start = new Date("2026-08-03T17:00:00.000Z"); // 13:00 ET
    const end = new Date("2026-08-03T18:00:00.000Z"); // 14:00 ET
    assert.equal(isWithinBusinessHours(start, end, hours, NY), true);
  });
});

describe("businessDayBounds / businessDateStringFromInstant / todayBusinessDate -- unaffected by Business Hours", () => {
  test("businessDayBounds returns the UTC instant bounds of the given business-local date", () => {
    const { start, end } = businessDayBounds(MONDAY, NY);
    assert.equal(businessDateStringFromInstant(start, NY), MONDAY);
    assert.ok(end.getTime() > start.getTime());
  });

  test("todayBusinessDate returns a yyyy-MM-dd string", () => {
    assert.match(todayBusinessDate(NY), /^\d{4}-\d{2}-\d{2}$/);
  });
});

// Phase 5D: proves the same customer-facing date produces genuinely
// different (correct) UTC slot instants for every supported workspace
// timezone -- not just that the functions accept a tz argument, but that
// the argument actually changes the result the way a real cross-country
// business would expect.
describe("Phase 5D: computeAvailableSlots / businessDayBounds are correct for every supported timezone, not just NY", () => {
  const CASES: Array<{ tz: string; utcOpenHour: number; label: string }> = [
    // Default hours are 07:00-17:00 local. Each expected UTC hour below is
    // the real, DST-correct offset for 2026-08-03 (a summer date -- every
    // zone here except Phoenix/Hawaii observes DST in August).
    { tz: "America/New_York", utcOpenHour: 11, label: "Eastern (EDT, UTC-4)" },
    { tz: "America/Chicago", utcOpenHour: 12, label: "Central (CDT, UTC-5)" },
    { tz: "America/Denver", utcOpenHour: 13, label: "Mountain (MDT, UTC-6)" },
    { tz: "America/Phoenix", utcOpenHour: 14, label: "Arizona (no DST, UTC-7 year-round)" },
    { tz: "America/Los_Angeles", utcOpenHour: 14, label: "Pacific (PDT, UTC-7)" },
    { tz: "America/Anchorage", utcOpenHour: 15, label: "Alaska (AKDT, UTC-8)" },
    { tz: "Pacific/Honolulu", utcOpenHour: 17, label: "Hawaii (no DST, UTC-10 year-round)" },
  ];

  for (const { tz, utcOpenHour, label } of CASES) {
    test(`${label}: 07:00 local open resolves to ${utcOpenHour}:00 UTC`, () => {
      const slots = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS, tz);
      assert.ok(slots.length > 0, tz);
      assert.equal(new Date(slots[0]).toISOString(), new Date(Date.UTC(2026, 7, 3, utcOpenHour, 0, 0)).toISOString(), tz);
    });
  }

  test("every TIMEZONE_OPTIONS value produces a non-empty slot list for an ordinary open weekday under default hours", () => {
    for (const { value: tz } of TIMEZONE_OPTIONS) {
      assert.ok(computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS, tz).length > 0, tz);
    }
  });

  test("businessDayBounds/businessDateStringFromInstant round-trip correctly for every supported timezone", () => {
    for (const { value: tz } of TIMEZONE_OPTIONS) {
      const { start, end } = businessDayBounds(MONDAY, tz);
      assert.equal(businessDateStringFromInstant(start, tz), MONDAY, tz);
      assert.ok(end.getTime() > start.getTime(), tz);
    }
  });

  test("a UTC instant near midnight maps to the correct business-local calendar date, not the UTC calendar date -- e.g. 2026-08-04T02:00:00Z is still Aug 3 in every US zone (all are west of UTC)", () => {
    const nearMidnightUtc = new Date("2026-08-04T02:00:00.000Z");
    for (const { value: tz } of TIMEZONE_OPTIONS) {
      assert.equal(businessDateStringFromInstant(nearMidnightUtc, tz), "2026-08-03", tz);
    }
  });
});
