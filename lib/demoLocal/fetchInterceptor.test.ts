import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateDemoFixture } from "@/lib/demoLocal/fixtures/generate";
import { getSnapshot, setSnapshot, clearDemoSession, DEMO_STORAGE_KEY } from "@/lib/demoLocal/store";
import { installDemoFetchInterceptor, evaluateSeriesConsistencyLocal } from "@/lib/demoLocal/fetchInterceptor";
import { classifyMessageStatus, describeMessageKind } from "@/lib/messageStatus";
import { zonedDateValue } from "@/lib/timezone";
import { addDays } from "@/lib/recurrence";
import { effectiveBusinessHours } from "@/lib/businessHours";
import { DEMO_TIMEZONE } from "@/lib/demoLocal/fixtures/generate";

// Freeze the clock so "past/today/future" in the fixture and in the
// handlers always agree, regardless of how long the suite takes.
const NOW = new Date();
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });

// A minimal browser-like window. The original fetch is a spy that must
// NEVER be called for an /api/ path -- this suite has no network access.
const originalFetch = mock.fn(async (_input: unknown, _init?: unknown) => new Response("passthrough", { status: 200 }));
// pathname "/demo": the interceptor self-uninstalls on the first call made
// from any other path (see the lifecycle tests at the end of this file).
(globalThis as any).window = { fetch: originalFetch, location: { origin: "http://localhost", pathname: "/demo" } };
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

  test("PATCH /api/appointments/update: edits a future scheduled appointment's service and notifies via { ok: true }", async () => {
    const future = getSnapshot().appointments.find((a) => a.status === "scheduled" && new Date(a.scheduled_for).getTime() > NOW.getTime())!;
    const { status, data } = await call("/api/appointments/update", "PATCH", {
      appointment_id: future.id, service_type: "Pressure Washing", mode: "single", notify_channel: "none",
    });
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
    assert.equal(getSnapshot().appointments.find((a) => a.id === future.id)!.service_type, "Pressure Washing");
  });

  test("PATCH /api/appointments/update rejects editing a historical (past/completed) appointment", async () => {
    const past = getSnapshot().appointments.find((a) => a.status === "scheduled" && new Date(a.scheduled_for).getTime() < NOW.getTime())!;
    const { status, data } = await call("/api/appointments/update", "PATCH", { appointment_id: past.id, service_type: "Pressure Washing", mode: "single" });
    assert.equal(status, 409);
    assert.equal(data.code, "APPOINTMENT_IS_HISTORICAL");
  });

  test("PATCH /api/appointments/update: missing appointment_id (400) and unknown id (404)", async () => {
    const missing = await call("/api/appointments/update", "PATCH", { service_type: "x" });
    assert.equal(missing.status, 400);
    const unknown = await call("/api/appointments/update", "PATCH", { appointment_id: "nope", service_type: "x" });
    assert.equal(unknown.status, 404);
  });

  test("PATCH /api/appointments/update (mode: future) propagates the service change to future siblings in the same series, never to past ones", async () => {
    const snap = getSnapshot();
    const seriesId = snap.appointments.find((a) => a.series_id && a.status === "scheduled" && new Date(a.scheduled_for).getTime() > NOW.getTime())!.series_id!;
    const seriesAppts = snap.appointments.filter((a) => a.series_id === seriesId).sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
    const anchor = seriesAppts.find((a) => a.status === "scheduled" && new Date(a.scheduled_for).getTime() > NOW.getTime())!;
    const laterSibling = seriesAppts.find((a) => a.id !== anchor.id && a.status === "scheduled" && a.scheduled_for > anchor.scheduled_for);
    const earlierOrPast = seriesAppts.find((a) => a.id !== anchor.id && a.scheduled_for <= anchor.scheduled_for);
    const earlierOrPastOriginalService = earlierOrPast?.service_type;

    const { status } = await call("/api/appointments/update", "PATCH", { appointment_id: anchor.id, service_type: "Property Inspection", mode: "future" });
    assert.equal(status, 200);
    const after = getSnapshot().appointments;
    assert.equal(after.find((a) => a.id === anchor.id)!.service_type, "Property Inspection");
    if (laterSibling) assert.equal(after.find((a) => a.id === laterSibling.id)!.service_type, "Property Inspection");
    if (earlierOrPast) assert.equal(after.find((a) => a.id === earlierOrPast.id)!.service_type, earlierOrPastOriginalService, "a past/earlier sibling must never be touched by a future-mode edit");
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

// Layout-parity correction: the real Settings panels (StaffPanel,
// ServicesPanel, ArchivedClientsPanel, RecurringSeriesPanel, CompanyInfoPanel)
// now render in the demo (see DashboardSettingsArea.tsx's isLocalDemo
// branch), so they need real data to VIEW. Their write handlers are covered
// by the Stage 2 blocks below.
describe("installDemoFetchInterceptor -- Settings layout-parity GET handlers", () => {
  test("GET /api/employees returns the bare fixture array (not wrapped)", async () => {
    const { status, data } = await call("/api/employees");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, getSnapshot().employees.length);
    for (const row of data) {
      assert.ok(typeof row.id === "string" && typeof row.name === "string" && typeof row.phone === "string" && typeof row.color === "string" && typeof row.active === "boolean");
    }
  });

  test("GET /api/services returns { ok: true, services }", async () => {
    const { status, data } = await call("/api/services");
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.services.length, getSnapshot().services.length);
    for (const row of data.services) {
      assert.ok(
        typeof row.id === "string" &&
          typeof row.name === "string" &&
          typeof row.description === "string" &&
          typeof row.duration_minutes === "number" &&
          typeof row.active === "boolean" &&
          typeof row.color === "string" &&
          typeof row.default_price_cents === "number"
      );
    }
  });

  test("GET /api/clients/archived returns { ok: true, clients } -- exactly the 2 fixture rows with archived_at set", async () => {
    const { status, data } = await call("/api/clients/archived");
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.clients.length, 2);
    const names = data.clients.map((c: { name: string }) => c.name).sort();
    assert.deepEqual(names, ["Douglas Fenwick", "Felix Contreras"]);
    for (const row of data.clients) assert.ok(row.archived_at != null);
  });

  test("GET /api/settings/company returns { ok, settings, status } with hardcoded-false integration flags, never derived from env", async () => {
    const previousResend = process.env.RESEND_API_KEY;
    const previousResendFrom = process.env.RESEND_FROM_EMAIL;
    const previousTwilioSid = process.env.TWILIO_ACCOUNT_SID;
    // Prove the hardcode, not an accidentally-false env in this test process:
    // set every real env var the production route reads, and confirm the
    // demo handler STILL reports both as unconfigured.
    process.env.RESEND_API_KEY = "re_test";
    process.env.RESEND_FROM_EMAIL = "test@example.com";
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    try {
      const { status, data } = await call("/api/settings/company");
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.settings.company_name, "Sunshine Property Services");
      // The fixture's own companySettings.business_hours is null (not
      // customized) -- the handler must resolve it through the real
      // effectiveBusinessHours fallback, same as the production route.
      assert.equal(getSnapshot().companySettings.business_hours, null);
      assert.deepEqual(data.settings.business_hours, effectiveBusinessHours(null));
      assert.equal(data.status.emailConfigured, false);
      assert.equal(data.status.smsConfigured, false);
      const snap = getSnapshot();
      assert.equal(data.status.totalStaff, snap.employees.length);
      assert.equal(data.status.activeStaff, snap.employees.filter((e) => e.active).length);
    } finally {
      process.env.RESEND_API_KEY = previousResend;
      process.env.RESEND_FROM_EMAIL = previousResendFrom;
      process.env.TWILIO_ACCOUNT_SID = previousTwilioSid;
    }
  });
});

