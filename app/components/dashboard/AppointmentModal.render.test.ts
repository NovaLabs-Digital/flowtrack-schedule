// RENDERED verification of the atomic recurrence save in AppointmentModal.
//
// Unlike AppointmentModal.test.ts (source inspection), this file renders the
// REAL AppointmentModal.tsx component with real React into a jsdom DOM and
// drives it with real user-event interaction. Only the network is faked: a
// scripted `fetch` stands in for the server, so nothing is written anywhere.
//
// What this proves: the component's behavior (what it sends, what it shows,
// when it closes, operation-id reuse). What it does NOT prove: pixel layout,
// CSS, or that the text is visible on screen -- jsdom has no layout engine, so
// "visible" here means "present in the rendered DOM and not inside a hidden
// or collapsed container".
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Node cannot import .tsx by itself; opt this one test into the transpile hook.
register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: AppointmentModal } = await import("./AppointmentModal.tsx");

const TZ = "America/New_York";
const EMP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPT_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT = "/api/appointments/manage-recurrence";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A one-time appointment on Tue Sept 29 2026, 10:30-11:30 AM New York (14:30Z),
// assigned to two employees -- the shape of the reported bug (owner moves it to
// Tue Sept 22 at 9:00 AM and makes it repeat every 4 weeks).
const appointment = {
  id: APPT_ID, client_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", service_type: "Regular Cleaning",
  scheduled_for: "2026-09-29T14:30:00+00:00", scheduled_end: "2026-09-29T15:30:00+00:00", status: "scheduled" as const,
  notes: null, duration_minutes: 60, series_id: null, frequency_type: "one_time", repeat_weeks: 1, repeat_months: null,
  price_cents: 9000, team_color: null,
};
const client = { id: appointment.client_id, name: "Izabel", email: "izabel@example.com", phone: null };
const employees = [
  { id: EMP_A, name: "Ana", phone: null, color: "#3B82F6", active: true },
  { id: EMP_B, name: "Bea", phone: null, color: "#10B981", active: true },
];
const assignments = [EMP_A, EMP_B].map((employee_id, i) => ({
  id: `dddddddd-dddd-4ddd-8ddd-00000000000${i}`, appointment_id: APPT_ID, employee_id,
  actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
}));
const services = [{ id: "s1", name: "Regular Cleaning", description: null, duration_minutes: 60, active: true, color: "#3B82F6", default_price_cents: 9000 }];

