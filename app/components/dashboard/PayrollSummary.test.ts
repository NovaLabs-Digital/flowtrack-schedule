// RENDERED verification of PayrollSummary's Needs Review indicator ("Weekly
// Worked Hours" card). PayrollSummary.tsx is small and has only computePayrollRows
// (a plain function) as a real dependency, so this uses the same TSX-transpile
// hook AppointmentModal.render.test.ts established, rather than source
// inspection -- it renders the REAL component with REAL data through the REAL
// computePayrollRows (lib/payroll.ts), not a mock.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import type { Appointment, Employee, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: PayrollSummary } = await import("./PayrollSummary.tsx");

afterEach(() => cleanup());

const TZ = "America/New_York";
const WIDE_RANGE = { rangeStart: "2000-01-01", rangeEnd: "2100-01-01" };
const HOUR_MS = 60 * 60 * 1000;

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1", client_id: "client-1", service_type: "Regular Cleaning",
    scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(), status: "scheduled", notes: null,
    ...overrides,
  };
}
function assignment(overrides: Partial<AppointmentEmployeeAssignment> = {}): AppointmentEmployeeAssignment {
  return {
    id: "ae-1", appointment_id: "appt-1", employee_id: "roxana", actual_started_at: null, actual_completed_at: null,
    job_notes: null, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
const employees: Employee[] = [{ id: "roxana", name: "Roxana", phone: null, color: "#000", active: true }];

function renderSummary(props: { appointments: Appointment[]; assignments: AppointmentEmployeeAssignment[] }) {
  render(
    React.createElement(PayrollSummary, {
      appointments: props.appointments, employees, employeeHours: [], assignments: props.assignments,
      ...WIDE_RANGE, onRangeStartChange: () => {}, onRangeEndChange: () => {}, timezone: TZ,
    })
  );
}

describe("PayrollSummary -- Needs Review indicator", () => {
  test("Roxana's example (1h30m scheduled, 48h58m tracked) shows the hours total AND a review badge", () => {
    const startedAgo = (48 * 60 + 58) * 60 * 1000;
    const a = appt({
      id: "franklin", scheduled_for: new Date(Date.now() - startedAgo).toISOString(),
      scheduled_end: new Date(Date.now() - startedAgo + 90 * 60 * 1000).toISOString(),
    });
    const asg = assignment({
      appointment_id: "franklin",
      actual_started_at: new Date(Date.now() - startedAgo).toISOString(),
      actual_completed_at: new Date().toISOString(),
    });
    renderSummary({ appointments: [a], assignments: [asg] });
    assert.ok(screen.getByText("Roxana"));
    assert.ok(screen.getByText(/48\.9\d hrs/), "the raw tracked total is shown (48.97h)");
    assert.match(screen.getByText(/review/).textContent ?? "", /1 review/);
  });

  test("no review badge when nothing needs review", () => {
    const a = appt({
      id: "clean", scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    const asg = assignment({
      appointment_id: "clean",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    renderSummary({ appointments: [a], assignments: [asg] });
    assert.ok(screen.getByText("Roxana"));
    assert.equal(screen.queryByText(/review/), null);
  });

  test("an owner correction (employeeHours override) clears the badge and updates the hours total shown", () => {
    const startedAgo = (48 * 60 + 58) * 60 * 1000;
    const a = appt({
      id: "franklin2", scheduled_for: new Date(Date.now() - startedAgo).toISOString(),
      scheduled_end: new Date(Date.now() - startedAgo + 90 * 60 * 1000).toISOString(),
    });
    const asg = assignment({
      appointment_id: "franklin2",
      actual_started_at: new Date(Date.now() - startedAgo).toISOString(),
      actual_completed_at: new Date().toISOString(),
    });
    render(
      React.createElement(PayrollSummary, {
        appointments: [a], employees,
        employeeHours: [{ id: "eh-1", appointment_id: "franklin2", employee_id: "roxana", hours_worked: 86 / 60, note: "Forgot to clock out", created_at: "x", updated_at: "x" }],
        assignments: [asg], ...WIDE_RANGE, onRangeStartChange: () => {}, onRangeEndChange: () => {}, timezone: TZ,
      })
    );
    assert.ok(screen.getByText(/1\.4\d hrs/), "the corrected ~1.43h is totaled, not the raw ~48.97h");
    assert.equal(screen.queryByText(/review/), null, "the alert cleared once the correction is within threshold");
  });

  test("plural wording: '2 reviews' for two flagged appointments, singular '1 review' for one", () => {
    const startedAgo1 = (48 * 60 + 58) * 60 * 1000;
    const a1 = appt({
      id: "f1", scheduled_for: new Date(Date.now() - startedAgo1).toISOString(),
      scheduled_end: new Date(Date.now() - startedAgo1 + 90 * 60 * 1000).toISOString(),
    });
    const asg1 = assignment({
      id: "ae-f1", appointment_id: "f1",
      actual_started_at: new Date(Date.now() - startedAgo1).toISOString(), actual_completed_at: new Date().toISOString(),
    });
    const a2 = appt({
      id: "f2", scheduled_for: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 5 * HOUR_MS + 60 * 60 * 1000).toISOString(),
    });
    const asg2 = assignment({
      id: "ae-f2", appointment_id: "f2",
      actual_started_at: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 5 * HOUR_MS + 5 * 60 * 1000).toISOString(), // 5 min tracked vs 60 min scheduled
    });
    renderSummary({ appointments: [a1, a2], assignments: [asg1, asg2] });
    assert.match(screen.getByText(/reviews/).textContent ?? "", /2 reviews/);
  });
});
