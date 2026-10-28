// Direct unit tests for lib/calendarNavigation.ts's resolveCalendarNavigation
// -- the fix for a reported bug: selecting an appointment from Needs
// Attention (e.g. Owen's Sep 25 appointment) updated the detail panels but
// left the calendar grid showing whatever week it already happened to be
// on (e.g. Oct 26-30), with the "selected" appointment nowhere on screen.
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { resolveCalendarNavigation } from "./calendarNavigation.ts";

const TZ = "America/New_York";

// Frozen "now": Tuesday 2026-10-27, 14:00 America/New_York (18:00 UTC --
// still EDT/UTC-4, DST doesn't end until the following Sunday). Matches
// the reported bug's own "today" context (the grid was showing Oct 26-30,
// i.e. the week containing this date).
mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T18:00:00.000Z").getTime() });

function apptIso(isoDate: string) {
  // Midday UTC is safely within the same business-local calendar date for
  // America/New_York across the whole year (no DST-boundary edge case).
  return `${isoDate}T16:00:00.000Z`;
}

describe("resolveCalendarNavigation -- 'weekdays' view", () => {
  test("a weekday target in the SAME week: view stays 'weekdays', weekOffset is 0", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-29"), "weekdays", TZ); // Thursday, same week as "now"
    assert.deepEqual(nav, { viewMode: "weekdays", weekOffset: 0, monthOffset: 0 });
  });

  test("a weekday target 2 weeks in the future: view stays 'weekdays', weekOffset is 2", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-11-10"), "weekdays", TZ); // Tuesday, 2 weeks later
    assert.equal(nav.viewMode, "weekdays");
    assert.equal(nav.weekOffset, 2);
  });

  test("a WEEKEND target (even in the same week): 'weekdays' cannot show it, so it upgrades to 'week'", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-31"), "weekdays", TZ); // Saturday, same week as "now"
    assert.equal(nav.viewMode, "week", "weekdays view structurally cannot show a Saturday/Sunday appointment");
    assert.equal(nav.weekOffset, 0);
  });

  test("a weekday target that matches the reported bug (Sep 25, a Friday, with 'now' on Oct 27): resolves to a negative weekOffset, view stays 'weekdays'", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-09-25"), "weekdays", TZ);
    assert.equal(nav.viewMode, "weekdays");
    assert.ok(nav.weekOffset < 0, "Sep 25 is before the currently-displayed week, so the offset must be negative");
  });
});

describe("resolveCalendarNavigation -- 'week' view (can already show any date)", () => {
  test("a weekend target: view stays 'week' (never needs to change further)", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-25"), "week", TZ); // Sunday, the week BEFORE "now"
    assert.equal(nav.viewMode, "week");
    assert.equal(nav.weekOffset, -1);
  });

  test("a weekday target: view stays 'week'", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-29"), "week", TZ);
    assert.equal(nav.viewMode, "week");
    assert.equal(nav.weekOffset, 0);
  });
});

describe("resolveCalendarNavigation -- 'month' view (can already show any date)", () => {
  test("a target 2 calendar months in the future: view stays 'month', monthOffset is 2", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-12-15"), "month", TZ);
    assert.equal(nav.viewMode, "month");
    assert.equal(nav.monthOffset, 2);
  });

  test("a target 2 calendar months in the past: monthOffset is -2", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-08-15"), "month", TZ);
    assert.equal(nav.viewMode, "month");
    assert.equal(nav.monthOffset, -2);
  });

  test("weekOffset is still computed even though 'month' view doesn't use it -- matches handleGoToday's own 'always reset both' precedent", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-11-10"), "month", TZ);
    assert.equal(nav.weekOffset, 2);
  });
});

describe("resolveCalendarNavigation -- 'day' view (can only ever show the same weekday-of-week as today, stepped by whole weeks -- see ScheduleGrid.tsx's viewDays)", () => {
  test("a weekday target: 'day' switches to 'weekdays', since it cannot target an arbitrary date itself", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-29"), "day", TZ); // Thursday
    assert.equal(nav.viewMode, "weekdays");
    assert.equal(nav.weekOffset, 0);
  });

  test("a weekend target: 'day' switches to 'week'", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-31"), "day", TZ); // Saturday
    assert.equal(nav.viewMode, "week");
    assert.equal(nav.weekOffset, 0);
  });
});

describe("resolveCalendarNavigation -- same-day target", () => {
  test("a target on the exact same business-local day as 'now': weekOffset and monthOffset are both 0, view is preserved when it's weekday-capable", () => {
    const nav = resolveCalendarNavigation(apptIso("2026-10-27"), "weekdays", TZ); // same Tuesday as "now"
    assert.deepEqual(nav, { viewMode: "weekdays", weekOffset: 0, monthOffset: 0 });
  });
});
