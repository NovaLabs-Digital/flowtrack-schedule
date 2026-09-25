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

const { default: AdjustWorkedTimeControl, computeCorrectedHours, computeKeepAsIsHours } = await import("./AdjustWorkedTimeControl.ts");

const APPT_ID = "11111111-1111-4111-8111-111111111111";
const EMP_ID = "22222222-2222-4222-8222-222222222222";
const TZ = "America/New_York";
const ANCHOR_DATE = "2026-09-22"; // outside any DST transition, well after 2026-03-08 / before 2026-11-01

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
  id: "eh-1", appointment_id: APPT_ID, employee_id: EMP_ID, hours_worked: 1.5,
  note: "Forgot to clock out", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};

function renderControl(props: {
  canCorrect?: boolean;
  onSaved?: (e: EmployeeHours) => void;
  initialStartedAt?: string | null;
  initialCompletedAt?: string | null;
  needsReview?: boolean;
} = {}) {
  const saved: EmployeeHours[] = [];
  render(
    React.createElement(AdjustWorkedTimeControl, {
      appointmentId: APPT_ID,
      employeeId: EMP_ID,
      canCorrect: props.canCorrect ?? true,
      onSaved: props.onSaved ?? ((e: EmployeeHours) => saved.push(e)),
      timezone: TZ,
      anchorDate: ANCHOR_DATE,
      initialStartedAt: props.initialStartedAt,
      initialCompletedAt: props.initialCompletedAt,
      needsReview: props.needsReview,
    })
  );
  return { saved };
}

// Tracked interval shared by the "flagged" (needsReview) tests below -- same
// 8:55 AM - 10:25 AM / 1.5h pair the unflagged tests above use, so
// "Keep Time As Is" is expected to post exactly 1.5 hours.
const TRACKED_STARTED_AT = "2026-09-22T12:55:00.000Z"; // 8:55 AM America/New_York
const TRACKED_COMPLETED_AT = "2026-09-22T14:25:00.000Z"; // 10:25 AM America/New_York
const TRACKED_HOURS = 1.5;

const user = () => userEvent.setup();
const setTime = async (u: ReturnType<typeof user>, input: HTMLElement, hhmm: string) => {
  // jsdom's <input type="time"> accepts a plain "HH:mm" fireEvent-style
  // value via userEvent.type once cleared -- typing the digits (no colon)
  // is what a real browser's time-input widget effectively receives.
  await u.clear(input);
  await u.type(input, hhmm.replace(":", ""));
};

describe("computeCorrectedHours -- pure duration calculation", () => {
  test("Clock-in 8:55 AM, Clock-out 10:25 AM -> exactly 1.5 hours", () => {
    const r = computeCorrectedHours("08:55", "10:25", ANCHOR_DATE, TZ);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.hours - 1.5) < 1e-9, r.hours.toString());
  });

  test("a sub-minute-precision interval still computes correctly (e.g. 08:55 -> 09:00 = 5 minutes)", () => {
    const r = computeCorrectedHours("08:55", "09:00", ANCHOR_DATE, TZ);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.hours - 5 / 60) < 1e-9);
  });

  test("clock-out at or before clock-in is rejected", () => {
    const same = computeCorrectedHours("09:00", "09:00", ANCHOR_DATE, TZ);
    assert.equal(same.ok, false);
    assert.match((same as { error: string }).error, /after clock-in/);
    const before = computeCorrectedHours("10:00", "09:00", ANCHOR_DATE, TZ);
    assert.equal(before.ok, false);
  });

  test("an empty clock-in or clock-out is rejected", () => {
    assert.equal(computeCorrectedHours("", "10:00", ANCHOR_DATE, TZ).ok, false);
    assert.equal(computeCorrectedHours("09:00", "", ANCHOR_DATE, TZ).ok, false);
  });
});

describe("collapsed state", () => {
  test("shows the 'Adjust Worked Time' button and no form", () => {
    renderControl();
    assert.ok(screen.getByText("Adjust Worked Time"));
    assert.equal(screen.queryByLabelText("Corrected clock-in time"), null);
  });

  test("when restricted (canCorrect=false), the button is disabled and a neutral notice is shown", async () => {
    renderControl({ canCorrect: false });
    const btn = screen.getByText("Adjust Worked Time") as HTMLButtonElement;
    assert.equal(btn.getAttribute("aria-disabled"), "true");
    assert.match(screen.getByText(/temporarily unavailable/i).textContent ?? "", /account notice/i);
    await user().click(btn);
    assert.equal(screen.queryByLabelText("Corrected clock-in time"), null, "form never opens while restricted");
  });
});