// ---------------------------------------------------------------------
// Stage 2: local write handlers for the Settings panels.
// ---------------------------------------------------------------------
describe("installDemoFetchInterceptor -- Stage 2 Settings writes", () => {
  test("POST /api/employees creates a row (201, real response shape) and never stores the password", async () => {
    const before = getSnapshot().employees.length;
    const { status, data } = await call("/api/employees", "POST", {
      name: "  Lena Ortiz ", phone: "(407) 555-0299", email: " Lena@Example.COM ", position: "Crew Lead", password: "hunter22",
    });
    assert.equal(status, 201);
    assert.deepEqual(Object.keys(data).sort(), ["active", "color", "email", "id", "name", "phone", "position"]);
    assert.equal(data.name, "Lena Ortiz");
    assert.equal(data.email, "lena@example.com");
    assert.equal(data.color, "#3B82F6");
    assert.equal(data.active, true);
    const after = getSnapshot();
    assert.equal(after.employees.length, before + 1);
    // No password, hash, or credential of any kind anywhere in the store.
    assert.ok(!JSON.stringify(after).includes("hunter22"));
    for (const e of after.employees) assert.ok(!Object.keys(e).some((k) => /pass/i.test(k)));
    const list = await call("/api/employees");
    assert.ok(list.data.some((e: any) => e.id === data.id));
  });

  test("POST /api/employees rejects a blank name", async () => {
    const { status, data } = await call("/api/employees", "POST", { name: "   " });
    assert.equal(status, 400);
    assert.equal(data.error, "Name is required");
  });

  test("PATCH /api/employees updates fields; rejects missing id, unknown id, and an empty update", async () => {
    const emp = getSnapshot().employees[0];
    const ok = await call("/api/employees", "PATCH", { id: emp.id, active: false, position: "Seasonal", password: "newpass" });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.data, { ok: true });
    const updated = getSnapshot().employees.find((e) => e.id === emp.id)!;
    assert.equal(updated.active, false);
    assert.equal(updated.position, "Seasonal");
    assert.ok(!JSON.stringify(getSnapshot()).includes("newpass"));

    assert.equal((await call("/api/employees", "PATCH", { name: "x" })).data.error, "Missing employee id");
    const missing = await call("/api/employees", "PATCH", { id: "nope", name: "x" });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "Employee not found");
    const empty = await call("/api/employees", "PATCH", { id: emp.id });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error, "No fields to update");
  });

  test("POST/PATCH/DELETE /api/services", async () => {
    const created = await call("/api/services", "POST", { name: "Gutter Cleaning", description: "Clear gutters", duration_minutes: 60, default_price_cents: 9500 });
    assert.equal(created.status, 200);
    assert.deepEqual(created.data, { ok: true });
    const row = getSnapshot().services.find((s) => s.name === "Gutter Cleaning")!;
    assert.ok(row);
    assert.equal(row.default_price_cents, 9500);
    assert.equal(row.color, "#3B82F6");

    const patched = await call("/api/services", "PATCH", { id: row.id, active: false, default_price_cents: null });
    assert.equal(patched.status, 200);
    const afterPatch = getSnapshot().services.find((s) => s.id === row.id)!;
    assert.equal(afterPatch.active, false);
    assert.equal(afterPatch.default_price_cents, null);

    const deleted = await call("/api/services", "DELETE", { id: row.id });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.data, { ok: true });
    assert.ok(!getSnapshot().services.some((s) => s.id === row.id));
  });

  test("services writes reject invalid input", async () => {
    assert.equal((await call("/api/services", "POST", { name: "" })).data.error, "Service name is required");
    const badPrice = await call("/api/services", "POST", { name: "X", default_price_cents: -5 });
    assert.equal(badPrice.status, 400);
    assert.equal(badPrice.data.error, "Price must be a valid, non-negative amount.");
    const id = getSnapshot().services[0].id;
    assert.equal((await call("/api/services", "PATCH", { id, default_price_cents: 1.5 })).status, 400);
    assert.equal((await call("/api/services", "PATCH", { id: "nope", name: "x" })).status, 404);
    assert.equal((await call("/api/services", "DELETE", { id: "nope" })).status, 404);
    assert.equal((await call("/api/services", "DELETE", {})).data.error, "Missing service id");
  });

  test("PATCH /api/clients updates fields; rejects unknown id and an empty update", async () => {
    const client = getSnapshot().clients[0];
    const { status, data } = await call("/api/clients", "PATCH", { id: client.id, phone: " (407) 555-9999 ", notes: "  ", auto_email: 1 });
    assert.equal(status, 200);
    assert.deepEqual(data, { ok: true });
    const updated = getSnapshot().clients.find((c) => c.id === client.id)!;
    assert.equal(updated.phone, "(407) 555-9999");
    assert.equal(updated.notes, null);
    assert.equal(updated.auto_email, true);
    assert.equal((await call("/api/clients", "PATCH", { id: "nope", name: "x" })).status, 404);
    const empty = await call("/api/clients", "PATCH", { id: client.id });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error, "Nothing to update");
  });

  test("POST /api/clients archive/restore round-trips through GET /api/clients/archived; stops only ACTIVE series", async () => {
    const snap = getSnapshot();
    const client = snap.clients.find((c) => !c.archived_at)!;
    // Give this client one active and one review_required registry row.
    const base = snap.recurringSeries[0];
    setSnapshot({
      ...snap,
      recurringSeries: [
        ...snap.recurringSeries,
        { ...base, id: "rs-active", client_id: client.id, status: "active" },
        { ...base, id: "rs-review", client_id: client.id, status: "review_required" },
      ],
    });
    const archived = await call("/api/clients", "POST", { id: client.id, action: "archive" });
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.data, { ok: true });
    const a = getSnapshot().clients.find((c) => c.id === client.id)!;
    assert.ok(a.archived_at);
    assert.equal(a.status, "inactive");
    assert.ok((await call("/api/clients/archived")).data.clients.some((c: any) => c.id === client.id));
    const rs = getSnapshot().recurringSeries;
    assert.equal(rs.find((r) => r.id === "rs-active")!.status, "stopped");
    assert.ok(rs.find((r) => r.id === "rs-active")!.stopped_at);
    assert.equal(rs.find((r) => r.id === "rs-review")!.status, "review_required");

    const restored = await call("/api/clients", "POST", { id: client.id, action: "restore" });
    assert.equal(restored.status, 200);
    const r = getSnapshot().clients.find((c) => c.id === client.id)!;
    assert.equal(r.archived_at, null);
    assert.equal(r.status, "active");
  });

  test("POST /api/clients rejects missing id, unknown id, and an invalid action", async () => {
    assert.equal((await call("/api/clients", "POST", { action: "archive" })).data.error, "Missing client id");
    assert.equal((await call("/api/clients", "POST", { id: "nope", action: "archive" })).status, 404);
    const bad = await call("/api/clients", "POST", { id: getSnapshot().clients[0].id, action: "delete" });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, "Invalid action");
  });

  test("POST /api/settings/company: each of CompanyInfoPanel's 4 save shapes, partial update, returns { ok: true }", async () => {
    const profile = await call("/api/settings/company", "POST", {
      company_name: " Sunrise Services ", phone: "(407) 555-1111", email: "hi@example.com", address: "", city: "Orlando", state: "FL", zip: "32801",
    });
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.data, { ok: true });
    let cs = getSnapshot().companySettings;
    assert.equal(cs.company_name, "Sunrise Services");
    assert.equal(cs.address, null);

    const tz = await call("/api/settings/company", "POST", { timezone: "America/Chicago" });
    assert.equal(tz.status, 200);
    const hours = { monday: [{ start: "08:00", end: "16:00" }] };
    const bh = await call("/api/settings/company", "POST", { business_hours: hours });
    assert.equal(bh.status, 200);
    const toggles = await call("/api/settings/company", "POST", { booking_enabled: true, notifications_enabled: true });
    assert.equal(toggles.status, 200);

    cs = getSnapshot().companySettings;
    assert.equal(cs.timezone, "America/Chicago");
    assert.equal(cs.booking_enabled, true);
    assert.equal(cs.notifications_enabled, true);
    assert.equal(cs.company_name, "Sunrise Services", "a later partial save must not wipe earlier fields");
    const got = await call("/api/settings/company");
    assert.deepEqual(got.data.settings.business_hours.monday, [{ start: "08:00", end: "16:00" }]);
    assert.deepEqual(got.data.settings.business_hours.tuesday, []);
  });

  test("POST /api/settings/company rejects an unsupported timezone and malformed business hours", async () => {
    const tz = await call("/api/settings/company", "POST", { timezone: "Mars/Olympus" });
    assert.equal(tz.status, 400);
    assert.equal(tz.data.error, "Please choose a supported time zone.");
    const bh = await call("/api/settings/company", "POST", { business_hours: { funday: [] } });
    assert.equal(bh.status, 400);
    assert.equal(getSnapshot().companySettings.timezone, DEMO_TIMEZONE);
  });

  test("no /api/book/* route exists, even with booking_enabled on", async () => {
    await call("/api/settings/company", "POST", { booking_enabled: true });
    const errorSpy = mock.method(console, "error", () => {});
    try {
      const { status } = await call(`/api/book/availability?date=${today}`);
      assert.equal(status, 404);
      assert.equal(originalFetch.mock.callCount(), 0);
    } finally {
      errorSpy.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------
// Stage 2: owner worked-time correction.
// ---------------------------------------------------------------------
describe("installDemoFetchInterceptor -- POST /api/appointments/employee-hours", () => {
  test("saves a correction for an assigned employee ({ ok, entry }) and upserts on a second save", async () => {
    const ids = await needsAttentionIdsByKind();
    const apptId = ids.worked_time_review;
    const employeeId = getSnapshot().assignments.find((a) => a.appointment_id === apptId)!.employee_id;
    const before = getSnapshot().employeeHours.length;

    const first = await call("/api/appointments/employee-hours", "POST", { appointment_id: apptId, employee_id: employeeId, hours_worked: 2.5, note: " Forgot to clock out " });
    assert.equal(first.status, 200);
    assert.equal(first.data.ok, true);
    assert.deepEqual(Object.keys(first.data.entry).sort(), ["appointment_id", "created_at", "employee_id", "hours_worked", "id", "note", "updated_at"]);
    assert.equal(first.data.entry.hours_worked, 2.5);
    assert.equal(first.data.entry.note, "Forgot to clock out");
    assert.equal(getSnapshot().employeeHours.length, before + 1);

    const second = await call("/api/appointments/employee-hours", "POST", { appointment_id: apptId, employee_id: employeeId, hours_worked: 3, note: "Confirmed with client" });
    assert.equal(second.status, 200);
    assert.equal(second.data.entry.id, first.data.entry.id);
    assert.equal(getSnapshot().employeeHours.length, before + 1);
    assert.equal(getSnapshot().employeeHours.find((h) => h.id === first.data.entry.id)!.hours_worked, 3);
  });

  test("validation: missing ids, non-positive hours, blank note, >= 1000 hours", async () => {
    const a = getSnapshot().assignments[0];
    const post = (body: unknown) => call("/api/appointments/employee-hours", "POST", body);
    assert.equal((await post({ employee_id: a.employee_id, hours_worked: 1, note: "x" })).data.error, "Missing appointment_id");
    assert.equal((await post({ appointment_id: a.appointment_id, hours_worked: 1, note: "x" })).data.error, "Missing employee_id");
    const zero = await post({ appointment_id: a.appointment_id, employee_id: a.employee_id, hours_worked: 0, note: "x" });
    assert.equal(zero.status, 400);
    assert.equal(zero.data.error, "Hours worked must be a positive number");
    const noNote = await post({ appointment_id: a.appointment_id, employee_id: a.employee_id, hours_worked: 1, note: "   " });
    assert.equal(noNote.status, 400);
    assert.equal(noNote.data.error, "A reason is required (e.g. forgot to clock in/out).");
    assert.equal((await post({ appointment_id: a.appointment_id, employee_id: a.employee_id, hours_worked: 1000, note: "x" })).status, 400);
  });

  test("not_assigned (404) for an unassigned employee or unknown appointment", async () => {
    const snap = getSnapshot();
    const appt = snap.appointments.find((x) => snap.assignments.some((a) => a.appointment_id === x.id))!;
    const assigned = new Set(snap.assignments.filter((a) => a.appointment_id === appt.id).map((a) => a.employee_id));
    const other = snap.employees.find((e) => !assigned.has(e.id))!;
    const r = await call("/api/appointments/employee-hours", "POST", { appointment_id: appt.id, employee_id: other.id, hours_worked: 1, note: "x" });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "Employee is not assigned to this appointment.");
    const r2 = await call("/api/appointments/employee-hours", "POST", { appointment_id: "nope", employee_id: other.id, hours_worked: 1, note: "x" });
    assert.equal(r2.status, 404);
  });

  test("appointment_not_active (409, APPOINTMENT_NOT_ACTIVE) for a new entry on a cancelled appointment", async () => {
    const snap = getSnapshot();
    const cancelled = snap.appointments.find((x) => x.status === "cancelled" && snap.assignments.some((a) => a.appointment_id === x.id))!;
    const employeeId = snap.assignments.find((a) => a.appointment_id === cancelled.id)!.employee_id;
    const r = await call("/api/appointments/employee-hours", "POST", { appointment_id: cancelled.id, employee_id: employeeId, hours_worked: 1, note: "x" });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "APPOINTMENT_NOT_ACTIVE");
    assert.equal(r.data.error, "This appointment was cancelled or replaced and hours can no longer be added to it.");
  });
});

// ---------------------------------------------------------------------
// Stage 2: recurring-series review queue + activation.
// ---------------------------------------------------------------------
describe("installDemoFetchInterceptor -- recurring series", () => {
  async function reviewRow() {
    const { data } = await call("/api/recurring-series");
    return data.series[0];
  }

  test("GET /api/recurring-series returns exactly one review_required row in the real route's shape", async () => {
    const { status, data } = await call("/api/recurring-series");
    assert.equal(status, 200);
    assert.equal(data.series.length, 1);
    const s = data.series[0];
    assert.deepEqual(Object.keys(s).sort(), [
      "anchorLocalDate", "anchorLocalTime", "anchorTimezone", "candidates", "clientId", "clientInactiveOrArchived", "clientName",
      "createdAt", "expiresWithin30Days", "frequencyType", "hasLiveOccurrences", "id", "isDemo", "repeatMonths", "repeatWeeks",
    ]);
    const registry = getSnapshot().recurringSeries[0];
    assert.equal(s.id, registry.id);
    // false: the seeded row is deliberately not is_demo, so the activate
    // workflow is genuinely demonstrable (the real route refuses any
    // is_demo row outright) -- see generate.ts's own comment on this field.
    assert.equal(s.isDemo, false);
    assert.equal(s.clientName, "Melissa Carter");
    assert.equal(s.clientInactiveOrArchived, false);
    assert.equal(s.frequencyType, "weekly");
    assert.equal(s.repeatWeeks, 2);
    assert.equal(s.hasLiveOccurrences, true);
    // candidates: exactly the series' scheduled, strictly-future appointments, ascending.
    const nowIso = NOW.toISOString();
    const expected = getSnapshot().appointments.filter((a) => a.series_id === s.id && a.status === "scheduled" && a.scheduled_for > nowIso);
    assert.ok(expected.length > 0);
    assert.deepEqual(s.candidates.map((c: any) => c.id), expected.map((a) => a.id));
    assert.deepEqual(Object.keys(s.candidates[0]).sort(), ["durationMinutes", "id", "priceCents", "scheduledFor", "serviceType"]);
    const latest = new Date(s.candidates[s.candidates.length - 1].scheduledFor).getTime();
    assert.equal(s.expiresWithin30Days, latest - NOW.getTime() <= 30 * 86_400_000);
  });

  test("activate: a row with is_demo true is refused exactly like the real route (400) -- the real safeguard is reproduced faithfully even though the fixture itself no longer seeds is_demo true by default", async () => {
    const snap = getSnapshot();
    setSnapshot({ ...snap, recurringSeries: snap.recurringSeries.map((r) => ({ ...r, is_demo: true })) });
    const s = await reviewRow();
    const r = await call("/api/recurring-series/activate", "POST", { series_id: s.id, template_appointment_id: s.candidates[0].id });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "Demo series cannot be activated.");
    assert.equal(getSnapshot().recurringSeries[0].status, "review_required");
  });

  test("activate succeeds on the seeded series (is_demo: false by default, so the Stage 2 'changes' workflow is genuinely demonstrable): { ok, timePattern }, row becomes active, leaves the review queue", async () => {
    const s = await reviewRow();
    const template = s.candidates[s.candidates.length - 1];
    const r = await call("/api/recurring-series/activate", "POST", { series_id: s.id, template_appointment_id: template.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data, { ok: true, timePattern: "consistent" });
    const row = getSnapshot().recurringSeries.find((x) => x.id === s.id)!;
    assert.equal(row.status, "active");
    assert.equal(row.template_appointment_id, template.id);
    assert.ok(row.reviewed_at);
    assert.equal(row.anchor_local_date, zonedDateValue(template.scheduledFor, TZ));
    assert.deepEqual((await call("/api/recurring-series")).data, { series: [] });
    // Already active -> 409.
    const again = await call("/api/recurring-series/activate", "POST", { series_id: s.id, template_appointment_id: template.id });
    assert.equal(again.status, 409);
  });

  test("activate failures: missing fields, unknown series, template not in series, inconsistent occurrences", async () => {
    const s = await reviewRow();
    const post = (body: unknown) => call("/api/recurring-series/activate", "POST", body);

    assert.equal((await post({ series_id: s.id })).status, 400);
    assert.equal((await post({ series_id: "nope", template_appointment_id: "x" })).status, 404);

    const foreign = getSnapshot().appointments.find((a) => a.series_id !== s.id)!;
    const notIn = await post({ series_id: s.id, template_appointment_id: foreign.id });
    assert.equal(notIn.status, 400);
    assert.deepEqual(notIn.data.blockers, ["template_not_in_series"]);

    // One live occurrence with a different price -> real blocker, 409.
    const victim = s.candidates[0].id;
    const cur = getSnapshot();
    setSnapshot({ ...cur, appointments: cur.appointments.map((a) => (a.id === victim ? { ...a, price_cents: (a.price_cents ?? 0) + 500 } : a)) });
    const mismatch = await post({ series_id: s.id, template_appointment_id: s.candidates[s.candidates.length - 1].id });
    assert.equal(mismatch.status, 409);
    assert.deepEqual(mismatch.data.blockers, ["price_mismatch"]);
    assert.equal(getSnapshot().recurringSeries[0].status, "review_required");
  });

  test("activate refuses an inactive/archived client (409)", async () => {
    const snap = getSnapshot();
    const clientId = snap.recurringSeries[0].client_id;
    setSnapshot({
      ...snap,
      clients: snap.clients.map((c) => (c.id === clientId ? { ...c, status: "inactive" } : c)),
    });
    const s = await reviewRow();
    assert.equal(s.clientInactiveOrArchived, true);
    const r = await call("/api/recurring-series/activate", "POST", { series_id: s.id, template_appointment_id: s.candidates[0].id });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "This series' client is inactive or archived and cannot be activated.");
  });

  test("evaluateSeriesConsistencyLocal matches the REAL lib/recurringSeries evaluateSeriesConsistency", async () => {
    // lib/recurringSeries.ts creates the Supabase admin client at import
    // time; dummy values let it load (no request is ever made).
    process.env.SUPABASE_URL ??= "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
    const real = await import("@/lib/recurringSeries");
    const snap = getSnapshot();
    const seriesIds = Array.from(new Set(snap.appointments.map((a) => a.series_id).filter(Boolean))) as string[];
    let cases = 0;
    for (const sid of seriesIds) {
      const occ = snap.appointments
        .filter((a) => a.series_id === sid && a.status === "scheduled")
        .map((a) => ({
          id: a.id, scheduledFor: a.scheduled_for, serviceType: a.service_type, priceCents: a.price_cents ?? null,
          durationMinutes: a.duration_minutes ?? null, teamColor: a.team_color ?? null,
          employeeIds: snap.assignments.filter((x) => x.appointment_id === a.id).map((x) => x.employee_id),
        }));
      const first = snap.appointments.find((a) => a.series_id === sid)!;
      const freq = first.frequency_type as any;
      const months = first.repeat_months ?? null;
      const shifted = occ.map((o, i) =>
        i === 0 ? { ...o, priceCents: 1, scheduledFor: new Date(new Date(o.scheduledFor).getTime() + 86_400_000).toISOString() } : o
      );
      for (const v of [occ, shifted, []]) {
        for (const tid of [occ[occ.length - 1]?.id ?? "x", "missing"]) {
          for (const f of [freq, "weekdays", "daily", "monthly"]) {
            assert.deepEqual(evaluateSeriesConsistencyLocal(v, tid, f, TZ, months), real.evaluateSeriesConsistency(v, tid, f, TZ, months));
            cases++;
          }
        }
      }
    }
    assert.ok(cases > 50);
  });
});

