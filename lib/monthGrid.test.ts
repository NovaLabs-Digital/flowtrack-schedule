// Phase 3 (Month Calendar View): direct unit tests for lib/monthGrid.ts's
// pure calendar-math and appointment-grouping helpers. These get real,
// executable coverage (unlike ScheduleMonthGrid.tsx itself, a .tsx file
// this repo's test runner cannot load -- see ScheduleMonthGrid.test.ts for
// that file's source-level proof instead).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildMonthGrid,
  shiftMonth,
  dateKey,
  formatMonthYear,
  formatChipTime,
  groupAppointmentsByDate,
  MAX_VISIBLE_CHIPS_PER_DAY,
} from "./monthGrid";
import type { Appointment } from "@/app/components/dashboard/types";

function appt(overrides: Partial<Appointment> & { id: string; scheduled_for: string }): Appointment {
  return {
    client_id: "client-1",
    service_type: "Regular",
    status: "scheduled",
    notes: null,
    ...overrides,
  };
}

describe("buildMonthGrid -- calendar structure", () => {
  test("Monday-Sunday column order: every week row has exactly 7 days, starting Monday and ending Sunday", () => {
    const weeks = buildMonthGrid(2026, 7); // August 2026 (JS month index 7)
    for (const week of weeks) {
      assert.equal(week.length, 7);
      assert.equal(week[0].date.getDay(), 1, "first column must be Monday");
      assert.equal(week[6].date.getDay(), 0, "last column must be Sunday");
    }
  });

  test("August 2026 requires 6 rows, with the exact leading/trailing adjacent-month dates from the approved mockup (Mon Jul 27 -> Sun Sep 6)", () => {
    const weeks = buildMonthGrid(2026, 7); // August
    assert.equal(weeks.length, 6);
    const allDays = weeks.flat();
    assert.equal(allDays.length, 42);
    assert.equal(allDays[0].date.getFullYear(), 2026);
    assert.equal(allDays[0].date.getMonth(), 6); // July
    assert.equal(allDays[0].date.getDate(), 27);
    assert.equal(allDays[0].inCurrentMonth, false, "Jul 27 is adjacent-month, muted");
    assert.equal(allDays[allDays.length - 1].date.getMonth(), 8); // September
    assert.equal(allDays[allDays.length - 1].date.getDate(), 6);
    assert.equal(allDays[allDays.length - 1].inCurrentMonth, false);
    // Aug 1 (a Saturday) is the 6th cell of week 1, matching the approved
    // mockup's own worked example exactly: "27 | 28 | 29 | 30 | 31 | 1 | 2".
    assert.equal(weeks[0].map((d) => d.date.getDate()).join("|"), "27|28|29|30|31|1|2");
    assert.equal(weeks[0][5].inCurrentMonth, true);
  });

  test("January 2026 requires 5 rows, with December (previous year) leading days and February trailing days", () => {
    const weeks = buildMonthGrid(2026, 0); // January
    assert.equal(weeks.length, 5);
    const first = weeks[0][0].date;
    assert.equal(first.getFullYear(), 2025);
    assert.equal(first.getMonth(), 11); // December
    assert.equal(first.getDate(), 29);
    assert.equal(weeks[0][0].inCurrentMonth, false);
    const last = weeks[weeks.length - 1][6].date;
    assert.equal(last.getFullYear(), 2026);
    assert.equal(last.getMonth(), 1); // February
    assert.equal(last.getDate(), 1);
    assert.equal(weeks[weeks.length - 1][6].inCurrentMonth, false);
  });

  test("leap-year February (2028) includes Feb 29 and is flagged as in-current-month", () => {
    const weeks = buildMonthGrid(2028, 1); // February
    const feb29 = weeks.flat().find((d) => d.date.getMonth() === 1 && d.date.getDate() === 29);
    assert.ok(feb29, "Feb 29, 2028 must appear in the grid");
    assert.equal(feb29!.inCurrentMonth, true);
    assert.equal(weeks.length, 5);
  });

  test("non-leap-year February (2026) has no Feb 29", () => {
    const weeks = buildMonthGrid(2026, 1);
    const feb29 = weeks.flat().find((d) => d.date.getMonth() === 1 && d.date.getDate() === 29);
    assert.equal(feb29, undefined);
  });

  test("every day cell is exactly one calendar day after the previous one, with no gap or overlap", () => {
    const weeks = buildMonthGrid(2026, 7);
    const allDays = weeks.flat();
    for (let i = 1; i < allDays.length; i++) {
      const deltaMs = allDays[i].date.getTime() - allDays[i - 1].date.getTime();
      assert.equal(deltaMs, 86_400_000);
    }
  });
});

describe("formatMonthYear -- the Schedule header's displayed month/year", () => {
  test("formats as full month name + year", () => {
    assert.equal(formatMonthYear(2026, 7), "August 2026");
    assert.equal(formatMonthYear(2028, 1), "February 2028");
    assert.equal(formatMonthYear(2025, 11), "December 2025");
  });
});

