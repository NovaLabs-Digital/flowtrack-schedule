// RENDERED verification of the SFT status-display-consistency fix.
//
// lib/statusDisplayConsistency.test.ts proves (by source inspection only)
// that all four surfaces call the shared displayAppointmentStatus function.
// This file goes further, per explicit request: it renders the REAL
// ScheduleGrid.tsx, DispatchPanel.tsx, AppointmentDetailPanel.tsx, and
// MobileAppointmentDetail.tsx components with real React into a jsdom DOM
// -- the same technique already proven for AppointmentModal.render.test.ts
// -- and asserts on the ACTUAL RENDERED TEXT, not source strings.
//
// Scenario: Tami Factor's exact pre-cancellation state -- stored status
// "scheduled", scheduled_end already elapsed, and zero Job Tracking ever
// recorded. Before the fix, AppointmentDetailPanel/MobileAppointmentDetail
// rendered "Completed" here (purely from elapsed time) while ScheduleGrid/
// DispatchPanel rendered "Scheduled" -- a real, now-fixed three-way
// disagreement. This file renders all four with that exact appointment and
// asserts every one shows "Scheduled", then re-renders all four with
// status flipped to "cancelled" and asserts every one shows "Cancelled".
import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_BUSINESS_HOURS } from "../../../lib/businessHours.ts";

// Node cannot import .tsx by itself; opt this file into the transpile hook
// -- the same seam AppointmentModal.render.test.ts already uses.
register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: ScheduleGrid } = await import("./ScheduleGrid.tsx");
const { default: DispatchPanel } = await import("./DispatchPanel.tsx");
const { default: AppointmentDetailPanel } = await import("./AppointmentDetailPanel.tsx");
const { default: MobileAppointmentDetail } = await import("../mobile/MobileAppointmentDetail.tsx");