// ---------------------------------------------------------------------
// Stage 2: Message History now surfaces the 5 simulated fixture messages.
// ---------------------------------------------------------------------
describe("installDemoFetchInterceptor -- Message History", () => {
  function expectedRow(m: ReturnType<typeof getSnapshot>["messagesSent"][number]) {
    const kindLabel = describeMessageKind(m.kind);
    return {
      id: m.id,
      channel: m.channel,
      kindLabel: m.subject ? kindLabel : `[Simulated] ${kindLabel}`,
      toValue: m.to_value,
      body: m.body,
      subject: m.subject ? `[Simulated] ${m.subject}` : null,
      status: classifyMessageStatus(m.provider_id, m.channel),
      createdAt: m.created_at,
      scheduledFor: m.scheduled_for ?? null,
    };
  }
  const newestFirst = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
    b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);

  test("GET /api/appointments/messages returns each appointment's own simulated messages in the real shape", async () => {
    const msgs = getSnapshot().messagesSent;
    assert.equal(msgs.length, 5);
    let total = 0;
    for (const apptId of new Set(msgs.map((m) => m.appointment_id as string))) {
      const { status, data } = await call(`/api/appointments/messages?appointment_id=${apptId}`);
      assert.equal(status, 200);
      assert.equal(data.ok, true);
      assert.equal(data.hasMore, false);
      const expected = msgs.filter((m) => m.appointment_id === apptId).sort(newestFirst).map(expectedRow);
      assert.deepEqual(data.messages, expected);
      total += data.messages.length;
    }
    assert.equal(total, 5);
    // The real classifier decides status: exactly one failed.
    assert.equal(msgs.filter((m) => classifyMessageStatus(m.provider_id, m.channel).code === "failed").length, 1);
  });

  test("every simulated message is visibly labeled, SMS (no subject) via its kind label", async () => {
    const msgs = getSnapshot().messagesSent;
    const sms = msgs.find((m) => m.channel === "sms")!;
    const row = (await call(`/api/appointments/messages?appointment_id=${sms.appointment_id}`)).data.messages.find((r: any) => r.id === sms.id);
    assert.equal(row.subject, null);
    assert.ok(row.kindLabel.startsWith("[Simulated] "));
    const email = msgs.find((m) => m.channel === "email")!;
    const e = (await call(`/api/appointments/messages?appointment_id=${email.appointment_id}`)).data.messages.find((r: any) => r.id === email.id);
    assert.ok(e.subject.startsWith("[Simulated] "));
    assert.ok(!e.kindLabel.startsWith("[Simulated]"));
  });

  test("GET /api/clients/messages joins through the client's appointments and adds appointmentId", async () => {
    const snap = getSnapshot();
    let total = 0;
    for (const client of snap.clients) {
      const { status, data } = await call(`/api/clients/messages?client_id=${client.id}`);
      assert.equal(status, 200);
      const apptIds = new Set(snap.appointments.filter((a) => a.client_id === client.id).map((a) => a.id));
      const expected = snap.messagesSent
        .filter((m) => apptIds.has(m.appointment_id as string))
        .sort(newestFirst)
        .map((m) => ({ appointmentId: m.appointment_id, ...expectedRow(m) }));
      assert.deepEqual(data.messages, expected);
      total += data.messages.length;
    }
    assert.equal(total, 5);
  });

  test("messages: 400 on missing id, 404 on unknown id, and limit/offset paging", async () => {
    assert.equal((await call("/api/appointments/messages")).status, 400);
    assert.equal((await call("/api/clients/messages")).status, 400);
    assert.equal((await call("/api/appointments/messages?appointment_id=nope")).status, 404);
    assert.equal((await call("/api/clients/messages?client_id=nope")).status, 404);

    const snap = getSnapshot();
    const m = snap.messagesSent[0];
    const clientId = snap.appointments.find((a) => a.id === m.appointment_id)!.client_id;
    // A second message on the same appointment so paging has something to page.
    setSnapshot({ ...snap, messagesSent: [...snap.messagesSent, { ...m, id: m.id.replace(/.$/, "f"), created_at: new Date(NOW.getTime() - 1000).toISOString() }] });
    const p1 = await call(`/api/clients/messages?client_id=${clientId}&limit=1`);
    assert.equal(p1.data.messages.length, 1);
    assert.equal(p1.data.hasMore, true);
    const p2 = await call(`/api/clients/messages?client_id=${clientId}&limit=1&offset=1`);
    assert.equal(p2.data.messages.length, 1);
    assert.notEqual(p2.data.messages[0].id, p1.data.messages[0].id);
  });
});