describe("opening the form", () => {
  test("clicking 'Adjust Worked Time' reveals Clock-in, Clock-out, Reason inputs and Save/Cancel -- no Hours/Minutes fields", async () => {
    renderControl();
    await user().click(screen.getByText("Adjust Worked Time"));
    assert.ok(screen.getByLabelText("Corrected clock-in time"));
    assert.ok(screen.getByLabelText("Corrected clock-out time"));
    assert.ok(screen.getByLabelText("Correction reason"));
    assert.equal(screen.queryByLabelText("Corrected hours"), null);
    assert.equal(screen.queryByLabelText("Corrected minutes"), null);
    assert.ok(screen.getByText("Save Correction"));
    assert.ok(screen.getByText("Cancel"));
    assert.equal((screen.getByLabelText("Corrected clock-in time") as HTMLInputElement).type, "time");
    assert.equal((screen.getByLabelText("Corrected clock-out time") as HTMLInputElement).type, "time");
  });

  test("with an original tracked interval, Clock-in/Clock-out are pre-filled with it (in the workspace's local time)", async () => {
    // 12:55 UTC = 8:55 AM America/New_York (EDT) on 2026-09-22; 14:25 UTC = 10:25 AM
    renderControl({ initialStartedAt: "2026-09-22T12:55:00.000Z", initialCompletedAt: "2026-09-22T14:25:00.000Z" });
    await user().click(screen.getByText("Adjust Worked Time"));
    assert.equal((screen.getByLabelText("Corrected clock-in time") as HTMLInputElement).value, "08:55");
    assert.equal((screen.getByLabelText("Corrected clock-out time") as HTMLInputElement).value, "10:25");
  });

  test("with no original tracked interval, Clock-in/Clock-out start blank", async () => {
    renderControl({ initialStartedAt: null, initialCompletedAt: null });
    await user().click(screen.getByText("Adjust Worked Time"));
    assert.equal((screen.getByLabelText("Corrected clock-in time") as HTMLInputElement).value, "");
    assert.equal((screen.getByLabelText("Corrected clock-out time") as HTMLInputElement).value, "");
  });
});

describe("validation", () => {
  test("clock-out not after clock-in is rejected with no request sent", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "10:00");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "09:00");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    await u.click(screen.getByText("Save Correction"));
    assert.match(screen.getByText(/after clock-in/i).textContent ?? "", /Clock-out must be after clock-in/);
    assert.equal(calls.length, 0);
  });

  test("a missing reason is rejected with no request sent", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "08:55");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "10:25");
    await u.click(screen.getByText("Save Correction"));
    assert.match(screen.getByText(/reason is required/i).textContent ?? "", /forgot to clock out/i);
    assert.equal(calls.length, 0);
  });

  test("an empty clock-in or clock-out is rejected client-side", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "10:25");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    await u.click(screen.getByText("Save Correction"));
    assert.equal(calls.length, 0);
  });
});

describe("saving a correction", () => {
  test("Clock-in 8:55 AM / Clock-out 10:25 AM computes exactly 1.5 hours and posts it with the reason as note", async () => {
    renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "08:55");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "10:25");
    await u.type(screen.getByLabelText("Correction reason"), "Forgot to clock out");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Save Correction"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/appointments/employee-hours");
    assert.equal(calls[0].body.appointment_id, APPT_ID);
    assert.equal(calls[0].body.employee_id, EMP_ID);
    assert.ok(Math.abs(calls[0].body.hours_worked - 1.5) < 1e-9, calls[0].body.hours_worked.toString());
    assert.equal(calls[0].body.note, "Forgot to clock out");
    // the raw clock-in/clock-out strings are never sent -- only the computed duration and the reason
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["appointment_id", "employee_id", "hours_worked", "note"]);
  });

  test("on success, onSaved receives the saved entry and the form collapses back to the button", async () => {
    const { saved } = renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "08:55");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "10:25");
    await u.type(screen.getByLabelText("Correction reason"), "Forgot to clock out");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Save Correction"));

    assert.deepEqual(saved, [ENTRY]);
    assert.ok(screen.getByText("Adjust Worked Time"), "collapsed back to the button");
    assert.equal(screen.queryByLabelText("Corrected clock-in time"), null);
  });

  test("a server rejection keeps the form open, shows the server's message, and never calls onSaved", async () => {
    const { saved } = renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "08:55");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "10:25");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    responses.push(json(404, { error: "Employee is not assigned to this appointment." }));
    await u.click(screen.getByText("Save Correction"));

    assert.deepEqual(saved, []);
    assert.equal(screen.getByText("Employee is not assigned to this appointment.").tagName, "DIV");
    assert.ok(screen.getByLabelText("Corrected clock-in time"), "form stays open");
  });

  test("a network error is reported and never calls onSaved", async () => {
    const { saved } = renderControl();
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "08:55");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "10:25");
    await u.type(screen.getByLabelText("Correction reason"), "test");
    responses.push(() => { throw new TypeError("Failed to fetch"); });
    await u.click(screen.getByText("Save Correction"));

    assert.deepEqual(saved, []);
    assert.ok(screen.getByText("Network error."));
  });

  test("restricted (canCorrect=false): opening the collapsed control issues no request", async () => {
    renderControl({ canCorrect: false });
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    assert.equal(screen.queryByLabelText("Corrected clock-in time"), null);
    assert.equal(calls.length, 0);
  });
});