const TZ = "America/New_York";
const APPT_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Frozen clock (same technique as app/api/appointments/delete/route.test.ts
// and lib/payroll.test.ts's own fixed NOW constants) -- deliberately NOT a
// Date.now()-relative offset. A naive "now minus a few hours" fixture is
// only safe from crossing a calendar-day boundary as long as the real
// wall-clock, converted to the business's OWN timezone (ScheduleGrid's "day"
// view is anchored to nowInBusinessTz, not raw UTC), isn't itself within a
// few hours of its own local midnight -- which it periodically is,
// regardless of what hour UTC happens to read. This is the EXACT bug class
// found live while investigating this fix: lib/completedJobBilling.test.ts
// and ScheduleGrid.reviewIndicator.test.ts both use that same
// Date.now()-relative pattern and both failed, reproducibly, when this
// suite happened to run shortly after business-local (America/New_York)
// midnight. Freezing "now" to a fixed, safely-mid-afternoon, non-DST-edge
// instant removes that ambiguity entirely -- this file is written to never
// join that bug class.
mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-03T18:00:00.000Z").getTime() }); // Mon, 2:00 PM ET

// Tami's own appointment: started 3 hours before the frozen "now" (11:00 AM
// ET), ended 1.5 hours before it (12:30 PM ET) -- elapsed per
// isPastAppointment's own check, same calendar day as the frozen "now" from
// ScheduleGrid's own nowInBusinessTz-anchored day view, and 90 minutes long
// -- over ScheduleGrid's 60-minute "isShort" condensed-card threshold, so
// its full card (including the status text) renders.
function tamiAppt(overrides: Partial<{ status: "scheduled" | "cancelled" }> = {}) {
  const now = Date.now();
  return {
    id: APPT_ID,
    client_id: CLIENT_ID,
    service_type: "Regular Cleaning",
    scheduled_for: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    scheduled_end: new Date(now - 1.5 * 60 * 60 * 1000).toISOString(),
    status: overrides.status ?? "scheduled",
    notes: null,
    duration_minutes: 90,
    series_id: null,
    frequency_type: "one_time" as const,
    repeat_weeks: 1,
    repeat_months: null,
    price_cents: 9000,
    team_color: null,
  };
}
const client = { id: CLIENT_ID, name: "Tami Factor", email: null, phone: "+15551234567" };
const services = [{ id: "s1", name: "Regular Cleaning", description: null, duration_minutes: 90, active: true, color: "#3B82F6", default_price_cents: 9000 }];

afterEach(() => cleanup());

describe("rendered status display: Tami's exact pre-cancellation state (scheduled, elapsed, zero Job Tracking) shows 'Scheduled' everywhere, never 'Completed'", () => {
  test("ScheduleGrid (the calendar): the card shows 'Scheduled'", () => {
    const appt = tamiAppt();
    render(React.createElement(ScheduleGrid, {
      viewMode: "day", clients: [client], appointments: [appt], services, employees: [], employeeHours: [],
      assignments: [], selectedClientId: null, selectedAppointmentId: null,
      onSelectAppointment: () => {}, onEditAppointment: () => {}, onCellClick: () => {}, onDropAppointment: () => {},
      weekOffset: 0, canMutateOperationalData: true, timezone: TZ, businessHours: DEFAULT_BUSINESS_HOURS, paidAppointmentIds: [],
    }));
    assert.ok(screen.getByText("Scheduled"), "the calendar card shows 'Scheduled'");
    assert.equal(screen.queryByText("Completed"), null, "never 'Completed' for a merely-elapsed, never-tracked appointment");
  });

  test("DispatchPanel: the Appointment Details Status row shows 'Scheduled'", () => {
    const appt = tamiAppt();
    render(React.createElement(DispatchPanel, {
      appointments: [appt], clients: [client], employees: [], employeeHours: [], assignments: [],
      selectedAppointmentId: APPT_ID, onHoursSaved: () => {}, canUseJobTracking: true, timezone: TZ,
    }));
    const statusRow = screen.getByText("Status").parentElement!;
    assert.equal(within(statusRow).getByText("Scheduled", { selector: "span" }).textContent, "Scheduled");
  });

  test("AppointmentDetailPanel (desktop): statusLabel shows 'Scheduled', and the separate Past due indicator is shown alongside it", () => {
    const appt = tamiAppt();
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client, employees: [], services, assignments: [], employeeHours: [],
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Scheduled"), "statusLabel renders 'Scheduled'");
    assert.equal(screen.queryByText("Completed"), null);
    assert.ok(screen.getByText("(Past due)"), "the separate past-due indicator is shown");
  });

  test("MobileAppointmentDetail: statusLabel shows 'Scheduled', identical to desktop", () => {
    const appt = tamiAppt();
    render(React.createElement(MobileAppointmentDetail, {
      appointment: appt, client, employees: [], assignments: [], employeeHours: [], durationMinutes: 90,
      onBack: () => {}, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Scheduled"));
    assert.equal(screen.queryByText("Completed"), null);
    assert.ok(screen.getByText("(Past due)"));
  });
});

describe("rendered status display: after the owner records the cancellation, every surface shows 'Cancelled'", () => {
  test("ScheduleGrid: a cancelled appointment is excluded from the calendar's own view entirely (apptsInView filters it out before any card renders) -- confirmed by source inspection (ScheduleGrid.test.ts) and by the ABSENCE of any card here", () => {
    const appt = tamiAppt({ status: "cancelled" });
    render(React.createElement(ScheduleGrid, {
      viewMode: "day", clients: [client], appointments: [appt], services, employees: [], employeeHours: [],
      assignments: [], selectedClientId: null, selectedAppointmentId: null,
      onSelectAppointment: () => {}, onEditAppointment: () => {}, onCellClick: () => {}, onDropAppointment: () => {},
      weekOffset: 0, canMutateOperationalData: true, timezone: TZ, businessHours: DEFAULT_BUSINESS_HOURS, paidAppointmentIds: [],
    }));
    assert.equal(screen.queryByText("Scheduled"), null, "the cancelled appointment never renders a 'Scheduled' card");
    assert.equal(screen.queryByText("Regular Cleaning"), null, "the cancelled appointment's card does not appear on the calendar at all");
  });

  test("DispatchPanel: the Status row shows 'Cancelled'", () => {
    const appt = tamiAppt({ status: "cancelled" });
    render(React.createElement(DispatchPanel, {
      appointments: [appt], clients: [client], employees: [], employeeHours: [], assignments: [],
      selectedAppointmentId: APPT_ID, onHoursSaved: () => {}, canUseJobTracking: true, timezone: TZ,
    }));
    const statusRow = screen.getByText("Status").parentElement!;
    assert.equal(within(statusRow).getByText("Cancelled", { selector: "span" }).textContent, "Cancelled");
  });

  test("AppointmentDetailPanel (desktop): statusLabel shows 'Cancelled', and the Past due indicator is gone (a cancelled appointment is never also past due)", () => {
    const appt = tamiAppt({ status: "cancelled" });
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client, employees: [], services, assignments: [], employeeHours: [],
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Cancelled"));
    assert.equal(screen.queryByText("Scheduled"), null);
    assert.equal(screen.queryByText("(Past due)"), null);
  });

  test("MobileAppointmentDetail: statusLabel shows 'Cancelled', identical to desktop", () => {
    const appt = tamiAppt({ status: "cancelled" });
    render(React.createElement(MobileAppointmentDetail, {
      appointment: appt, client, employees: [], assignments: [], employeeHours: [], durationMinutes: 90,
      onBack: () => {}, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Cancelled"));
    assert.equal(screen.queryByText("Scheduled"), null);
    assert.equal(screen.queryByText("(Past due)"), null);
  });
});

// Franklin International fix (the reported regression, placed on this same
// frozen "now" rather than its real Oct 23 2026 date, so this file's single
// mock.timers.enable call above stays the only clock freeze needed): Teresa's
// Job Tracking genuinely completed (56m, valid); Roxana's raw Job Tracking
// produced an invalid sub-minute gap (both timestamps land in the same
// displayed minute, 9:59 AM -- exactly the "Started and Completed at 9:59 AM"
// symptom from the report), corrected by the owner to 1h14m via
// AdjustWorkedTimeControl. Before the fix, every surface stayed stuck on
// "In Progress" despite both employees' work being fully resolved by the
// owner. "After reloading" is exactly what a fresh render proves here: these
// are pure functions of already-persisted assignment/employeeHours rows --
// there is no cache or one-time state to go stale, so a freshly rendered
// read produces the same correct result a page reload would.
const FRANKLIN_APPT_ID = "22222222-2222-4222-8222-222222222222";
const FRANKLIN_CLIENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const franklinClient = { id: FRANKLIN_CLIENT_ID, name: "Franklin International", email: null, phone: "+15559876543" };
const teresaEmployee = { id: "emp-teresa", name: "Teresa", phone: null, color: "#3B82F6", active: true };
const roxanaEmployee = { id: "emp-roxana", name: "Roxana", phone: null, color: "#10B981", active: true };

function franklinAppt(id = FRANKLIN_APPT_ID) {
  const now = Date.now(); // frozen to 2026-08-03T18:00:00.000Z (2:00 PM ET) above
  return {
    id, client_id: FRANKLIN_CLIENT_ID, service_type: "Regular Cleaning",
    scheduled_for: new Date(now - 5 * 60 * 60 * 1000).toISOString(), // 9:00 AM ET
    scheduled_end: new Date(now - 3.5 * 60 * 60 * 1000).toISOString(), // 10:30 AM ET
    status: "scheduled" as const,
    notes: null, duration_minutes: 90, series_id: null,
    frequency_type: "one_time" as const, repeat_weeks: 1, repeat_months: null,
    price_cents: 15000, team_color: null,
  };
}
function teresaAssignment(appointmentId = FRANKLIN_APPT_ID) {
  const now = Date.now();
  return {
    id: "ae-teresa", appointment_id: appointmentId, employee_id: "emp-teresa",
    actual_started_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(), // 9:00 AM
    actual_completed_at: new Date(now - 5 * 60 * 60 * 1000 + 56 * 60 * 1000).toISOString(), // 9:56 AM, valid 56m
    job_notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
  };
}
// Started and completed 5 seconds apart -- an INVALID gap (isJobTrackingComplete
// is false), both rounding to the same displayed minute ("9:59 AM"), exactly
// the report's own symptom.
function roxanaInvalidGapAssignment(appointmentId = FRANKLIN_APPT_ID) {
  const now = Date.now();
  const roxanaStart = now - 5 * 60 * 60 * 1000 + 59 * 60 * 1000; // 9:59:00 AM
  return {
    id: "ae-roxana", appointment_id: appointmentId, employee_id: "emp-roxana",
    actual_started_at: new Date(roxanaStart).toISOString(),
    actual_completed_at: new Date(roxanaStart + 5_000).toISOString(), // +5s
    job_notes: null, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
  };
}
function franklinHours(appointmentId = FRANKLIN_APPT_ID) {
  return [
    { id: "eh-teresa", appointment_id: appointmentId, employee_id: "emp-teresa", hours_worked: 56 / 60, note: "forgot to clock out", created_at: "", updated_at: "" },
    { id: "eh-roxana", appointment_id: appointmentId, employee_id: "emp-roxana", hours_worked: 74 / 60, note: "forgot to clock in", created_at: "", updated_at: "" },
  ];
}

describe("rendered status display: Franklin International -- an owner correction on an invalid/never-clocked-in gap resolves 'Completed' on every surface, never stuck at 'In Progress'", () => {
  test("ScheduleGrid (the calendar): the card shows 'Completed'", () => {
    const appt = franklinAppt();
    render(React.createElement(ScheduleGrid, {
      viewMode: "day", clients: [franklinClient], appointments: [appt], services: [], employees: [teresaEmployee, roxanaEmployee],
      employeeHours: franklinHours(), assignments: [teresaAssignment(), roxanaInvalidGapAssignment()],
      selectedClientId: null, selectedAppointmentId: null,
      onSelectAppointment: () => {}, onEditAppointment: () => {}, onCellClick: () => {}, onDropAppointment: () => {},
      weekOffset: 0, canMutateOperationalData: true, timezone: TZ, businessHours: DEFAULT_BUSINESS_HOURS, paidAppointmentIds: [],
    }));
    assert.ok(screen.getByText("Completed"), "the calendar card shows 'Completed' once both employees' work is owner-resolved");
    assert.equal(screen.queryByText("In Progress"), null);
  });

  test("DispatchPanel: the Appointment Details Status row shows 'Completed'", () => {
    const appt = franklinAppt();
    render(React.createElement(DispatchPanel, {
      appointments: [appt], clients: [franklinClient], employees: [teresaEmployee, roxanaEmployee],
      employeeHours: franklinHours(), assignments: [teresaAssignment(), roxanaInvalidGapAssignment()],
      selectedAppointmentId: FRANKLIN_APPT_ID, onHoursSaved: () => {}, canUseJobTracking: true, timezone: TZ,
    }));
    const statusRow = screen.getByText("Status").parentElement!;
    assert.equal(within(statusRow).getByText("Completed", { selector: "span" }).textContent, "Completed");
  });

  test("AppointmentDetailPanel (desktop): statusLabel shows 'Completed', and the Past due indicator is gone", () => {
    const appt = franklinAppt();
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client: franklinClient, employees: [teresaEmployee, roxanaEmployee], services: [],
      assignments: [teresaAssignment(), roxanaInvalidGapAssignment()], employeeHours: franklinHours(),
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Completed"));
    assert.equal(screen.queryByText("In Progress"), null);
    assert.equal(screen.queryByText("(Past due)"), null, "genuinely (owner-)completed work is never also flagged past due");
  });

  test("MobileAppointmentDetail: statusLabel shows 'Completed', identical to desktop", () => {
    const appt = franklinAppt();
    render(React.createElement(MobileAppointmentDetail, {
      appointment: appt, client: franklinClient, employees: [teresaEmployee, roxanaEmployee],
      assignments: [teresaAssignment(), roxanaInvalidGapAssignment()], employeeHours: franklinHours(), durationMinutes: 90,
      onBack: () => {}, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Completed"));
    assert.equal(screen.queryByText("In Progress"), null);
    assert.equal(screen.queryByText("(Past due)"), null);
  });

  test("the exact same fixtures re-rendered fresh (simulating a page reload, not a post-save in-memory update) still show 'Completed' on every surface -- this is a pure read/display rule, no data repair required", () => {
    const appt = franklinAppt();
    const assignments = [teresaAssignment(), roxanaInvalidGapAssignment()];
    const hours = franklinHours();

    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client: franklinClient, employees: [teresaEmployee, roxanaEmployee], services: [],
      assignments, employeeHours: hours, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Completed"), "AppointmentDetailPanel must show 'Completed' on a fresh render from already-persisted data");
    cleanup();

    render(React.createElement(MobileAppointmentDetail, {
      appointment: appt, client: franklinClient, employees: [teresaEmployee, roxanaEmployee],
      assignments, employeeHours: hours, durationMinutes: 90,
      onBack: () => {}, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Completed"), "MobileAppointmentDetail must show 'Completed' on a fresh render from already-persisted data");
  });
});

describe("rendered status display: Franklin International, mixed case -- Roxana's invalid gap has NOT yet been reviewed by the owner, so every surface correctly stays 'In Progress'", () => {
  const MIXED_APPT_ID = "33333333-3333-4333-8333-333333333333";

  test("ScheduleGrid: the card shows 'In Progress', never prematurely 'Completed'", () => {
    const appt = franklinAppt(MIXED_APPT_ID);
    render(React.createElement(ScheduleGrid, {
      viewMode: "day", clients: [franklinClient], appointments: [appt], services: [], employees: [teresaEmployee, roxanaEmployee],
      employeeHours: [franklinHours(MIXED_APPT_ID)[0]] /* only Teresa reviewed */,
      assignments: [teresaAssignment(MIXED_APPT_ID), roxanaInvalidGapAssignment(MIXED_APPT_ID)],
      selectedClientId: null, selectedAppointmentId: null,
      onSelectAppointment: () => {}, onEditAppointment: () => {}, onCellClick: () => {}, onDropAppointment: () => {},
      weekOffset: 0, canMutateOperationalData: true, timezone: TZ, businessHours: DEFAULT_BUSINESS_HOURS, paidAppointmentIds: [],
    }));
    assert.ok(screen.getByText("In Progress"));
    assert.equal(screen.queryByText("Completed"), null);
  });

  test("AppointmentDetailPanel: statusLabel shows 'In Progress', and the Past due indicator correctly appears (nothing is over-corrected)", () => {
    const appt = franklinAppt(MIXED_APPT_ID);
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client: franklinClient, employees: [teresaEmployee, roxanaEmployee], services: [],
      assignments: [teresaAssignment(MIXED_APPT_ID), roxanaInvalidGapAssignment(MIXED_APPT_ID)],
      employeeHours: [franklinHours(MIXED_APPT_ID)[0]],
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("In Progress"));
    assert.equal(screen.queryByText("Completed"), null);
    assert.ok(screen.getByText("(Past due)"), "an unresolved, elapsed appointment is still correctly flagged past due");
  });
});

// Save-flow verification (explicitly requested): proves the fix through the
// REAL owner interaction, not just a before/after prop swap -- the owner
// opens AdjustWorkedTimeControl's "missing" variant for Roxana (her invalid
// gap puts her in missingHoursEmployeeIds, same as the real report), enters
// Clock-in/Clock-out/Reason, and clicks Save. A Host component holds
// employeeHours as real React state (exactly like DashboardShell does in
// production) and wires DispatchPanel's onHoursSaved to update it, so the
// status flip happens via the SAME save -> state-update -> re-render path
// the live app uses, not a hand-constructed "after" fixture. Only
// /api/appointments/employee-hours is faked here (DispatchPanel renders no
// other fetching component), matching BillingPanel.test.ts's established
// fetch-mocking pattern.
describe("save-flow verification: an owner correction submitted live through AdjustWorkedTimeControl flips the displayed status from 'In Progress' to 'Completed', without a page reload", () => {
  const SAVE_FLOW_APPT_ID = "44444444-4444-4444-8444-444444444444";
  const originalFetch = globalThis.fetch;

  function Host() {
    const [employeeHours, setEmployeeHours] = React.useState(() => [franklinHours(SAVE_FLOW_APPT_ID)[0]]); // only Teresa reviewed so far
    return React.createElement(DispatchPanel, {
      appointments: [franklinAppt(SAVE_FLOW_APPT_ID)],
      clients: [franklinClient],
      employees: [teresaEmployee, roxanaEmployee],
      employeeHours,
      assignments: [teresaAssignment(SAVE_FLOW_APPT_ID), roxanaInvalidGapAssignment(SAVE_FLOW_APPT_ID)],
      selectedAppointmentId: SAVE_FLOW_APPT_ID,
      onHoursSaved: (entry: unknown) => setEmployeeHours((prev) => [...prev, entry as typeof employeeHours[number]]),
      canUseJobTracking: true,
      timezone: TZ,
    });
  }

  test("before saving: the Status row shows 'In Progress' (Roxana's invalid gap is still unresolved)", () => {
    render(React.createElement(Host));
    const statusRow = screen.getByText("Status").parentElement!;
    assert.equal(within(statusRow).getByText("In Progress", { selector: "span" }).textContent, "In Progress");
  });

  test("the owner fills Clock-in/Clock-out/Reason and clicks 'Save Worked Time' -- after the real POST resolves and onHoursSaved updates state, the SAME mounted Status row flips to 'Completed'", async () => {
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        assert.ok(url.includes("/api/appointments/employee-hours"), `unexpected fetch to ${url}`);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.appointment_id, SAVE_FLOW_APPT_ID);
        assert.equal(body.employee_id, "emp-roxana");
        const entry = {
          id: "eh-roxana-live", appointment_id: body.appointment_id, employee_id: body.employee_id,
          hours_worked: body.hours_worked, note: body.note, created_at: "2026-08-03T18:00:00.000Z", updated_at: "2026-08-03T18:00:00.000Z",
        };
        return new Response(JSON.stringify({ entry }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      render(React.createElement(Host));
      const statusRow = screen.getByText("Status").parentElement!;
      assert.equal(within(statusRow).getByText("In Progress", { selector: "span" }).textContent, "In Progress", "sanity check before saving");

      // jsdom's <input type="time"> needs a cleared field + digits-only
      // input (no colon) via userEvent.type -- same technique as
      // AdjustWorkedTimeControl.test.ts's own setTime helper.
      const clockIn = screen.getByLabelText("Corrected clock-in time");
      await userEvent.clear(clockIn);
      await userEvent.type(clockIn, "0959");
      const clockOut = screen.getByLabelText("Corrected clock-out time");
      await userEvent.clear(clockOut);
      await userEvent.type(clockOut, "1113");
      await userEvent.type(screen.getByLabelText("Correction reason"), "forgot to clock in");
      await userEvent.click(screen.getByText("Save Worked Time"));

      await waitFor(() => {
        assert.equal(within(statusRow).getByText("Completed", { selector: "span" }).textContent, "Completed");
      });
      assert.equal(within(statusRow).queryByText("In Progress"), null, "must not still show the stale pre-save status");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
