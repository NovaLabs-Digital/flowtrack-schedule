// Real rendered-component behavior tests for AdjustWorkedTimeControl.ts,
// using the jsdom + @testing-library/react + @testing-library/user-event
// foundation (see CapabilityGatedButton.test.ts for the established
// pattern). Only the network is faked: a scripted `fetch` stands in for
// /api/appointments/employee-hours, so nothing is written anywhere.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EmployeeHours } from "@/app/components/dashboard/types";

const { default: AdjustWorkedTimeControl } = await import("./AdjustWorkedTimeControl.ts");

const APPT_ID = "11111111-1111-4111-8111-111111111111";
const EMP_ID = "22222222-2222-4222-8222-222222222222";

type Call = { url: string; body: { appointment_id: string; employee_id: string; hours_worked: number; note: string } };
let calls: Call[] = [];
let responses: Array<() => Promise<Response> | Response> = [];
const originalFetch = globalThis.fetch;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted fetch to ${String(input)}`);
    return next();
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const ENTRY: EmployeeHours = {
  id: "eh-1", appointment_id: APPT_ID, employee_id: EMP_ID, hours_worked: 1.4333,
  note: "Forgot to clock out", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};

function renderControl(props: { canCorrect?: boolean; onSaved?: (e: EmployeeHours) => void } = {}) {
  const saved: EmployeeHours[] = [];
  render(
    React.createElement(AdjustWorkedTimeControl, {
      appointmentId: APPT_ID,
      employeeId: EMP_ID,
      canCorrect: props.canCorrect ?? true,
      onSaved: props.onSaved ?? ((e: EmployeeHours) => saved.push(e)),
    })
  );
  return { saved };
}

const user = () => userEvent.setup();

describe("collapsed state", () => {
  test("shows the 'Adjust Worked Time' button and no form", () => {
    renderControl();
    assert.ok(screen.getByText("Adjust Worked Time"));
    assert.equal(screen.queryByLabelText("Corrected hours"), null);
  });

  test("when restricted (canCorrect=false), the button is disabled and a neutral notice is shown", async () => {
    renderControl({ canCorrect: false });
    const btn = screen.getByText("Adjust Worked Time") as HTMLButtonElement;
    assert.equal(btn.getAttribute("aria-disabled"), "true");
    assert.match(screen.getByText(/temporarily unavailable/i).textContent ?? "", /account notice/i);
    // clicking a restricted button does nothing -- CapabilityGatedButton's own guard
    await user().click(btn);
    assert.equal(screen.queryByLabelText("Corrected hours"), null, "form never opens while restricted");
  });
});

describe("opening the form", () => {
  test("clicking 'Adjust Worked Time' reveals Hours, Minutes, Reason inputs and Save/Cancel", async () => {
    renderControl();
    await user().click(screen.getByText("Adjust Worked Time"));
    assert.ok(screen.getByLabelText("Corrected hours"));
    assert.ok(screen.getByLabelText("Corrected minutes"));
    assert.ok(screen.getByLabelText("Correction reason"));
    assert.ok(screen.getByText("Save Correction"));
    assert.ok(screen.getByText("Cancel"));
  });
});

describe("validation", () => {
  test("both hours and minutes left at 0 is rejected with no request sent", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Correction reason"), "Forgot to clock out");
    await u.click(screen.getByText("Save Correction"));
    assert.match(screen.getByText(/greater than 0/i).textContent ?? "", /hours and\/or minutes/i);
    assert.equal(calls.length, 0);
  });

  test("a missing reason is rejected with no request sent", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected hours"), "1");
    await u.click(screen.getByText("Save Correction"));
    assert.match(screen.getByText(/reason is required/i).textContent ?? "", /forgot to clock out/i);
    assert.equal(calls.length, 0);
  });

  test("minutes out of range (60+) is rejected client-side", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected minutes"), "90");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    await u.click(screen.getByText("Save Correction"));
    assert.equal(calls.length, 0);
  });
});

describe("saving a correction", () => {
  test("Hours + Minutes are combined into a single decimal-hours POST body, with the reason as note", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected hours"), "1");
    await u.type(screen.getByLabelText("Corrected minutes"), "26");
    await u.type(screen.getByLabelText("Correction reason"), "Forgot to clock out");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Save Correction"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/appointments/employee-hours");
    assert.equal(calls[0].body.appointment_id, APPT_ID);
    assert.equal(calls[0].body.employee_id, EMP_ID);
    assert.ok(Math.abs(calls[0].body.hours_worked - (1 + 26 / 60)) < 1e-9, calls[0].body.hours_worked.toString());
    assert.equal(calls[0].body.note, "Forgot to clock out");
  });

  test("minutes-only (0 hours) is a valid correction", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected minutes"), "45");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Save Correction"));
    assert.equal(calls.length, 1);
    assert.ok(Math.abs(calls[0].body.hours_worked - 45 / 60) < 1e-9);
  });

  test("on success, onSaved receives the saved entry and the form collapses back to the button", async () => {
    const { saved } = renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected hours"), "1");
    await u.type(screen.getByLabelText("Correction reason"), "Forgot to clock out");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Save Correction"));

    assert.deepEqual(saved, [ENTRY]);
    assert.ok(screen.getByText("Adjust Worked Time"), "collapsed back to the button");
    assert.equal(screen.queryByLabelText("Corrected hours"), null);
  });

  test("a server rejection keeps the form open, shows the server's message, and never calls onSaved", async () => {
    const { saved } = renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected hours"), "1");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    responses.push(json(404, { error: "Employee is not assigned to this appointment." }));
    await u.click(screen.getByText("Save Correction"));

    assert.deepEqual(saved, []);
    assert.equal(screen.getByText("Employee is not assigned to this appointment.").tagName, "DIV");
    assert.ok(screen.getByLabelText("Corrected hours"), "form stays open");
  });

  test("a network error is reported and never calls onSaved", async () => {
    const { saved } = renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected hours"), "1");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    responses.push(() => { throw new TypeError("Failed to fetch"); });
    await u.click(screen.getByText("Save Correction"));

    assert.deepEqual(saved, []);
    assert.ok(screen.getByText("Network error."));
  });

  test("restricted (canCorrect=false): Save Correction is disabled and issues no request", async () => {
    renderControl({ canCorrect: false });
    const u = user();
    // the button itself is disabled, so open it programmatically isn't possible via the UI --
    // confirms the collapsed control alone is enough to block the whole flow.
    await u.click(screen.getByText("Adjust Worked Time"));
    assert.equal(screen.queryByLabelText("Corrected hours"), null);
    assert.equal(calls.length, 0);
  });
});

describe("cancel", () => {
  test("Cancel closes the form, discards input, and reopening shows a blank form again", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await u.type(screen.getByLabelText("Corrected hours"), "3");
    await u.type(screen.getByLabelText("Correction reason"), "scratch input");
    await u.click(screen.getByText("Cancel"));

    assert.ok(screen.getByText("Adjust Worked Time"), "collapsed");
    assert.equal(calls.length, 0, "nothing was saved");

    await u.click(screen.getByText("Adjust Worked Time"));
    assert.equal((screen.getByLabelText("Corrected hours") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Correction reason") as HTMLInputElement).value, "");
  });
});
