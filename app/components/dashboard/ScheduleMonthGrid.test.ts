// Phase 3 (Month Calendar View): source-level proof tests for
// ScheduleMonthGrid.tsx. Like every other dashboard .tsx production file in
// this repo (ScheduleGrid.test.ts, AppointmentModal.test.ts, TopBar.test.ts,
// LeftBar.test.ts), this file cannot be loaded by Node's built-in test
// runner -- these tests prove what source inspection can prove: which
// helpers are used, which callbacks are wired to which interactions, and
// the structural absence of anything out of this phase's scope (drag/drop,
// cell-click-to-create, a new mutation path, a new API call). The actual
// calendar arithmetic and appointment-grouping logic this component renders
// gets real, executable coverage in lib/monthGrid.test.ts instead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./ScheduleMonthGrid.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");
const scheduleGridSource = fs.readFileSync(fileURLToPath(new URL("./ScheduleGrid.tsx", import.meta.url)), "utf8");

describe("calendar structure -- built from the tested pure helpers, not reimplemented inline", () => {
  test("imports buildMonthGrid/shiftMonth/dateKey/formatMonthYear/formatChipTime/groupAppointmentsByDate/MAX_VISIBLE_CHIPS_PER_DAY from lib/monthGrid, not a local reimplementation", () => {
    assert.match(source, /import \{\s*buildMonthGrid,\s*shiftMonth,\s*dateKey,\s*formatMonthYear,\s*formatChipTime,\s*groupAppointmentsByDate,\s*MAX_VISIBLE_CHIPS_PER_DAY,\s*\} from "@\/lib\/monthGrid";/);
  });

  test("the weekday header order is Mon, Tue, Wed, Thu, Fri, Sat, Sun", () => {
    assert.ok(source.includes('const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];'));
  });

  test("the grid is built for (anchor.year, anchor.month), where anchor comes from shiftMonth(now, monthOffset) -- not the hourly grid's weekOffset", () => {
    assert.ok(source.includes("const anchor = shiftMonth(now.getFullYear(), now.getMonth(), monthOffset);"));
    assert.ok(source.includes("const weeks = buildMonthGrid(anchor.year, anchor.month);"));
    // "weekOffset" legitimately appears once, by name, only in a doc comment
    // explaining monthOffset's own relationship to it -- never as an actual
    // prop, variable, or destructured field in this component.
    assert.ok(!/\bweekOffset\s*[:=]/.test(source), "Month view must not read the hourly grid's weekOffset as a prop/variable");
  });

  test("\"now\" is resolved via nowInBusinessTz, the same business-timezone convention ScheduleGrid.tsx already uses for today/day-bucketing", () => {
    assert.ok(source.includes('import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";'));
    assert.ok(source.includes("const now = nowInBusinessTz();"));
  });
});

describe("header identifies the displayed month, matching ScheduleGrid's existing typography", () => {
  test("renders \"Schedule\" with the same className ScheduleGrid.tsx uses", () => {
    const scheduleTitleMatch = scheduleGridSource.match(/<div className="([^"]*)">Schedule<\/div>/);
    assert.ok(scheduleTitleMatch, "expected to find ScheduleGrid's own Schedule title className");
    assert.ok(source.includes(`<div className="${scheduleTitleMatch![1]}">Schedule</div>`));
  });

  test("the subtitle is formatMonthYear(anchor.year, anchor.month), e.g. \"August 2026\" -- not a week-range string", () => {
    assert.ok(source.includes("{formatMonthYear(anchor.year, anchor.month)}"));
    assert.ok(!source.includes("formatWeekRange"));
  });
});

