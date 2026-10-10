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
import { render, screen, cleanup, within } from "@testing-library/react";
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
