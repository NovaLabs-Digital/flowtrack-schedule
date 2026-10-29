import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateDemoFixture } from "@/lib/demoLocal/fixtures/generate";
import { getSnapshot, setSnapshot } from "@/lib/demoLocal/store";
import { installDemoFetchInterceptor } from "@/lib/demoLocal/fetchInterceptor";
import { zonedDateValue } from "@/lib/timezone";
import { addDays } from "@/lib/recurrence";
import { DEMO_TIMEZONE } from "@/lib/demoLocal/fixtures/generate";

// Freeze the clock so "past/today/future" in the fixture and in the
// handlers always agree, regardless of how long the suite takes.
const NOW = new Date();
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });

// A minimal browser-like window. The original fetch is a spy that must
// NEVER be called for an /api/ path -- this suite has no network access.
const originalFetch = mock.fn(async (_input: unknown, _init?: unknown) => new Response("passthrough", { status: 200 }));
(globalThis as any).window = { fetch: originalFetch, location: { origin: "http://localhost" } };
installDemoFetchInterceptor();
const demoFetch = (globalThis as any).window.fetch as typeof fetch;

const TZ = DEMO_TIMEZONE;
const today = zonedDateValue(NOW.toISOString(), TZ);
const daysAgo = (n: number) => zonedDateValue(addDays(NOW, -n, TZ).toISOString(), TZ);

beforeEach(() => {
  setSnapshot(generateDemoFixture(NOW));
  originalFetch.mock.resetCalls();
});