describe("cancel", () => {
  test("Cancel closes the form, discards edits, and reopening restores the original pre-filled values", async () => {
    renderControl({ initialStartedAt: "2026-09-22T12:55:00.000Z", initialCompletedAt: "2026-09-22T14:25:00.000Z" });
    const u = user();
    await u.click(screen.getByText("Adjust Worked Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "06:00");
    await u.type(screen.getByLabelText("Correction reason"), "scratch input");
    await u.click(screen.getByText("Cancel"));

    assert.ok(screen.getByText("Adjust Worked Time"), "collapsed");
    assert.equal(calls.length, 0, "nothing was saved");

    await u.click(screen.getByText("Adjust Worked Time"));
    assert.equal((screen.getByLabelText("Corrected clock-in time") as HTMLInputElement).value, "08:55", "reset to the original tracked value, not blank");
    assert.equal((screen.getByLabelText("Correction reason") as HTMLInputElement).value, "");
  });
});

// ============================================================================
// Add "Keep Time As Is" Review Action
// ============================================================================

describe("computeKeepAsIsHours -- pure duration calculation", () => {
  test("resolves to the exact tracked duration (8:55 AM - 10:25 AM = 1.5 hours)", () => {
    const r = computeKeepAsIsHours(TRACKED_STARTED_AT, TRACKED_COMPLETED_AT);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.hours - TRACKED_HOURS) < 1e-9, r.hours.toString());
  });

  test("no tracked interval at all -> an error, not a fabricated 0h", () => {
    const r = computeKeepAsIsHours(null, null);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /no tracked time/i);
  });

  test("an incomplete interval (only clock-in, no clock-out) -> an error", () => {
    const r = computeKeepAsIsHours(TRACKED_STARTED_AT, null);
    assert.equal(r.ok, false);
  });
});

describe("flagged (needsReview=true): two owner actions offered instead of one", () => {
  test("shows 'Correct Time' and 'Keep Time As Is' -- not the plain 'Adjust Worked Time' button", () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    assert.ok(screen.getByText("Correct Time"));
    assert.ok(screen.getByText(/Keep Time As Is/));
    assert.equal(screen.queryByText("Adjust Worked Time"), null);
  });

  test("when not flagged (needsReview=false, the default), the plain single button is shown instead", () => {
    renderControl({ initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    assert.ok(screen.getByText("Adjust Worked Time"));
    assert.equal(screen.queryByText("Correct Time"), null);
    assert.equal(screen.queryByText(/Keep Time As Is/), null);
  });

  test("when restricted (canCorrect=false), both actions are disabled and a neutral notice is shown", async () => {
    renderControl({ needsReview: true, canCorrect: false, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const correctBtn = screen.getByText("Correct Time") as HTMLButtonElement;
    const keepBtn = screen.getByText(/Keep Time As Is/) as HTMLButtonElement;
    assert.equal(correctBtn.getAttribute("aria-disabled"), "true");
    assert.equal(keepBtn.getAttribute("aria-disabled"), "true");
    assert.match(screen.getByText(/temporarily unavailable/i).textContent ?? "", /account notice/i);
    await user().click(keepBtn);
    assert.equal(screen.queryByLabelText("Review reason"), null, "form never opens while restricted");
  });
});

describe("Correct Time (flagged card) -- identical form/behavior to the unflagged 'Adjust Worked Time' path", () => {
  test("clicking 'Correct Time' reveals the same Clock-in/Clock-out/Reason form", async () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    await user().click(screen.getByText("Correct Time"));
    assert.ok(screen.getByLabelText("Corrected clock-in time"));
    assert.ok(screen.getByLabelText("Corrected clock-out time"));
    assert.ok(screen.getByLabelText("Correction reason"));
    assert.ok(screen.getByText("Save Correction"));
    assert.equal(screen.queryByLabelText("Review reason"), null, "not the Keep Time As Is form");
  });

  test("saving a real correction from the flagged card posts the computed duration exactly like before", async () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText("Correct Time"));
    await setTime(u, screen.getByLabelText("Corrected clock-in time"), "09:00");
    await setTime(u, screen.getByLabelText("Corrected clock-out time"), "12:00");
    await u.type(screen.getByLabelText("Correction reason"), "Actually finished at noon.");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Save Correction"));
    assert.equal(calls.length, 1);
    assert.ok(Math.abs(calls[0].body.hours_worked - 3) < 1e-9);
    assert.equal(calls[0].body.note, "Actually finished at noon.");
  });
});