// ---------------------------------------------------------------------
// Stage 2: store.clearDemoSession (demo Sign Out).
// ---------------------------------------------------------------------
function installFakeSessionStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
  };
  return backing;
}

describe("clearDemoSession", () => {
  test("removes the saved session and the in-memory snapshot without regenerating; next access starts fresh", () => {
    const backing = installFakeSessionStorage();
    try {
      setSnapshot(generateDemoFixture(NOW));
      const before = getSnapshot();
      assert.ok(backing.has(DEMO_STORAGE_KEY));

      clearDemoSession();
      assert.equal(backing.has(DEMO_STORAGE_KEY), false, "storage key removed");
      assert.equal(backing.size, 0, "clearDemoSession itself generated/persisted nothing");

      mock.timers.setTime(NOW.getTime() + 60_000);
      const after = getSnapshot();
      assert.notEqual(after, before);
      assert.notEqual(after.sessionInitIso, before.sessionInitIso);
      assert.equal(after.sessionInitIso, new Date(NOW.getTime() + 60_000).toISOString());
      assert.ok(backing.has(DEMO_STORAGE_KEY), "the fresh session persists on first access");
    } finally {
      mock.timers.setTime(NOW.getTime());
      delete (globalThis as any).sessionStorage;
    }
  });

  test("a saved blob from before recurringSeries existed is rejected and regenerated", () => {
    const backing = installFakeSessionStorage();
    try {
      const old: any = generateDemoFixture(NOW);
      delete old.recurringSeries;
      old.sessionInitIso = "2000-01-01T00:00:00.000Z";
      clearDemoSession();
      backing.set(DEMO_STORAGE_KEY, JSON.stringify(old));
      const snap = getSnapshot();
      assert.notEqual(snap.sessionInitIso, "2000-01-01T00:00:00.000Z");
      assert.equal(snap.recurringSeries.length, 1);
    } finally {
      delete (globalThis as any).sessionStorage;
    }
  });
});

