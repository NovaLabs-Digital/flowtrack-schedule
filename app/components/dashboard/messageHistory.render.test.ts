// RENDERED verification of MessageHistory.tsx -- renders the REAL
// AppointmentMessageHistory/ClientMessageHistory components with REAL React
// into jsdom. Only the network is faked: a scripted `fetch` stands in for
// GET /api/appointments/messages and GET /api/clients/messages. Same pattern
// as app/components/dashboard/BillingPanel.test.ts.
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { AppointmentMessageHistory, ClientMessageHistory } = await import("./MessageHistory.tsx");

const TZ = "America/New_York";

type Call = { url: string };
let calls: Call[] = [];
let responses: Array<() => Promise<Response> | Response> = [];
const originalFetch = globalThis.fetch;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted fetch to ${String(input)}`);
    return next();
  }) as typeof fetch;
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function msg(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m1", channel: "email", kindLabel: "Appointment Confirmation", toValue: "client@example.com",
    body: "Your appointment is confirmed for Tuesday.", subject: "Appointment Confirmed",
    status: { code: "sent", label: "Sent — delivery unconfirmed" },
    createdAt: "2026-01-02T15:00:00.000Z", scheduledFor: null,
    ...overrides,
  };
}

describe("AppointmentMessageHistory", () => {
  test("fetches the appointment-scoped endpoint with this exact appointment_id", async () => {
    responses.push(json(200, { ok: true, messages: [], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-123", timezone: TZ }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.ok(calls[0].url.includes("/api/appointments/messages?appointment_id=appt-123"));
  });

  test("zero messages shows 'No message record available.' -- never any wording implying 'not sent'", async () => {
    responses.push(json(200, { ok: true, messages: [], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    await screen.findByText("No message record available.");
    assert.equal(screen.queryByText(/not sent/i), null);
  });

  test("renders channel, kind, recipient, and status for each stored message", async () => {
    responses.push(json(200, { ok: true, messages: [msg()], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    await screen.findByText("Appointment Confirmation");
    assert.ok(screen.getByText("Email"));
    assert.ok(screen.getByText(/client@example\.com/));
    assert.ok(screen.getByText("Sent — delivery unconfirmed"));
  });

  test("every status label this app can produce renders exactly as classifyMessageStatus defines it -- no Queued/Delivered/Read ever appears", async () => {
    const rows = [
      msg({ id: "m1", status: { code: "failed", label: "Failed" } }),
      msg({ id: "m2", status: { code: "skipped_disabled", label: "Skipped — message sending was disabled" } }),
      msg({ id: "m3", status: { code: "skipped_notifications_off", label: "Skipped — client notifications were off" } }),
      msg({ id: "m4", status: { code: "unknown", label: "Unknown" } }),
    ];
    responses.push(json(200, { ok: true, messages: rows, hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    await screen.findByText("Failed");
    assert.ok(screen.getByText("Skipped — message sending was disabled"));
    assert.ok(screen.getByText("Skipped — client notifications were off"));
    assert.ok(screen.getByText("Unknown"));
    for (const banned of ["Queued", "Delivered", "Read"]) {
      assert.equal(screen.queryByText(banned), null);
    }
  });

  test("'View message' reveals the stored subject and body verbatim, and only appears when a snapshot exists", async () => {
    responses.push(json(200, { ok: true, messages: [msg({ subject: "Historic Subject Line", body: "Historic body content." })], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    const toggle = await screen.findByText("View message");
    assert.equal(screen.queryByText("Historic body content."), null, "collapsed by default");
    await userEvent.click(toggle);
    assert.ok(screen.getByText(/Historic Subject Line/));
    assert.ok(screen.getByText("Historic body content."));
    assert.ok(screen.getByText("Hide message"));
  });

  test("an older record with a null subject shows 'Not captured' for subject rather than a blank or guessed value, while still showing the stored body", async () => {
    responses.push(json(200, { ok: true, messages: [msg({ subject: null, body: "Body survives even when subject wasn't captured." })], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    const toggle = await screen.findByText("View message");
    await userEvent.click(toggle);
    assert.ok(screen.getByText("Not captured"));
    assert.ok(screen.getByText("Body survives even when subject wasn't captured."));
  });

  test("an sms message (no subject concept) never shows a 'View message' toggle unless it has a body snapshot, and never shows a Subject line when expanded", async () => {
    responses.push(json(200, { ok: true, messages: [msg({ channel: "sms", subject: null, body: "Reminder: your appt is tomorrow." })], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    const toggle = await screen.findByText("View message");
    await userEvent.click(toggle);
    assert.equal(screen.queryByText(/Subject:/), null);
    assert.ok(screen.getByText("Reminder: your appt is tomorrow."));
  });

  test("bounded pagination: 'Show more' fetches the next offset and appends, never replaces, the first page", async () => {
    responses.push(json(200, { ok: true, messages: [msg({ id: "m1" })], hasMore: true }));
    responses.push(json(200, { ok: true, messages: [msg({ id: "m2", toValue: "second@example.com" })], hasMore: false }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    const showMore = await screen.findByText("Show more");
    await userEvent.click(showMore);
    await waitFor(() => assert.equal(calls.length, 2));
    assert.ok(calls[1].url.includes("offset=1"));
    await screen.findByText(/second@example\.com/);
    assert.ok(screen.getByText(/client@example\.com/), "first page's row is still present, not replaced");
    assert.equal(screen.queryByText("Show more"), null, "hasMore=false on the second page removes the control");
  });

  test("a fetch error shows an error message rather than silently rendering an empty list", async () => {
    responses.push(json(500, { error: "Server error" }));
    render(React.createElement(AppointmentMessageHistory, { appointmentId: "appt-1", timezone: TZ }));
    await screen.findByText("Server error");
    assert.equal(screen.queryByText("No message record available."), null);
  });
});

describe("ClientMessageHistory", () => {
  test("fetches the client-scoped endpoint with this exact client_id, distinct from the appointment-scoped route", async () => {
    responses.push(json(200, { ok: true, messages: [], hasMore: false }));
    render(React.createElement(ClientMessageHistory, { clientId: "client-456", timezone: TZ }));
    await waitFor(() => assert.equal(calls.length, 1));
    assert.ok(calls[0].url.includes("/api/clients/messages?client_id=client-456"));
    assert.ok(!calls[0].url.includes("appointment_id"));
  });

  test("switching clients while the first client's request is still pending never displays that stale response, even if it resolves AFTER the new client's own request", async () => {
    // Client A's response is deliberately delayed so it resolves AFTER
    // client B's -- the exact inversion that exposes a missing staleness
    // guard: a naive implementation applies whichever response arrives
    // LAST, not whichever request was issued last.
    let resolveA!: () => void;
    const aGate = new Promise<void>((resolve) => { resolveA = resolve; });
    responses.push(() => aGate.then(() => new Response(
      JSON.stringify({ ok: true, messages: [msg({ id: "a1", toValue: "stale-clientA@example.com" })], hasMore: false }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )));
    responses.push(json(200, { ok: true, messages: [msg({ id: "b1", toValue: "current-clientB@example.com" })], hasMore: false }));

    const { rerender } = render(React.createElement(ClientMessageHistory, { clientId: "client-A", timezone: TZ }));
    await waitFor(() => assert.equal(calls.length, 1)); // client A's request is now in flight, unresolved

    rerender(React.createElement(ClientMessageHistory, { clientId: "client-B", timezone: TZ }));
    await waitFor(() => assert.equal(calls.length, 2)); // client B's request issued while A is still pending

    await screen.findByText(/current-clientB@example\.com/); // B resolves first
    assert.equal(screen.queryByText(/stale-clientA@example\.com/), null, "sanity check: A's stale row must not be visible before it even resolves");

    // NOW let A's delayed response land, after B's already rendered.
    resolveA();
    await waitFor(() => assert.ok(screen.getByText(/current-clientB@example\.com/)));
    assert.equal(screen.queryByText(/stale-clientA@example\.com/), null, "client A's stale response must never overwrite client B's current state, even arriving after it");
  });

  test("re-fetches from scratch when the client id changes, discarding the previous client's messages", async () => {
    responses.push(json(200, { ok: true, messages: [msg({ id: "a1", toValue: "clientA@example.com" })], hasMore: false }));
    const { rerender } = render(React.createElement(ClientMessageHistory, { clientId: "client-A", timezone: TZ }));
    await screen.findByText(/clientA@example\.com/);

    responses.push(json(200, { ok: true, messages: [msg({ id: "b1", toValue: "clientB@example.com" })], hasMore: false }));
    rerender(React.createElement(ClientMessageHistory, { clientId: "client-B", timezone: TZ }));
    await screen.findByText(/clientB@example\.com/);
    assert.equal(screen.queryByText(/clientA@example\.com/), null, "switching clients must not leave the previous client's history mixed in");
  });
});