describe("Keep Time As Is (flagged card) -- reason-only confirmation of the current tracked duration", () => {
  test("clicking 'Keep Time As Is' reveals ONLY a Reason field -- no Clock-in/Clock-out", async () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    await user().click(screen.getByText(/Keep Time As Is/));
    assert.ok(screen.getByLabelText("Review reason"));
    assert.equal(screen.queryByLabelText("Corrected clock-in time"), null);
    assert.equal(screen.queryByLabelText("Corrected clock-out time"), null);
    assert.ok(screen.getByText("Confirm Time"));
    assert.ok(screen.getByText("Cancel"));
  });

  test("a missing reason is rejected with no request sent", async () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    await u.click(screen.getByText("Confirm Time"));
    assert.match(screen.getByText(/reason is required/i).textContent ?? "", /confirm this time/i);
    assert.equal(calls.length, 0);
  });

  test("saving posts the SAME duration as the current tracked time, plus the reason -- review row saved", async () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    await u.type(screen.getByLabelText("Review reason"), "Used steam mop; job legitimately took longer.");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Confirm Time"));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/appointments/employee-hours");
    assert.equal(calls[0].body.appointment_id, APPT_ID);
    assert.equal(calls[0].body.employee_id, EMP_ID);
    assert.ok(Math.abs(calls[0].body.hours_worked - TRACKED_HOURS) < 1e-9, "stores the same effective duration -- not a new one");
    assert.equal(calls[0].body.note, "Used steam mop; job legitimately took longer.");
    // no clock-in/clock-out fields exist for this path, so none are sent
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["appointment_id", "employee_id", "hours_worked", "note"]);
  });

  test("on success, onSaved receives the saved entry and the form collapses", async () => {
    const { saved } = renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    await u.type(screen.getByLabelText("Review reason"), "Used steam mop.");
    responses.push(json(200, { ok: true, entry: ENTRY }));
    await u.click(screen.getByText("Confirm Time"));

    assert.deepEqual(saved, [ENTRY]);
    assert.equal(screen.queryByLabelText("Review reason"), null, "form collapsed");
  });

  test("a server rejection keeps the form open, shows the server's message, and never calls onSaved", async () => {
    const { saved } = renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    await u.type(screen.getByLabelText("Review reason"), "test");
    responses.push(json(404, { error: "Employee is not assigned to this appointment." }));
    await u.click(screen.getByText("Confirm Time"));

    assert.deepEqual(saved, []);
    assert.equal(screen.getByText("Employee is not assigned to this appointment.").tagName, "DIV");
    assert.ok(screen.getByLabelText("Review reason"), "form stays open");
  });

  test("a network error is reported and never calls onSaved", async () => {
    const { saved } = renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    await u.type(screen.getByLabelText("Review reason"), "test");
    responses.push(() => { throw new TypeError("Failed to fetch"); });
    await u.click(screen.getByText("Confirm Time"));

    assert.deepEqual(saved, []);
    assert.ok(screen.getByText("Network error."));
  });

  test("Cancel closes the form, discards the reason, and issues no request", async () => {
    renderControl({ needsReview: true, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    await u.type(screen.getByLabelText("Review reason"), "scratch input");
    await u.click(screen.getByText("Cancel"));

    assert.ok(screen.getByText("Correct Time"), "collapsed back to the flagged two-action chooser");
    assert.ok(screen.getByText(/Keep Time As Is/));
    assert.equal(calls.length, 0, "nothing was saved");
  });

  test("restricted (canCorrect=false): opening Keep Time As Is issues no request", async () => {
    renderControl({ needsReview: true, canCorrect: false, initialStartedAt: TRACKED_STARTED_AT, initialCompletedAt: TRACKED_COMPLETED_AT });
    const u = user();
    await u.click(screen.getByText(/Keep Time As Is/));
    assert.equal(screen.queryByLabelText("Review reason"), null);
    assert.equal(calls.length, 0);
  });
});