async function call(path: string, method = "GET", body?: unknown) {
  const res = await demoFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function needsAttentionIdsByKind() {
  const { data } = await call("/api/dashboard/needs-attention");
  const byKind: Record<string, string> = {};
  for (const e of data.entries) for (const i of e.issues) byKind[i.kind] = e.appointmentId;
  return byKind;
}

describe("installDemoFetchInterceptor", () => {
  test("is idempotent", () => {
    installDemoFetchInterceptor();
    assert.equal((globalThis as any).window.fetch, demoFetch);
  });

  test("POST /api/appointments/create (one-time, existing client)", async () => {
    const snap = getSnapshot();
    const client = snap.clients[0];
    const employee = snap.employees[0];
    const start = addDays(NOW, 4, TZ).toISOString();
    const { status, data } = await call("/api/appointments/create", "POST", {
      client_id: client.id, service_type: "Window Washing", scheduled_for: start,
      duration_minutes: 90, employee_ids: [employee.id], price_cents: 12000,
    });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(data).sort(), ["appointmentId", "created", "ok"]);
    assert.equal(data.ok, true);
    assert.equal(data.created, 1);
    const after = getSnapshot();
    const appt = after.appointments.find((a) => a.id === data.appointmentId)!;
    assert.equal(appt.client_id, client.id);
    assert.equal(appt.series_id, null);
    assert.equal(appt.employee_id, employee.id);
    assert.equal(after.assignments.filter((a) => a.appointment_id === data.appointmentId).length, 1);
    assert.equal(originalFetch.mock.callCount(), 0);
  });

  test("POST /api/appointments/create (recurring, new client) uses real recurrence generation", async () => {
    const before = getSnapshot();
    const { status, data } = await call("/api/appointments/create", "POST", {
      name: "New Demo Client", email: "new.client@example.com", service_type: "Lawn Mowing & Edging",
      scheduled_for: addDays(NOW, 2, TZ).toISOString(), frequency_type: "weekly", repeat_weeks: 2,
    });
    assert.equal(status, 200);
    assert.ok(data.created > 1);
    const after = getSnapshot();
    assert.equal(after.clients.length, before.clients.length + 1);
    const created = after.appointments.filter((a) => a.series_id && a.series_id === after.appointments.find((x) => x.id === data.appointmentId)!.series_id);
    assert.equal(created.length, data.created);
  });

  test("POST /api/appointments/create rejects missing fields", async () => {
    const { status, data } = await call("/api/appointments/create", "POST", { client_id: getSnapshot().clients[0].id });
    assert.equal(status, 400);
    assert.equal(data.error, "Missing required fields");
  });

  test("GET /api/billing/completed-jobs", async () => {
    const { status, data } = await call(`/api/billing/completed-jobs?start=${daysAgo(120)}&end=${today}`);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(data).sort(), ["completed", "reviewNeeded", "timezone"]);
    assert.equal(data.timezone, TZ);
    assert.equal(data.reviewNeeded.length, 1);
    assert.ok(data.completed.length > 5);
    assert.ok(data.completed.some((r: any) => r.billing === null));
    assert.ok(data.completed.some((r: any) => r.billing && r.billing.invoice_number && !r.billing.paid));

    const bad = await call("/api/billing/completed-jobs?start=nope&end=" + today);
    assert.equal(bad.status, 400);
  });

  test("PATCH /api/billing/completed-jobs/update marks paid and returns { ok, billing }", async () => {
    const ids = await needsAttentionIdsByKind();
    const apptId = ids.payment_outstanding;
    const { status, data } = await call("/api/billing/completed-jobs/update", "PATCH", { appointment_id: apptId, paid: true, payment_method: "zelle" });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.billing.appointment_id, apptId);
    assert.equal(data.billing.paid, true);
    assert.equal(data.billing.payment_method, "zelle");
    assert.ok(getSnapshot().completedJobBilling.find((b) => b.appointment_id === apptId)!.paid);
  });

  test("PATCH update syncs paid state across same-client, same-invoice siblings", async () => {
    const billing = getSnapshot().completedJobBilling;
    const pair = billing.find((b) => b.invoice_number && billing.some((o) => o !== b && o.invoice_number === b.invoice_number && o.client_id === b.client_id))!;
    assert.ok(pair, "fixture should contain a shared-invoice pair");
    const { status } = await call("/api/billing/completed-jobs/update", "PATCH", { appointment_id: pair.appointment_id, paid: false });
    assert.equal(status, 200);
    const group = getSnapshot().completedJobBilling.filter((b) => b.invoice_number === pair.invoice_number);
    assert.ok(group.length >= 2);
    assert.ok(group.every((b) => b.paid === false));
  });

  test("PATCH update rejects a not-completed job and a cross-client invoice number", async () => {
    const ids = await needsAttentionIdsByKind();
    const notDone = await call("/api/billing/completed-jobs/update", "PATCH", { appointment_id: ids.worked_time_review, invoice_number: "9999" });
    assert.equal(notDone.status, 409);

    const snap = getSnapshot();
    const target = snap.appointments.find((a) => a.id === ids.needs_invoicing)!;
    const otherClientInvoice = snap.completedJobBilling.find((b) => b.invoice_number && b.client_id !== target.client_id)!;
    const conflict = await call("/api/billing/completed-jobs/update", "PATCH", { appointment_id: target.id, invoice_number: otherClientInvoice.invoice_number });
    assert.equal(conflict.status, 409);
  });

  test("GET /api/dashboard/needs-attention returns the real route's shape with exactly 4 entries", async () => {
    const { status, data } = await call("/api/dashboard/needs-attention?limit=25&offset=0");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(data).sort(), ["entries", "hasMore", "rangeEnd", "rangeStart", "timezone", "totalCount"]);
    assert.equal(data.totalCount, 4);
    assert.equal(data.entries.length, 4);
    assert.equal(data.hasMore, false);
    assert.equal(data.rangeEnd, today);
    assert.equal(data.rangeStart, daysAgo(60));
    const kinds = data.entries.flatMap((e: any) => e.issues.map((i: any) => i.kind)).sort();
    assert.deepEqual(kinds, ["failed_message", "needs_invoicing", "payment_outstanding", "worked_time_review"]);
  });

  test("POST /api/auth/logout", async () => {
    const { status, data } = await call("/api/auth/logout", "POST");
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
  });

  test("GET /api/appointments/messages and /api/clients/messages return the empty state", async () => {
    const a = await call("/api/appointments/messages?appointment_id=x");
    const c = await call("/api/clients/messages?client_id=x");
    assert.equal(a.status, 200);
    assert.equal(c.status, 200);
    assert.deepEqual(a.data, { ok: true, messages: [], hasMore: false });
    assert.deepEqual(c.data, { ok: true, messages: [], hasMore: false });
  });

  test("an unlisted /api/ path fails closed with 404 and never reaches the network", async () => {
    const errorSpy = mock.method(console, "error", () => {});
    try {
      const { status, data } = await call("/api/appointments/delete", "POST", { id: "x" });
      assert.equal(status, 404);
      assert.deepEqual(data, { error: "Not available in this demo." });
      // A known path with the wrong method is also unhandled.
      const wrongMethod = await call("/api/billing/completed-jobs/update", "POST", {});
      assert.equal(wrongMethod.status, 404);
      assert.equal(originalFetch.mock.callCount(), 0);
      assert.ok(errorSpy.mock.calls.some((c) => c.arguments[0] === "DEMO_FETCH_UNHANDLED"));
    } finally {
      errorSpy.mock.restore();
    }
  });

  test("non-/api/ requests pass through to the original fetch", async () => {
    const res = await demoFetch("/_next/static/chunk.js");
    assert.equal(await res.text(), "passthrough");
    assert.equal(originalFetch.mock.callCount(), 1);
  });
});
