// RENDERED verification of ScheduleGrid's Calendar Paid Indicator (the small
// green "$" meaning PAYMENT COMPLETED). ScheduleGrid.tsx takes only plain
// props and plain lib functions as real dependencies -- same reasoning
// PayrollSummary.test.ts gives for using the real-render path rather than
// source inspection, so this renders the REAL component with REAL data,
// not a mock. ScheduleGrid.test.ts (static source-level) continues to own
// the non-visual structural proofs (prop wiring, timezone/business-hours
// plumbing); this file owns the actual rendered-DOM behavior of the paid
// indicator specifically.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { nowInBusinessTz, zonedDateTimeToUTC } from "@/lib/timezone";
import { effectiveBusinessHours } from "@/lib/businessHours";
import type { Appointment, Client } from "@/app/components/dashboard/types";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: ScheduleGrid } = await import("./ScheduleGrid.tsx");

afterEach(() => cleanup());

const TZ = "America/New_York";
const businessHours = effectiveBusinessHours(null);

// "Today, 10:00 business-local" -- inside every default business-hours
// window, and inside Day view's single visible date, regardless of what
// real-world weekday the test happens to run on (computeGridHourBounds
// widens to cover any visible appointment even on an otherwise-closed day
// -- see lib/businessHours.ts's own doc comment on that).
function todayAt(hhmm: string): string {
  const now = nowInBusinessTz(TZ);
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const r = zonedDateTimeToUTC(dateStr, hhmm, TZ);
  if (!r.ok) throw new Error("test setup: " + r.error);
  return r.iso;
}

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Regular Cleaning",
    scheduled_for: todayAt("10:00"),
    scheduled_end: todayAt("11:30"),
    duration_minutes: 90,
    status: "scheduled",
    notes: "Gate code 4421",
    frequency_type: "weekly",
    repeat_weeks: 1,
    ...overrides,
  };
}

const clients: Client[] = [{ id: "client-1", name: "Priya Chandrasekaran", email: null, phone: null }];

function renderGrid(props: { appointments: Appointment[]; paidAppointmentIds: string[] }) {
  return render(
    React.createElement(ScheduleGrid, {
      viewMode: "day",
      clients,
      appointments: props.appointments,
      services: [],
      employees: [],
      employeeHours: [],
      assignments: [],
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
      paidAppointmentIds: props.paidAppointmentIds,
    })
  );
}

describe("ScheduleGrid -- Calendar Paid Indicator", () => {
  test("1. paid = true renders the green \"$\"", () => {
    renderGrid({ appointments: [appt()], paidAppointmentIds: ["appt-1"] });
    const dollar = screen.getByTitle("Paid");
    assert.equal(dollar.textContent, "$");
    assert.ok(dollar.className.includes("text-emerald-600"), "must be rendered in the approved green/emerald color");
  });

  test("2. paid = false (no matching id in the list) does not render it", () => {
    renderGrid({ appointments: [appt()], paidAppointmentIds: [] });
    assert.equal(screen.queryByTitle("Paid"), null);
    assert.equal(screen.queryByText("$"), null);
  });

  test("3. no billing row at all (same as an empty paidAppointmentIds list) does not render it", () => {
    // There is no separate "has a billing row but unpaid" vs "no billing
    // row" distinction on the wire -- app/dashboard/page.tsx's query already
    // selects ONLY paid = true rows, so "no row" and "a row that isn't
    // paid" both simply mean this appointment's id is absent from the list.
    // This test exists to document that equivalence explicitly, not to
    // re-prove case 2 under a different name.
    renderGrid({ appointments: [appt({ id: "appt-no-billing-row" })], paidAppointmentIds: [] });
    assert.equal(screen.queryByTitle("Paid"), null);
  });

  test("4. an appointment that merely LOOKS invoiced (price set) but is not in the paid list does not render it -- the indicator is driven only by paidAppointmentIds, never by price_cents/invoice presence", () => {
    renderGrid({
      appointments: [appt({ price_cents: 12000 })],
      paidAppointmentIds: [], // this appointment's billing row, if any, is invoiced but unpaid -- id correctly absent
    });
    assert.equal(screen.queryByTitle("Paid"), null);
  });

  test("7. existing card content and indicators (service name, client, time, recurring icon, notes) still render correctly alongside the paid indicator", () => {
    renderGrid({ appointments: [appt()], paidAppointmentIds: ["appt-1"] });
    assert.ok(screen.getByText("Regular Cleaning"));
    assert.ok(screen.getByText("Priya Chandrasekaran"));
    assert.ok(screen.getByText("Gate code 4421"));
    assert.ok(screen.getByTitle("Weekly")); // the recurring (&#8635;) icon's title
    assert.ok(screen.getByTitle("Paid"));
  });

  test("the paid indicator does not replace or truncate the service name/client/time -- it is an additional sibling element, not a swapped-in label", () => {
    renderGrid({ appointments: [appt()], paidAppointmentIds: ["appt-1"] });
    const card = screen.getByTitle("Paid").closest("button")!;
    assert.ok(card.textContent?.includes("Regular Cleaning"));
    assert.ok(card.textContent?.includes("Priya Chandrasekaran"));
  });

  // Real production rule (Holly Williams, paid Cash, no QuickBooks
  // invoice): ScheduleGrid never receives invoice_number/payment_method at
  // all -- only the bare paidAppointmentIds id list (app/dashboard/
  // page.tsx's own query is `.eq("paid", true)` with no invoice_number
  // filter). The indicator is therefore structurally incapable of caring
  // whether an invoice exists; this test just reaffirms that a paid-but-
  // never-invoiced appointment still shows the "$" exactly like any other
  // paid one.
  test("a paid job that was never invoiced (e.g. paid Cash, no QuickBooks invoice) still shows the green \"$\" -- the indicator has no notion of invoice_number at all", () => {
    renderGrid({ appointments: [appt({ price_cents: 12000 })], paidAppointmentIds: ["appt-1"] });
    assert.ok(screen.getByTitle("Paid"));
  });

  test("two appointments: only the one actually marked paid shows the indicator -- never both, never neither, by accident", () => {
    renderGrid({
      appointments: [
        appt({ id: "appt-paid", client_id: "client-1" }),
        appt({ id: "appt-unpaid", scheduled_for: todayAt("13:00"), scheduled_end: todayAt("14:00") }),
      ],
      paidAppointmentIds: ["appt-paid"],
    });
    assert.equal(screen.getAllByTitle("Paid").length, 1);
  });
});
