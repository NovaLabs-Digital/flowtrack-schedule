// RENDERED verification of ScheduleGrid's appointment-card warning
// triangle for an unresolved Needs Review condition (lib/payroll.ts's
// appointmentNeedsWorkedTimeReview, which reuses needsWorkedTimeReview --
// the exact same authoritative per-employee logic Weekly Worked Hours /
// Employee Worked Hours already use, never a second calculation). Same
// real-render approach as ScheduleGrid.paidIndicator.test.ts.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { nowInBusinessTz, zonedDateTimeToUTC } from "@/lib/timezone";
import { effectiveBusinessHours } from "@/lib/businessHours";
import type { Appointment, AppointmentEmployeeAssignment, Client, EmployeeHours } from "@/app/components/dashboard/types";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: ScheduleGrid } = await import("./ScheduleGrid.tsx");

afterEach(() => cleanup());

const TZ = "America/New_York";
const businessHours = effectiveBusinessHours(null);

function todayAt(hhmm: string): string {
  const now = nowInBusinessTz(TZ);
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const r = zonedDateTimeToUTC(dateStr, hhmm, TZ);
  if (!r.ok) throw new Error("test setup: " + r.error);
  return r.iso;
}

// Dave Cloutier's own real numbers: 90 minutes scheduled, 10:00-11:30.
function dave(): Appointment {
  return {
    id: "dave-appt", client_id: "client-1", service_type: "Regular Cleaning",
    scheduled_for: todayAt("10:00"), scheduled_end: todayAt("11:30"), duration_minutes: 90,
    status: "scheduled", notes: null,
  };
}

function trackedAssignment(overrides: Partial<AppointmentEmployeeAssignment>): AppointmentEmployeeAssignment {
  return {
    id: "ae-1", appointment_id: "dave-appt", employee_id: "emp-1",
    actual_started_at: todayAt("10:00"), actual_completed_at: null,
    job_notes: null, created_at: "x", updated_at: "x",
    ...overrides,
  };
}

const clients: Client[] = [{ id: "client-1", name: "Priya Chandrasekaran", email: null, phone: null }];

function renderGrid(props: {
  appointments: Appointment[];
  assignments: AppointmentEmployeeAssignment[];
  employeeHours?: EmployeeHours[];
  paidAppointmentIds?: string[];
}) {
  return render(
    React.createElement(ScheduleGrid, {
      viewMode: "day",
      clients,
      appointments: props.appointments,
      services: [],
      employees: [],
      employeeHours: props.employeeHours ?? [],
      assignments: props.assignments,
      selectedClientId: null,
      selectedAppointmentId: null,
      onSelectAppointment: () => {},
      onEditAppointment: () => {},
      onCellClick: () => {},
      onDropAppointment: () => {},
      weekOffset: 0,
      canMutateOperationalData: true,
      timezone: TZ,
      businessHours,
      paidAppointmentIds: props.paidAppointmentIds ?? [],
    })
  );
}

const REVIEW_TITLE = "Worked time for this job needs owner review.";