// ---------------------------------------------------------------------
// Lifecycle: self-uninstall once the visitor has left /demo. MUST stay the
// last block in this file -- it swaps window.fetch.
// ---------------------------------------------------------------------
describe("installDemoFetchInterceptor -- self-uninstall off /demo", () => {
  test("a call made after leaving /demo is NOT intercepted, restores the original fetch, and allows a real reinstall on return", async () => {
    const w = (globalThis as any).window;
    assert.equal(w.fetch, demoFetch);

    // Still on /demo: intercepted.
    assert.equal((await call("/api/employees")).status, 200);
    assert.equal(originalFetch.mock.callCount(), 0);

    // Client-side navigation away (no reload), then a real login attempt.
    w.location.pathname = "/login";
    const res = await demoFetch("/api/auth/login", { method: "POST", body: "{}" });
    assert.equal(await res.text(), "passthrough");
    assert.equal(originalFetch.mock.callCount(), 1);
    assert.equal(w.fetch, originalFetch, "real fetch restored");
    assert.equal(w.__demoFetchInstalled, false, "install flag cleared");

    // Every later call goes straight to the real fetch.
    await w.fetch("/api/employees");
    assert.equal(originalFetch.mock.callCount(), 2);

    // Back to /demo in the same tab: a genuine reinstall, not a stale no-op.
    w.location.pathname = "/demo";
    installDemoFetchInterceptor();
    assert.notEqual(w.fetch, originalFetch);
    const back = await w.fetch("/api/employees");
    assert.equal(back.status, 200);
    assert.ok(Array.isArray(await back.json()));
    assert.equal(originalFetch.mock.callCount(), 2);

    // "/demonstration" is not /demo.
    w.location.pathname = "/demonstration";
    assert.equal(await (await w.fetch("/api/employees")).text(), "passthrough");
    assert.equal(w.fetch, originalFetch);
  });
});
