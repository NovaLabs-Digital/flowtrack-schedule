// SFT status-display-consistency fix.
//
// Investigation found that four dashboard surfaces each computed their own
// appointment status label via a DIFFERENT rule:
//   - ScheduleGrid.tsx (the calendar)        -- raw appointment.status only
//   - DispatchPanel.tsx (the dispatch panel) -- status === "cancelled",
//     else deriveAppointmentTrackingStatus(assignments) (Job Tracking only,
//     never elapsed time)
//   - AppointmentDetailPanel.tsx / MobileAppointmentDetail.tsx -- status ===
//     "cancelled", else isHistoricalAppointment (Job Tracking OR elapsed
//     time -- so "scheduled_end merely elapsed" produced "Completed")
// This let the SAME appointment show "Scheduled" on the calendar/dispatch
// panel while showing "Completed" on the detail panel/mobile screen -- the
// real case this was first noticed from: a past, never-worked appointment
// stuck in that limbo for days.
//
// The fix: ONE shared rule, displayAppointmentStatus (lib/payroll.ts), now
// used by all four surfaces. It never considers elapsed time -- only the
// stored status and actual Job Tracking completion. A separate, optional
// isAppointmentPastDue signal carries the "scheduled_end has elapsed"
// information without conflating it into the status label. This file
// proves (by source inspection, since three of the four are .tsx files
// this test runner cannot load) that every surface now calls the shared
// function rather than a locally re-derived rule.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(relativePath: string): string {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
}

const scheduleGridSource = readSource("../app/components/dashboard/ScheduleGrid.tsx");
const dispatchPanelSource = readSource("../app/components/dashboard/DispatchPanel.tsx");
const appointmentDetailPanelSource = readSource("../app/components/dashboard/AppointmentDetailPanel.tsx");
const mobileAppointmentDetailSource = readSource("../app/components/mobile/MobileAppointmentDetail.tsx");
const clientPanelSource = readSource("../app/components/dashboard/ClientPanel.tsx");
const payrollSource = readSource("./payroll.ts");

describe("status display consistency -- all four surfaces now call the ONE shared displayAppointmentStatus rule (lib/payroll.ts), never a locally re-derived one", () => {
  test("ScheduleGrid's calendar card label is displayAppointmentStatus(a, assignmentsFor(a.id)) -- the old locally re-derived statusLabel switch is gone entirely", () => {
    assert.ok(scheduleGridSource.includes("{displayAppointmentStatus(a, assignmentsFor(a.id))}"));
    assert.ok(!scheduleGridSource.includes("function statusLabel("));
    assert.ok(scheduleGridSource.includes('import { needsWorkedHoursAttention, appointmentNeedsWorkedTimeReview, isHistoricalAppointment, displayAppointmentStatus } from "@/lib/payroll";'));
  });

  test("DispatchPanel's Status row is displayAppointmentStatus(selectedAppt, selectedApptAssignments) -- the old local ternary (status==='cancelled' ? ... : selectedApptStatus===...) is gone", () => {
    assert.ok(dispatchPanelSource.includes("const selectedApptDisplayStatus = selectedAppt ? displayAppointmentStatus(selectedAppt, selectedApptAssignments) : \"Scheduled\";"));
    assert.ok(dispatchPanelSource.includes('<InfoRow label="Status" value={selectedApptDisplayStatus} />'));
    assert.ok(!dispatchPanelSource.includes('selectedAppt.status === "cancelled" ? "Cancelled"\n                : selectedApptStatus'));
  });

  test("AppointmentDetailPanel's statusLabel is displayAppointmentStatus(appointment, assignments) -- the old ternary that treated elapsed time (isHistorical) as 'Completed' is gone", () => {
    assert.ok(appointmentDetailPanelSource.includes("const statusLabel = displayAppointmentStatus(appointment, assignments);"));
    assert.ok(!appointmentDetailPanelSource.includes('const statusLabel = appointment.status === "cancelled" ? "Cancelled" : isHistorical ? "Completed" : "Scheduled";'));
  });

  test("MobileAppointmentDetail's statusLabel is displayAppointmentStatus(appointment, assignments) -- identical to desktop, same old elapsed-time conflation removed", () => {
    assert.ok(mobileAppointmentDetailSource.includes("const statusLabel = displayAppointmentStatus(appointment, assignments);"));
    assert.ok(!mobileAppointmentDetailSource.includes('const statusLabel = appointment.status === "cancelled" ? "Cancelled" : isHistorical ? "Completed" : "Scheduled";'));
  });

  test("ClientPanel's appointment history row still treats status === 'cancelled' as its own case -- untouched by this fix (it never had the elapsed-time conflation), just re-confirmed", () => {
    assert.ok(clientPanelSource.includes('status={a.status === "cancelled" ? "Cancelled" : "Completed"}'));
  });

  test("displayAppointmentStatus itself never reads scheduled_end/scheduled_for -- its only inputs are appt.status and assignments, so passing scheduled_end alone can never produce 'Completed'", () => {
    const fnStart = payrollSource.indexOf("export function displayAppointmentStatus(");
    const fnEnd = payrollSource.indexOf("\n}", fnStart);
    const body = payrollSource.slice(fnStart, fnEnd);
    assert.ok(!body.includes("scheduled_end"));
    assert.ok(!body.includes("scheduled_for"));
    assert.ok(body.includes('if (appt.status === "cancelled") return "Cancelled";'));
    assert.ok(body.includes("deriveAppointmentTrackingStatus(assignments)"));
  });

  test("isAppointmentPastDue is a SEPARATE export from displayAppointmentStatus -- the 'optional Past due indicator' is never folded into the main status label", () => {
    assert.ok(payrollSource.includes("export function isAppointmentPastDue("));
    const fnStart = payrollSource.indexOf("export function isAppointmentPastDue(");
    const fnEnd = payrollSource.indexOf("\n}", fnStart);
    const body = payrollSource.slice(fnStart, fnEnd);
    assert.ok(body.includes("isPastAppointment(appt, now)"), "past-due is time-aware, unlike displayAppointmentStatus");
  });

  test("both AppointmentDetailPanel and MobileAppointmentDetail render the separate (Past due) indicator alongside, never inside, statusLabel", () => {
    for (const source of [appointmentDetailPanelSource, mobileAppointmentDetailSource]) {
      assert.ok(source.includes("const pastDue = isAppointmentPastDue(appointment, assignments);"));
      assert.ok(source.includes("{pastDue && <span"));
    }
  });
});
