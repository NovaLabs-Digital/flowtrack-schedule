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

// A Monday and a Saturday, matching the date convention used elsewhere in
// this suite (e.g. app/api/book/availability/route.test.ts).
const MONDAY = "2026-08-03";
const SATURDAY = "2026-08-08";

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
    assert.equal(isOpenDay(MONDAY, DEFAULT_BUSINESS_HOURS), true);
  });
  test("false for a weekend day under the default hours", () => {
    assert.equal(isOpenDay(SATURDAY, DEFAULT_BUSINESS_HOURS), false);
  });
  test("false for a day with an explicit empty range list", () => {
    const hours = effectiveBusinessHours({ monday: [] });
    assert.equal(isOpenDay(MONDAY, hours), false);
  });
  test("true for a normally-closed day the workspace has opened", () => {
    const hours = effectiveBusinessHours({ saturday: [{ start: "09:00", end: "13:00" }] });
    assert.equal(isOpenDay(SATURDAY, hours), true);
  });
});

describe("computeAvailableSlots -- default (single range) hours", () => {
  test("a closed day (weekend) yields zero slots", () => {
    assert.deepEqual(computeAvailableSlots(SATURDAY, 60, [], DEFAULT_BUSINESS_HOURS), []);
  });

  test("an open day yields slots starting at open and ending by close", () => {
    const slots = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS);
    assert.ok(slots.length > 0);
    assert.ok(slots[0].startsWith("2026-08-03T07:00"));
    assert.ok(slots[slots.length - 1] <= "2026-08-03T17:00");
  });

  test("existing collision rules still apply -- a busy range removes overlapping slots", () => {
    const busyStart = new Date("2026-08-03T13:00:00.000Z"); // 09:00 ET
    const busyEnd = new Date("2026-08-03T14:00:00.000Z"); // 10:00 ET
    const slots = computeAvailableSlots(MONDAY, 60, [{ start: busyStart, end: busyEnd }], DEFAULT_BUSINESS_HOURS);
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
    const slots = computeAvailableSlots(MONDAY, 30, [], splitHours);
    for (const s of slots) {
      const localHourMinute = s.slice(11, 16);
      assert.ok(!(localHourMinute >= "12:00" && localHourMinute < "13:00"), `unexpected slot inside the gap: ${s}`);
    }
  });

  test("a slot may not start in the morning range and extend into the gap", () => {
    // 90-minute service starting at 11:00 would end at 12:30, crossing the
    // 12:00 close of the morning range -- must not be offered.
    const slots = computeAvailableSlots(MONDAY, 90, [], splitHours);
    assert.ok(!slots.some((s) => s.slice(11, 16) === "11:00"));
  });

  test("slots resume at the start of the afternoon range", () => {
    const slots = computeAvailableSlots(MONDAY, 30, [], splitHours);
    assert.ok(slots.some((s) => s.slice(11, 16) === "13:00"));
  });
});

describe("computeAvailableSlots -- different weekday hours are respected", () => {
  test("a workspace open Saturday but closed Monday reverses the default", () => {
    const hours = effectiveBusinessHours({ monday: [], saturday: [{ start: "09:00", end: "13:00" }] });
    assert.deepEqual(computeAvailableSlots(MONDAY, 60, [], hours), []);
    assert.ok(computeAvailableSlots(SATURDAY, 60, [], hours).length > 0);
  });
});

describe("computeAvailableSlots -- fallback hours when NULL", () => {
  test("effectiveBusinessHours(null) reproduces the exact pre-existing Mon-Fri 07:00-17:00 behavior", () => {
    const withNull = computeAvailableSlots(MONDAY, 60, [], effectiveBusinessHours(null));
    const withDefault = computeAvailableSlots(MONDAY, 60, [], DEFAULT_BUSINESS_HOURS);
    assert.deepEqual(withNull, withDefault);
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
    assert.equal(isWithinBusinessHours(start, end, DEFAULT_BUSINESS_HOURS), true);
  });

  test("a closed day (weekend) is never within hours", () => {
    const start = new Date("2026-08-08T13:00:00.000Z");
    const end = new Date("2026-08-08T14:00:00.000Z");
    assert.equal(isWithinBusinessHours(start, end, DEFAULT_BUSINESS_HOURS), false);
  });

  test("a time starting within hours but ending outside the range is rejected", () => {
    // Range: 08:00-12:00 ET. A 2-hour appointment starting at 11:00 would
    // end at 13:00, outside the range.
    const hours = effectiveBusinessHours({ monday: [{ start: "08:00", end: "12:00" }] });
    const start = new Date("2026-08-03T15:00:00.000Z"); // 11:00 ET
    const end = new Date("2026-08-03T17:00:00.000Z"); // 13:00 ET
    assert.equal(isWithinBusinessHours(start, end, hours), false);
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
    assert.equal(isWithinBusinessHours(start, end, hours), false);
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
    assert.equal(isWithinBusinessHours(start, end, hours), true);
  });
});

describe("businessDayBounds / businessDateStringFromInstant / todayBusinessDate -- unaffected by Business Hours", () => {
  test("businessDayBounds returns the UTC instant bounds of the given business-local date", () => {
    const { start, end } = businessDayBounds(MONDAY);
    assert.equal(businessDateStringFromInstant(start), MONDAY);
    assert.ok(end.getTime() > start.getTime());
  });

  test("todayBusinessDate returns a yyyy-MM-dd string", () => {
    assert.match(todayBusinessDate(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