describe("appointment chips -- content, truncation, ordering, and busy-day '+N more'", () => {
  test("appointments are grouped via groupAppointmentsByDate(appointments, toBusinessLocal) -- the same business-local day-bucketing convention as ScheduleGrid, and the same function that excludes cancelled appointments and orders chronologically", () => {
    assert.ok(source.includes("const apptsByDate = groupAppointmentsByDate(appointments, toBusinessLocal);"));
  });

  test("each day cell shows at most MAX_VISIBLE_CHIPS_PER_DAY chips, with a '+N more' indicator for the remainder", () => {
    assert.ok(source.includes("const visible = dayAppts.slice(0, MAX_VISIBLE_CHIPS_PER_DAY);"));
    assert.ok(source.includes("const hiddenCount = dayAppts.length - visible.length;"));
    assert.match(source, /\+\{hiddenCount\} more/);
  });

  test("a chip's visible text uses formatChipTime (compact, no AM/PM), client name, and service_type -- never price_cents, notes, or other private detail", () => {
    assert.ok(source.includes("{formatChipTime(toBusinessLocal(appt.scheduled_for))}"));
    assert.ok(source.includes("{clientName(appt.client_id)}"));
    assert.ok(source.includes("{appt.service_type}"));
    for (const forbidden of ["price_cents", "appt.notes", "Projected Revenue"]) {
      assert.ok(!source.includes(forbidden), `Month chips must not surface "${forbidden}"`);
    }
  });

  test("chip text uses a truncating, single-line layout (no expanding/breaking the grid for a long name)", () => {
    const chipButtonIdx = source.indexOf("<button\n                              key={appt.id}");
    assert.notEqual(chipButtonIdx, -1);
    const chipBlock = source.slice(chipButtonIdx, chipButtonIdx + 900);
    assert.ok(chipBlock.includes("truncate"));
  });

  test("a subtle team/employee accent color is applied via the existing shared resolveTeamAccentColor rule, not a new color scheme", () => {
    assert.ok(source.includes('import { resolveTeamAccentColor } from "@/lib/teamColor";'));
    assert.ok(source.includes("function accentColorFor(appt: Appointment): string | null {"));
    assert.ok(source.includes("resolveTeamAccentColor(assignmentsByApptId.get(appt.id) ?? [], employeeMap, appt.team_color)"));
  });
});

describe("appointment interaction reuses the existing selection/edit behavior -- no new appointment-management system", () => {
  test("clicking a chip calls the same onSelectAppointment prop DashboardShell already wires to the hourly ScheduleGrid's cards", () => {
    assert.match(source, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); onSelectAppointment\(appt\.id\); \}\}/);
  });

  test("double-clicking a chip calls onEditAppointment, matching ScheduleGrid's own onDoubleClick convention exactly", () => {
    assert.match(source, /onDoubleClick=\{\(e\) => \{ e\.stopPropagation\(\); onEditAppointment\?\.\(appt\.id\); \}\}/);
    assert.ok(scheduleGridSource.includes('onDoubleClick={(e) => { e.stopPropagation(); onEditAppointment?.(a.id); }}'), "ScheduleGrid's own convention this mirrors");
  });

  test("DashboardShell wires the SAME handleSelectAppointment/handleEditAppointment callbacks to ScheduleMonthGrid that it already wires to ScheduleGrid -- no separate Month-specific handler functions exist", () => {
    const monthIdx = shellSource.indexOf("<ScheduleMonthGrid");
    const monthClose = shellSource.indexOf("/>", monthIdx);
    const monthJsx = shellSource.slice(monthIdx, monthClose);
    assert.match(monthJsx, /onSelectAppointment=\{handleSelectAppointment\}/);
    assert.match(monthJsx, /onEditAppointment=\{handleEditAppointment\}/);

    const gridIdx = shellSource.indexOf("<ScheduleGrid");
    const gridClose = shellSource.indexOf("/>", gridIdx);
    const gridJsx = shellSource.slice(gridIdx, gridClose);
    assert.match(gridJsx, /onSelectAppointment=\{handleSelectAppointment\}/);
    assert.match(gridJsx, /onEditAppointment=\{handleEditAppointment\}/);
  });

  test("selected-appointment state renders a highlight, reusing the same blue-ring convention as ScheduleGrid's cards", () => {
    assert.ok(source.includes("const selected = appt.id === selectedAppointmentId;"));
    assert.ok(source.includes("ring-1 ring-blue-600 bg-blue-100/60"));
  });
});