describe("ScheduleGrid -- appointment-card Needs Review warning triangle", () => {
  test("7. one unresolved employee among multiple -> the triangle is shown", () => {
    // Teresa 96min (6min over the 90min schedule -- resolved), Roxana 6min
    // (84min off -- unresolved). The real Dave Cloutier regression.
    const teresa = trackedAssignment({
      id: "ae-teresa", employee_id: "teresa",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("11:36"),
    });
    const roxana = trackedAssignment({
      id: "ae-roxana", employee_id: "roxana",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("10:06"),
    });
    renderGrid({ appointments: [dave()], assignments: [teresa, roxana] });
    assert.ok(screen.getByTitle(REVIEW_TITLE));
  });

  test("8. all employees resolved (both close to the 90min schedule) -> the triangle is hidden", () => {
    const teresa = trackedAssignment({
      id: "ae-teresa", employee_id: "teresa",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("11:36"), // 96min, 6min over -- fine
    });
    const roxana = trackedAssignment({
      id: "ae-roxana", employee_id: "roxana",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("11:28"), // 88min, 2min under -- fine
    });
    renderGrid({ appointments: [dave()], assignments: [teresa, roxana] });
    assert.equal(screen.queryByTitle(REVIEW_TITLE), null);
  });

  test("resolving the unresolved employee via an owner-approved worked-time override makes the triangle disappear", () => {
    const teresa = trackedAssignment({
      id: "ae-teresa", employee_id: "teresa",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("11:36"),
    });
    const roxana = trackedAssignment({
      id: "ae-roxana", employee_id: "roxana",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("10:06"),
    });
    const override: EmployeeHours = {
      id: "hrs-1", appointment_id: "dave-appt", employee_id: "roxana",
      hours_worked: 1.5, note: "Keep Time As Is", created_at: "x", updated_at: "x",
    };
    renderGrid({ appointments: [dave()], assignments: [teresa, roxana], employeeHours: [override] });
    assert.equal(screen.queryByTitle(REVIEW_TITLE), null);
  });

  test("9. the review triangle and the green $ paid indicator can coexist on the same card without conflict", () => {
    const teresa = trackedAssignment({
      id: "ae-teresa", employee_id: "teresa",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("11:36"),
    });
    const roxana = trackedAssignment({
      id: "ae-roxana", employee_id: "roxana",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("10:06"),
    });
    renderGrid({ appointments: [dave()], assignments: [teresa, roxana], paidAppointmentIds: ["dave-appt"] });
    assert.ok(screen.getByTitle(REVIEW_TITLE));
    assert.ok(screen.getByTitle("Paid"));
    // Both render as distinct elements -- neither replaced the other.
    assert.notEqual(screen.getByTitle(REVIEW_TITLE), screen.getByTitle("Paid"));
  });

  test("10. single-employee behavior is unchanged -- a lone employee far from the scheduled duration still shows the triangle", () => {
    const soloFar = trackedAssignment({
      id: "ae-solo", employee_id: "solo",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("20:00"), // ~10h vs 90min scheduled
    });
    renderGrid({ appointments: [dave()], assignments: [soloFar] });
    assert.ok(screen.getByTitle(REVIEW_TITLE));
  });

  test("10b. single-employee behavior is unchanged -- a lone employee close to the scheduled duration shows no triangle", () => {
    const soloClose = trackedAssignment({
      id: "ae-solo", employee_id: "solo",
      actual_started_at: todayAt("10:00"), actual_completed_at: todayAt("11:35"), // 95min vs 90min scheduled
    });
    renderGrid({ appointments: [dave()], assignments: [soloClose] });
    assert.equal(screen.queryByTitle(REVIEW_TITLE), null);
  });

  test("the missing-hours warning (a different, pre-existing condition) still shares the same single triangle slot and is unaffected by this change", () => {
    const untouched = trackedAssignment({
      id: "ae-missing", employee_id: "missing-employee",
      actual_started_at: null, actual_completed_at: null,
    });
    // Reliably in the past regardless of what time this test happens to
    // run (unlike the fixed "10:00 today" appointments above, this one
    // specifically needs isEligibleForWorkedHoursWarning -- scheduled_end
    // already elapsed -- to be true, which needsWorkedTimeReview itself
    // never requires).
    const HOUR_MS = 60 * 60 * 1000;
    const pastDave: Appointment = {
      ...dave(),
      scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - HOUR_MS).toISOString(),
    };
    renderGrid({ appointments: [pastDave], assignments: [untouched] });
    assert.ok(screen.getByTitle("Employee work hours require attention because Job Tracking was not completed."));
    assert.equal(screen.queryByTitle(REVIEW_TITLE), null, "missing-hours and needs-review are different conditions -- only one applies here");
  });
});