// --- scripted server ---------------------------------------------------
// Request bodies are inspected structurally, field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Call = { url: string; method: string; body: Record<string, any> };
let calls: Call[] = [];
let responses: Array<() => Promise<Response> | Response> = [];
const alerts: string[] = [];
let saved = 0;
const originalFetch = globalThis.fetch;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = []; responses = []; alerts.length = 0; saved = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : {} });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted fetch to ${String(input)}`);
    return next();
  }) as typeof fetch;
  const recordAlert = (m: string) => { alerts.push(m); };
  Object.assign(globalThis, { alert: recordAlert });
  Object.assign(window, { alert: recordAlert });
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

// The parent (DashboardShell) unmounts the modal on save; mirror that so
// "success closes the modal" is observed in the DOM, not assumed.
function Host() {
  const [open, setOpen] = React.useState(true);
  if (!open) return React.createElement("div", { "data-testid": "closed" }, "closed");
  return React.createElement(AppointmentModal, {
    onClose: () => setOpen(false), onSaved: () => { saved++; setOpen(false); },
    clients: [client], appointments: [appointment], services, employees, employeeHours: [], assignments,
    editing: { appointment, client }, canMutateOperationalData: true, timezone: TZ,
  });
}

const user = () => userEvent.setup();
const modalOpen = () => screen.queryByText("Save Changes") !== null;
const selectAfterLabel = (label: string) => {
  const el = screen.getByText(label).parentElement!.querySelector("select");
  assert.ok(el, `select for ${label}`);
  return el as HTMLSelectElement;
};

// Owner flow from the report: open Manage, choose Weekly / every 4 weeks, move
// the appointment to Sept 22 at 9:00 AM, then COLLAPSE the panel.
async function fillIzabelChange(u: ReturnType<typeof user>, { collapse = true } = {}) {
  await u.click(screen.getByText("Manage >"));
  await u.click(screen.getByRole("radio", { name: "Weekly" }));
  await u.selectOptions(screen.getByText("Repeat every").parentElement!.querySelector("select")!, "4");
  fireEvent.change(document.querySelector("input[type=date]")!, { target: { value: "2026-09-22" } });
  await u.selectOptions(selectAfterLabel("Time In *"), "09:00");
  if (collapse) {
    const panel = screen.getByText("Manage Recurrence").closest("div")!.parentElement!;
    await u.click(within(panel).getByText("Cancel"));
  }
}

const SCOPE_TEXT = /Saving will update this appointment and apply the new recurrence pattern to its eligible future occurrences/;

describe("rendered AppointmentModal: date/time + four-week recurrence is ONE atomic operation", () => {
  test("Save sends exactly one request to manage-recurrence carrying the date/time, the recurrence, the employees and the opening snapshot -- and no separate update", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u);
    responses.push(json(200, { ok: true, cancelled: 0, created: 6 }));
    await u.click(screen.getByText("Save Changes"));

    assert.equal(calls.length, 1, `expected one request, got: ${calls.map((c) => c.url).join(", ")}`);
    const [call] = calls;
    assert.equal(call.url, ENDPOINT);
    assert.equal(call.method, "POST");
    assert.ok(!calls.some((c) => c.url.includes("/appointments/update")), "no separate appointment update");
    const b = call.body;
    assert.equal(b.appointment_id, APPT_ID);
    assert.match(b.client_operation_id, UUID_RE);
    assert.equal(b.frequency_type, "weekly");
    assert.equal(b.repeat_weeks, 4);
    // Sept 22 2026 9:00 AM New York (EDT) = 13:00Z, 1 hour long (duration preserved)
    assert.equal(b.fields.scheduled_for, "2026-09-22T13:00:00.000Z");
    assert.equal(b.fields.scheduled_end, "2026-09-22T14:00:00.000Z");
    assert.equal(b.fields.service_type, "Regular Cleaning");
    assert.equal(b.fields.status, "scheduled");
    assert.deepEqual(b.employee_ids, [EMP_A, EMP_B]);
    // the snapshot is what the modal OPENED with (not the edited values)
    assert.equal(b.expected.scheduled_for, appointment.scheduled_for);
    assert.equal(b.expected.frequency_type, "one_time");
    assert.deepEqual(b.expected.employee_ids, [EMP_A, EMP_B]);
    assert.equal(b.expected.timezone, TZ);
    // the client never supplies the cancellation boundary
    assert.ok(!("previous_scheduled_for" in b) && !("previous_scheduled_for" in b.fields));
  });

  test("success closes the modal (the parent's onSaved ran once and the form is gone)", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u);
    responses.push(json(200, { ok: true, cancelled: 0, created: 6 }));
    await u.click(screen.getByText("Save Changes"));
    assert.equal(saved, 1);
    assert.ok(screen.getByTestId("closed"));
    assert.ok(!modalOpen());
  });

  test("a server notice about kept occurrences is shown to the owner on success", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u);
    responses.push(json(200, { ok: true, notice: { message: "1 occurrence with recorded work was kept on the previous schedule and left unchanged." } }));
    await u.click(screen.getByText("Save Changes"));
    assert.deepEqual(alerts, ["1 occurrence with recorded work was kept on the previous schedule and left unchanged."]);
    assert.equal(saved, 1);
  });
});

describe("rendered AppointmentModal: rejection leaves the modal open and says nothing was saved", () => {
  const rejections: Array<[string, number, Record<string, unknown>]> = [
    ["stale snapshot", 409, { error: "This appointment was changed by someone else after you opened it. Nothing was saved -- please close and reopen it, then try again.", code: "STALE_SNAPSHOT" }],
    ["past record (message without the phrase)", 409, { error: "This appointment is a past record and can no longer be changed.", code: "APPOINTMENT_IS_HISTORICAL" }],
    ["blocked employee removal", 409, { error: "One or more employees being removed already have recorded worked hours and cannot be removed here.", code: "ASSIGNMENT_REMOVAL_BLOCKED" }],
    ["operation id reused for a different change", 409, { error: "This save request was already used for a different change. Please try again.", code: "OPERATION_ID_CONFLICT" }],
    ["invalid request", 400, { error: "The requested change was not valid." }],
    ["server refused with no message", 403, {}],
  ];
  for (const [name, status, body] of rejections) {
    test(`${name}: modal stays open, onSaved not called, error states nothing was saved`, async () => {
      render(React.createElement(Host));
      const u = user();
      await fillIzabelChange(u);
      responses.push(json(status, body));
      await u.click(screen.getByText("Save Changes"));
      assert.equal(saved, 0);
      assert.ok(modalOpen(), "modal still open");
      assert.equal(screen.queryByTestId("closed"), null);
      const shown = document.querySelector(".text-rose-700")?.textContent ?? "";
      assert.match(shown, /nothing was saved/i);
      if (typeof body.error === "string") assert.ok(shown.startsWith(body.error), "the server's own explanation is kept");
      // the owner's edits are still in the form, ready to retry
      assert.equal((document.querySelector("input[type=date]") as HTMLInputElement).value, "2026-09-22");
    });
  }

  test("a lost response (network error) leaves the modal open and does NOT claim nothing was saved", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u);
    responses.push(() => { throw new TypeError("Failed to fetch"); });
    await u.click(screen.getByText("Save Changes"));
    assert.equal(saved, 0);
    assert.ok(modalOpen());
    const shown = document.querySelector(".text-rose-700")?.textContent ?? "";
    assert.match(shown, /Network error/);
    assert.match(shown, /nothing will be applied twice/i);
    assert.doesNotMatch(shown, /nothing was saved/i, "the outcome is unknown, so it must not say that");
  });
});

describe("rendered AppointmentModal: operation identity", () => {
  test("retrying UNCHANGED input reuses the operation id; the retry then succeeds and closes", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u);
    responses.push(() => { throw new TypeError("Failed to fetch"); });
    await u.click(screen.getByText("Save Changes"));
    responses.push(json(200, { ok: true, alreadyApplied: true }));
    await u.click(screen.getByText("Save Changes"));
    assert.equal(calls.length, 2);
    assert.match(calls[0].body.client_operation_id, UUID_RE);
    assert.equal(calls[1].body.client_operation_id, calls[0].body.client_operation_id, "same id for the same request");
    assert.deepEqual(calls[1].body, calls[0].body, "identical request body on retry");
    assert.equal(saved, 1);
  });

  test("reuses the id after a server rejection too, as long as nothing changed", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u);
    responses.push(json(409, { error: "x", code: "ROLLED_BACK" }));
    await u.click(screen.getByText("Save Changes"));
    responses.push(json(409, { error: "x", code: "ROLLED_BACK" }));
    await u.click(screen.getByText("Save Changes"));
    assert.equal(calls[1].body.client_operation_id, calls[0].body.client_operation_id);
  });

  test("changing the request mints a new operation id (time, notes, recurrence interval); an unchanged retry keeps it", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u, { collapse: false });
    const ids: string[] = [];
    const attempt = async () => {
      responses.push(json(409, { error: "x", code: "ROLLED_BACK" }));
      await u.click(screen.getByText("Save Recurrence"));
      ids.push(calls[calls.length - 1].body.client_operation_id);
    };
    await attempt();                                                                   // baseline
    await attempt();                                                                   // unchanged -> same id
    assert.equal(ids[1], ids[0]);
    await u.selectOptions(selectAfterLabel("Time In *"), "09:15");                     // time
    await attempt();
    await u.type(screen.getByPlaceholderText(/notes/i), "gate code 1234");             // notes
    await attempt();
    await u.selectOptions(screen.getByText("Repeat every").parentElement!.querySelector("select")!, "3"); // interval
    await attempt();
    assert.equal(new Set(ids).size, 4, `ids: ${ids.join(", ")}`);
    for (const id of ids) assert.match(id, UUID_RE);
    // and the bodies really did differ where the owner changed things
    const last = calls[calls.length - 1].body;
    assert.equal(last.repeat_weeks, 3);
    assert.equal(last.fields.notes, "gate code 1234");
  });
});

describe("rendered AppointmentModal: series scope explanation", () => {
  test("hidden when nothing about recurrence changed", async () => {
    render(React.createElement(Host));
    assert.equal(screen.queryByText(SCOPE_TEXT), null);
  });

  test("visible with Manage Recurrence EXPANDED", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u, { collapse: false });
    assert.ok(screen.getByText("Manage Recurrence"), "panel is expanded");
    assert.ok(screen.getByText(SCOPE_TEXT));
  });

  test("visible with Manage Recurrence COLLAPSED (the panel heading is gone, the explanation is still rendered)", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u, { collapse: true });
    assert.equal(screen.queryByText("Manage Recurrence"), null, "panel is collapsed");
    const note = screen.getByText(SCOPE_TEXT);
    assert.match(note.textContent ?? "", /Occurrences with recorded work will be left on their current schedule/);
    // not inside anything hidden
    for (let el: HTMLElement | null = note; el; el = el.parentElement) {
      assert.ok(!el.hidden && el.getAttribute("aria-hidden") !== "true" && el.style.display !== "none", "no hidden ancestor");
    }
    // and it sits next to the Save button the owner will press
    assert.ok(screen.getByText("Save Changes"));
  });

  test("the panel's own note says the other edits are saved together, all or nothing", async () => {
    render(React.createElement(Host));
    const u = user();
    await fillIzabelChange(u, { collapse: false });
    assert.ok(screen.getByText(/saved together with this recurrence change -- all of it is saved, or none of it/));
  });
});