describe("shiftMonth -- true calendar-month arithmetic for Today/Prev/Next", () => {
  test("Today (delta 0) returns the same month unchanged", () => {
    assert.deepEqual(shiftMonth(2026, 7, 0), { year: 2026, month: 7 });
  });

  test("Prev/Next within the same year", () => {
    assert.deepEqual(shiftMonth(2026, 7, -1), { year: 2026, month: 6 }); // Aug -> Jul
    assert.deepEqual(shiftMonth(2026, 7, 1), { year: 2026, month: 8 }); // Aug -> Sep
  });

  test("Dec -> Jan year transition (Next from December rolls into next January)", () => {
    assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  });

  test("Jan -> Dec previous-year transition (Prev from January rolls into last December)", () => {
    assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  });

  test("never approximates a month as 30 days -- multi-month jumps land on the exact target month regardless of how many days those months actually have", () => {
    // Jan(31) + Feb(28, 2026 non-leap) + Mar(31) = 90 days, not 3*30=90 by
    // coincidence here -- use a case where the day-count approximation
    // would actually diverge: Feb(28) + Mar(31) from March is 2 months,
    // landing exactly on May regardless of the 59 actual days involved.
    assert.deepEqual(shiftMonth(2026, 2, 2), { year: 2026, month: 4 }); // Mar -> May
    assert.deepEqual(shiftMonth(2026, 0, 13), { year: 2027, month: 1 }); // 13 months from Jan 2026 -> Feb 2027
  });
});

describe("dateKey -- stable per-day grouping key", () => {
  test("zero-pads month and day", () => {
    assert.equal(dateKey(new Date(2026, 0, 5)), "2026-01-05");
    assert.equal(dateKey(new Date(2026, 10, 30)), "2026-11-30");
  });
});

describe("formatChipTime -- compact chip time label matches the approved mockup exactly", () => {
  test("12-hour, always includes minutes (even :00), no AM/PM suffix", () => {
    assert.equal(formatChipTime(new Date(2026, 0, 1, 9, 0)), "9:00");
    assert.equal(formatChipTime(new Date(2026, 0, 1, 11, 0)), "11:00");
    assert.equal(formatChipTime(new Date(2026, 0, 1, 13, 0)), "1:00"); // 1:00 PM, matches the mockup's "1:00 Tami"
    assert.equal(formatChipTime(new Date(2026, 0, 1, 0, 5)), "12:05"); // midnight hour
    assert.equal(formatChipTime(new Date(2026, 0, 1, 14, 15)), "2:15");
  });
});

describe("groupAppointmentsByDate -- appointment placement, ordering, and cancelled-status visibility", () => {
  const localize = (iso: string) => new Date(iso);

  test("an appointment appears under its own calendar date's key", () => {
    const a = appt({ id: "a1", scheduled_for: "2026-08-05T09:00:00" });
    const grouped = groupAppointmentsByDate([a], localize);
    assert.deepEqual(grouped.get("2026-08-05"), [a]);
  });

  test("multiple appointments on the same day are ordered chronologically by scheduled start time, regardless of input order", () => {
    const late = appt({ id: "late", scheduled_for: "2026-08-05T13:00:00" });
    const early = appt({ id: "early", scheduled_for: "2026-08-05T09:00:00" });
    const mid = appt({ id: "mid", scheduled_for: "2026-08-05T11:00:00" });
    const grouped = groupAppointmentsByDate([late, early, mid], localize);
    assert.deepEqual(grouped.get("2026-08-05")!.map((a) => a.id), ["early", "mid", "late"]);
  });

  test("cancelled appointments are excluded entirely -- matches ScheduleGrid's existing visibility rule", () => {
    const scheduled = appt({ id: "keep", scheduled_for: "2026-08-05T09:00:00", status: "scheduled" });
    const cancelled = appt({ id: "drop", scheduled_for: "2026-08-05T10:00:00", status: "cancelled" });
    const grouped = groupAppointmentsByDate([scheduled, cancelled], localize);
    assert.deepEqual(grouped.get("2026-08-05")!.map((a) => a.id), ["keep"]);
  });

  test("appointments on different days are never duplicated across days", () => {
    const a = appt({ id: "a1", scheduled_for: "2026-08-05T09:00:00" });
    const b = appt({ id: "a2", scheduled_for: "2026-08-06T09:00:00" });
    const grouped = groupAppointmentsByDate([a, b], localize);
    assert.equal(grouped.size, 2);
    assert.deepEqual(grouped.get("2026-08-05")!.map((x) => x.id), ["a1"]);
    assert.deepEqual(grouped.get("2026-08-06")!.map((x) => x.id), ["a2"]);
  });

  test("a day with more appointments than MAX_VISIBLE_CHIPS_PER_DAY still returns the full list (chip-limiting is the component's job, not this grouping function's)", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      appt({ id: `a${i}`, scheduled_for: `2026-08-05T${String(9 + i).padStart(2, "0")}:00:00` })
    );
    const grouped = groupAppointmentsByDate(many, localize);
    assert.equal(grouped.get("2026-08-05")!.length, 5);
    // The busy-day "+N more" math the component performs on top of this:
    const visible = grouped.get("2026-08-05")!.slice(0, MAX_VISIBLE_CHIPS_PER_DAY);
    const hidden = grouped.get("2026-08-05")!.length - visible.length;
    assert.equal(visible.length, 3);
    assert.equal(hidden, 2, "exactly '+2 more' for a 5-appointment day with a max of 3 visible");
  });
});

describe("MAX_VISIBLE_CHIPS_PER_DAY", () => {
  test("is exactly 3, matching the approved spec's example", () => {
    assert.equal(MAX_VISIBLE_CHIPS_PER_DAY, 3);
  });
});