describe("no Month-view drag-and-drop, no cell-click-to-create -- overview/select only, per this phase's explicit scope", () => {
  test("this file contains no draggable attribute and no drag event handlers", () => {
    for (const forbidden of ["draggable", "onDragStart", "onDragOver", "onDragLeave", "onDrop", "onDropAppointment", "DataTransfer"]) {
      assert.ok(!source.includes(forbidden), `ScheduleMonthGrid.tsx must not contain "${forbidden}"`);
    }
  });

  test("this component does not accept an onDropAppointment or onCellClick prop -- Day/Weekdays/Week's drag/drop and click-to-create architecture is untouched and not duplicated here", () => {
    assert.ok(!source.includes("onDropAppointment"));
    assert.ok(!source.includes("onCellClick"));
  });

  test("DashboardShell does not pass onDropAppointment or onCellClick to ScheduleMonthGrid", () => {
    const monthIdx = shellSource.indexOf("<ScheduleMonthGrid");
    const monthClose = shellSource.indexOf("/>", monthIdx);
    const monthJsx = shellSource.slice(monthIdx, monthClose);
    assert.ok(!monthJsx.includes("onDropAppointment"));
    assert.ok(!monthJsx.includes("onCellClick"));
  });
});

describe("view-swap wiring in DashboardShell -- Month is an explicit branch, never a silent fallback onto Week", () => {
  test("DashboardShell renders ScheduleMonthGrid only when viewMode === \"month\", ScheduleGrid otherwise -- an explicit ternary, not a default case", () => {
    assert.ok(shellSource.includes('{viewMode === "month" ? ('));
    const monthIdx = shellSource.indexOf('{viewMode === "month" ? (');
    const scheduleMonthGridIdx = shellSource.indexOf("<ScheduleMonthGrid", monthIdx);
    const elseIdx = shellSource.indexOf(") : (", monthIdx);
    const scheduleGridIdx = shellSource.indexOf("<ScheduleGrid", elseIdx);
    assert.ok(monthIdx < scheduleMonthGridIdx && scheduleMonthGridIdx < elseIdx && elseIdx < scheduleGridIdx);
  });

  test("everything else in the schedule center column (AppointmentDetailPanel/ClientPanel below, TopBar above) is rendered identically regardless of which grid is shown -- the ternary is scoped to only the grid itself", () => {
    const dataTourIdx = shellSource.indexOf('data-tour="schedule-grid"');
    const ternaryIdx = shellSource.indexOf('{viewMode === "month" ? (', dataTourIdx);
    assert.notEqual(dataTourIdx, -1);
    assert.notEqual(ternaryIdx, -1);
    assert.ok(ternaryIdx - dataTourIdx < 400, "the ternary must be the immediate content of the schedule-grid wrapper, not wrap unrelated surrounding UI too");
  });
});

describe("data loading -- reuses the exact appointment collection already loaded by the dashboard, no new fetch/route", () => {
  test("this file makes no network request of its own (no fetch, no API route string)", () => {
    assert.ok(!source.includes("fetch("));
    assert.ok(!/["']\/api\//.test(source));
  });

  test("appointments/clients/employees/assignments arrive as plain props, the same shape DashboardShell already threads to ScheduleGrid", () => {
    assert.match(source, /appointments: Appointment\[\];/);
    assert.match(source, /clients: Client\[\];/);
    assert.match(source, /employees: Employee\[\];/);
    assert.match(source, /assignments: AppointmentEmployeeAssignment\[\];/);
  });
});

describe("no leaked internal detail (matches the hygiene convention already established for every other dashboard component)", () => {
  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `ScheduleMonthGrid.tsx must not contain "${forbidden}"`);
    }
  });

  test("no session/fetch-based re-derivation -- every input arrives as a prop", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `ScheduleMonthGrid.tsx must not contain "${forbidden}"`);
    }
  });
});
