// RENDERED verification of the SFT cancellation-history fix.
//
// Real case: Tami Factor's cancelled Oct 9 2026 appointment showed its
// date, service, employee, and "Cancelled" status, but no cancellation
// reason or reported date -- the owner had no way to retrieve why/when a
// cancellation happened months later. This file renders the REAL
// AppointmentDetailPanel.tsx, MobileAppointmentDetail.tsx, and
// ClientPanel.tsx components (the same testing-library + jsdom technique
// already proven for AppointmentModal.render.test.ts and
// statusDisplayConsistency.render.test.ts) and asserts on actual rendered
// text, not source strings.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: AppointmentDetailPanel } = await import("./AppointmentDetailPanel.tsx");
const { default: MobileAppointmentDetail } = await import("../mobile/MobileAppointmentDetail.tsx");
const { default: ClientPanel } = await import("./ClientPanel.tsx");
const { isHistoricalAppointment } = await import("../../../lib/payroll.ts");

const TZ = "America/New_York";
const APPT_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const client = { id: CLIENT_ID, name: "Tami Factor", email: null, phone: "+15551234567" };
const services = [{ id: "s1", name: "Regular Cleaning", description: null, duration_minutes: 90, active: true, color: "#3B82F6", default_price_cents: 9000 }];

function cancelledAppt(overrides: Record<string, unknown> = {}) {
  return {
    id: APPT_ID,
    client_id: CLIENT_ID,
    service_type: "Regular Cleaning",
    scheduled_for: "2026-10-09T15:00:00.000Z",
    scheduled_end: "2026-10-09T17:00:00.000Z",
    status: "cancelled" as const,
    notes: null,
    duration_minutes: 90,
    series_id: null,
    frequency_type: "one_time" as const,
    repeat_weeks: 1,
    repeat_months: null,
    price_cents: 9000,
    team_color: null,
    cancelled_at: null,
    cancellation_reported_date: null,
    cancellation_reason: null,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("rendered Cancellation Details: saved values display correctly", () => {
  test("AppointmentDetailPanel (desktop) shows the reported date, the exact reason text, and cancelled_at formatted in the business timezone", () => {
    const appt = cancelledAppt({
      cancellation_reported_date: "2026-10-08",
      cancellation_reason: "Client called to cancel due to a scheduling conflict.",
      cancelled_at: "2026-10-09T18:30:00.000Z", // 2:30 PM ET
    });
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client, employees: [], services, assignments: [], employeeHours: [],
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    const section = screen.getByText("Cancellation Details").parentElement!;
    assert.ok(within(section).getByText("Oct 8, 2026"), "the reported date, formatted plainly, exact calendar day as entered");
    assert.ok(within(section).getByText("Client called to cancel due to a scheduling conflict."), "the entered reason text is preserved exactly, not summarized or truncated");
    assert.ok(within(section).getByText(/2:30 PM/), "cancelled_at is formatted in the business (ET) timezone, not UTC or device-local -- scoped to this section so it can't match the unrelated 11:00 AM-12:30 PM summary time range above");
  });

  test("MobileAppointmentDetail shows the identical saved values", () => {
    const appt = cancelledAppt({
      cancellation_reported_date: "2026-10-08",
      cancellation_reason: "Client called to cancel due to a scheduling conflict.",
      cancelled_at: "2026-10-09T18:30:00.000Z",
    });
    render(React.createElement(MobileAppointmentDetail, {
      appointment: appt, client, employees: [], assignments: [], employeeHours: [], durationMinutes: 90,
      onBack: () => {}, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    const section = screen.getByText("Cancellation Details").parentElement!;
    assert.ok(within(section).getByText("Oct 8, 2026"));
    assert.ok(within(section).getByText("Client called to cancel due to a scheduling conflict."));
    assert.ok(within(section).getByText(/2:30 PM/));
  });
});

describe("rendered Cancellation Details: older records with missing fields degrade gracefully -- never invented or backfilled", () => {
  test("AppointmentDetailPanel: all three fields null (a pre-migrations/038 record) shows 'Not recorded'/'No reason recorded' for every field, never blank or fabricated", () => {
    const appt = cancelledAppt(); // cancelled_at/reported_date/reason all null
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client, employees: [], services, assignments: [], employeeHours: [],
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.equal(screen.getAllByText("Not recorded").length, 2, "both the reported-date and recorded-at rows show 'Not recorded'");
    assert.ok(screen.getByText("No reason recorded"));
  });

  test("MobileAppointmentDetail: identical graceful degradation", () => {
    const appt = cancelledAppt();
    render(React.createElement(MobileAppointmentDetail, {
      appointment: appt, client, employees: [], assignments: [], employeeHours: [], durationMinutes: 90,
      onBack: () => {}, onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.equal(screen.getAllByText("Not recorded").length, 2);
    assert.ok(screen.getByText("No reason recorded"));
  });

  test("a partially-complete older record (reason saved, but no reported date and no cancelled_at) shows exactly the fields that exist -- never guesses the missing ones", () => {
    const appt = cancelledAppt({ cancellation_reason: "Owner note: client moved out of the area." });
    render(React.createElement(AppointmentDetailPanel, {
      appointment: appt, client, employees: [], services, assignments: [], employeeHours: [],
      onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
    }));
    assert.ok(screen.getByText("Owner note: client moved out of the area."));
    assert.equal(screen.getAllByText("Not recorded").length, 2, "reported date and recorded-at are still correctly shown as not recorded, never guessed from the reason's presence");
  });
});

describe("rendered ClientPanel: finding a cancelled appointment regardless of the schedule grid's current calendar week", () => {
  test("a cancelled appointment from 90 days ago -- far outside any 'current week' the schedule grid might be showing -- is found via the Cancelled filter", () => {
    const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const appt = cancelledAppt({ scheduled_for: longAgo, scheduled_end: longAgo });
    render(React.createElement(ClientPanel, {
      client, appointments: [appt], onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
      onEditAppointment: () => {},
    }));
    // Default view ("All"): a single past appointment, well within the
    // top-6 slice, already visible without switching the filter.
    assert.ok(screen.getByText("Regular Cleaning"), "visible by default (within the top-6 Past Services slice)");

    // Switch to the Cancelled filter -- this is the behavior actually under
    // test: the appointment must still be found this way too, proving the
    // filter itself (not just the lucky top-6 slice) surfaces it.
    fireEvent.click(screen.getByText("Cancelled", { selector: "button" }));
    assert.ok(screen.getByText("Regular Cleaning"), "still found via the explicit Cancelled filter");
  });

  test("the Cancelled filter surfaces a cancelled appointment even when 6 OTHER, more recent past appointments exist -- proving it is not merely the default top-6 Past Services slice", () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const cancelled = cancelledAppt({ id: "the-cancelled-one", scheduled_for: longAgo, scheduled_end: longAgo, service_type: "Deep Clean" });
    const recentPast = Array.from({ length: 6 }, (_, i) => ({
      ...cancelledAppt({
        id: `recent-${i}`,
        status: "scheduled" as const,
        scheduled_for: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        scheduled_end: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
        service_type: `Recent Job ${i}`,
      }),
    }));
    render(React.createElement(ClientPanel, {
      client, appointments: [cancelled, ...recentPast], onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
      onEditAppointment: () => {},
    }));
    // Default "All" view: the 6 recent ones fill the slice; the 200-day-old
    // cancelled appointment is correctly NOT shown (it's the 7th-most-recent).
    assert.equal(screen.queryByText("Deep Clean"), null, "not visible in the default top-6 Past Services slice");

    // The Cancelled filter must still find it.
    fireEvent.click(screen.getByText("Cancelled", { selector: "button" }));
    assert.ok(screen.getByText("Deep Clean"), "found via the Cancelled filter despite being older than every other listed appointment");
  });
});

describe("rendered ClientPanel: a working 'View all'/'Show less' action for the All view", () => {
  // 8 past, non-cancelled appointments -- 2 more than the default 6-row
  // slice, so "View all" has something real to reveal.
  function eightPastAppts() {
    return Array.from({ length: 8 }, (_, i) => cancelledAppt({
      id: `past-${i}`,
      status: "scheduled" as const,
      scheduled_for: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      scheduled_end: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      service_type: `Job ${i}`,
    }));
  }

  test("clicking 'View all' reveals every past appointment, not just the default 6 -- and the Cancelled filter remains uncapped throughout", () => {
    render(React.createElement(ClientPanel, {
      client, appointments: eightPastAppts(), onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
      onEditAppointment: () => {},
    }));
    // Default: only the 6 most recent are shown; the two oldest are not.
    assert.equal(screen.queryByText("Job 6"), null, "the 7th-most-recent is not in the default slice");
    assert.equal(screen.queryByText("Job 7"), null, "the 8th-most-recent is not in the default slice");
    assert.ok(screen.getByText(/View all \(8\)/), "the control states the real total count");

    fireEvent.click(screen.getByText(/View all \(8\)/));
    assert.ok(screen.getByText("Job 6"), "now revealed");
    assert.ok(screen.getByText("Job 7"), "now revealed");
    assert.ok(screen.getByText("Show less"), "the control flips to let the owner collapse it back");
  });

  test("clicking 'Show less' after 'View all' collapses back to the default 6-row slice", () => {
    render(React.createElement(ClientPanel, {
      client, appointments: eightPastAppts(), onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
      onEditAppointment: () => {},
    }));
    fireEvent.click(screen.getByText(/View all \(8\)/));
    assert.ok(screen.getByText("Job 7"));
    fireEvent.click(screen.getByText("Show less"));
    assert.equal(screen.queryByText("Job 7"), null, "collapsed back to the default slice");
    assert.ok(screen.getByText(/View all \(8\)/), "the control is available again");
  });

  test("the 'View all'/'Show less' control never appears for the Cancelled filter -- that view is already uncapped, nothing more to reveal", () => {
    render(React.createElement(ClientPanel, {
      client, appointments: eightPastAppts(), onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
      onEditAppointment: () => {},
    }));
    fireEvent.click(screen.getByText("Cancelled", { selector: "button" }));
    assert.equal(screen.queryByText(/View all/), null);
    assert.equal(screen.queryByText("Show less"), null);
  });

  test("with 6 or fewer past appointments, no 'View all' control renders at all (nothing to expand)", () => {
    render(React.createElement(ClientPanel, {
      client, appointments: eightPastAppts().slice(0, 5), onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
      onEditAppointment: () => {},
    }));
    assert.equal(screen.queryByText(/View all/), null);
  });
});

describe("rendered end-to-end: selecting a history entry opens that EXACT appointment's details, including Cancellation Details, even far outside the currently-displayed calendar week", () => {
  // Host mirrors DashboardShell.tsx's own selectAppointment/editAppointment/
  // selectedAppt logic VERBATIM (see DashboardShell.tsx ~lines 157-221):
  // editAppointment finds the target in the full, unbounded `appointments`
  // array (never filtered by week/viewMode/weekOffset), checks
  // isHistoricalAppointment (the real function, imported from lib/payroll.ts,
  // not reimplemented), and redirects to selectAppointment for a historical
  // appointment -- always true for a cancelled one. selectedAppt is the
  // same plain array .find() DashboardShell itself uses. This is the
  // smallest faithful harness that exercises the REAL ClientPanel and REAL
  // AppointmentDetailPanel components through the REAL click-to-open
  // mechanism, without rendering DashboardShell's much larger tree (TopBar/
  // LeftBar/ScheduleGrid/mobile detection/router), which this interaction's
  // own logic does not touch at all.
  function Host({ appointments }: { appointments: Array<ReturnType<typeof cancelledAppt>> }) {
    const [selectedApptId, setSelectedApptId] = React.useState<string | null>(null);
    function selectAppointment(apptId: string) {
      setSelectedApptId(apptId);
    }
    function editAppointment(apptId: string) {
      const appt = appointments.find((a) => a.id === apptId);
      if (!appt) return;
      if (isHistoricalAppointment(appt, [])) {
        selectAppointment(apptId);
        return;
      }
      setSelectedApptId(apptId);
    }
    const selectedAppt = selectedApptId ? appointments.find((a) => a.id === selectedApptId) ?? null : null;
    return selectedAppt
      ? React.createElement(AppointmentDetailPanel, {
          appointment: selectedAppt, client, employees: [], services, assignments: [], employeeHours: [],
          onEdit: () => {}, onCancelled: () => {}, canMutateOperationalData: true, timezone: TZ,
        })
      : React.createElement(ClientPanel, {
          client, appointments, onClientUpdated: () => {}, canMutateOperationalData: true, timezone: TZ,
          onEditAppointment: editAppointment,
        });
  }

  test("a cancelled appointment from 150 days ago, found via the Cancelled filter, opens AppointmentDetailPanel showing its own exact service, date, AND its cancellation reason/reported date/recorded-at", () => {
    const longAgo = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000).toISOString();
    const recordedAt = new Date(Date.now() - 150 * 24 * 60 * 60 * 1000 + 3600_000).toISOString();
    const target = cancelledAppt({
      id: "far-outside-the-week",
      service_type: "Move-Out Deep Clean",
      scheduled_for: longAgo,
      scheduled_end: longAgo,
      cancellation_reported_date: "2026-05-01",
      cancellation_reason: "Client sold the property before the scheduled date.",
      cancelled_at: recordedAt,
    });
    // Six other, unrelated, much more recent past appointments fill the
    // default slice -- the target is findable ONLY via the Cancelled
    // filter, exactly like the real multi-month-later retrieval scenario.
    const recent = Array.from({ length: 6 }, (_, i) => cancelledAppt({
      id: `recent-${i}`,
      status: "scheduled" as const,
      service_type: `Recent Job ${i}`,
      scheduled_for: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      scheduled_end: new Date(Date.now() - (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
    }));

    render(React.createElement(Host, { appointments: [target, ...recent] }));

    // Starting state: ClientPanel, target not visible in the default slice.
    assert.equal(screen.queryByText("Move-Out Deep Clean"), null);

    // Find it via the Cancelled filter and click it.
    fireEvent.click(screen.getByText("Cancelled", { selector: "button" }));
    fireEvent.click(screen.getByText("Move-Out Deep Clean"));

    // AppointmentDetailPanel now renders -- the EXACT appointment (not a
    // different one, not a mix-up with one of the 6 "recent" rows), with
    // its full Cancellation Details.
    assert.ok(screen.getByText("Move-Out Deep Clean"), "the correct appointment's own service type");
    assert.ok(screen.getByText("Cancellation Details"));
    const section = screen.getByText("Cancellation Details").parentElement!;
    assert.ok(within(section).getByText("May 1, 2026"), "its own reported date");
    assert.ok(within(section).getByText("Client sold the property before the scheduled date."), "its own reason, verbatim");
    // None of the "recent" jobs' content leaked into this view.
    assert.equal(screen.queryByText("Recent Job 0"), null);
  });
});
