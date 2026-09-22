// Executed tests (mocked providers) for lib/notifyAppointmentChange.ts: what is
// sent, to whom, and what is recorded. The DELIVERY guarantee is deliberately
// NOT tested as a guarantee because there is none: the send is a direct,
// unretried provider call made after the commit, with no outbox. If the
// process dies between the commit and the send, the notification is lost;
// that limitation is documented in the module and in the route.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let capabilityAllowed = true;
const sent: { kind: "email" | "sms"; to: string }[] = [];
const recorded: Record<string, unknown>[] = [];
let failEmail = false;
let failSms = false;

mock.module("@/lib/supabaseAdmin", { namedExports: { supabaseAdmin: { from: (t: string) => currentFake.supabaseAdmin.from(t) } } });
mock.module("@/lib/entitlementServer", {
  namedExports: { requireCapabilityForWorkspace: async () => (capabilityAllowed ? { allowed: true } : { allowed: false }) },
});
mock.module("@/lib/notify", {
  namedExports: {
    sendEmail: async (to: string) => { if (failEmail) throw new Error("smtp down"); sent.push({ kind: "email", to }); return "email-id"; },
    sendSms: async (to: string) => { if (failSms) throw new Error("sms down"); sent.push({ kind: "sms", to }); return "sms-id"; },
    shouldSend: (channel: string, kind: string) => channel === "both" || channel === kind,
    describeProviderError: (e: unknown) => String(e),
    recordMessageSent: async (row: Record<string, unknown>) => { recorded.push(row); },
    getCompanyIdentity: async () => ({ companyName: "Acme Cleaning", timezone: "America/New_York" }),
  },
});

const { sendAppointmentChangeNotification } = await import("./notifyAppointmentChange.ts");

const CLIENT = { name: "Izabel", email: "iz@example.com", phone: "+15551234567", auto_email: true, auto_sms: true };
function setup(over: { client?: Record<string, unknown>; apptError?: boolean; clientError?: boolean; capability?: boolean } = {}) {
  const responses: Record<string, FakeSupabaseFixture[]> = {
    appointments: [over.apptError ? { error: { message: "x" } } : { data: { service_type: "Regular Cleaning", scheduled_for: "2026-09-22T13:00:00.000Z" } }],
    clients: [over.clientError ? { error: { message: "x" } } : { data: { ...CLIENT, ...over.client } }],
  };
  currentFake = createFakeSupabaseAdmin(responses);
  capabilityAllowed = over.capability ?? true;
  sent.length = 0; recorded.length = 0; failEmail = false; failSms = false;
}
const run = (channel: "email" | "sms" | "both" | "none") =>
  sendAppointmentChangeNotification({ workspaceId: "ws-1", appointmentId: "appt-1", clientId: "client-1", channel });

describe("sendAppointmentChangeNotification", () => {
  test("channel none does nothing at all -- not even a database read", async () => {
    setup();
    await run("none");
    assert.equal(currentFake.calls.length, 0);
    assert.equal(sent.length, 0);
  });

  test("a workspace whose plan cannot send notifications reads and sends nothing", async () => {
    setup({ capability: false });
    await run("both");
    assert.equal(currentFake.calls.length, 0);
    assert.equal(sent.length, 0);
  });

  test("both: one email and one SMS, each recorded once with the provider id and the appointment", async () => {
    setup();
    await run("both");
    assert.deepEqual(sent, [{ kind: "email", to: "iz@example.com" }, { kind: "sms", to: "+15551234567" }]);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every((r) => r.appointment_id === "appt-1" && r.workspace_id === "ws-1" && r.kind === "update"));
    assert.deepEqual(recorded.map((r) => r.provider_id), ["email-id", "sms-id"]);
  });

  test("only the chosen channel is used, and a client who has not opted in is never contacted on that channel", async () => {
    setup();
    await run("email");
    assert.deepEqual(sent.map((s) => s.kind), ["email"]);
    setup({ client: { auto_email: false } });
    await run("both");
    assert.deepEqual(sent.map((s) => s.kind), ["sms"]);
    setup({ client: { email: null, phone: null } });
    await run("both");
    assert.deepEqual(sent, []);
  });

  test("a provider failure is recorded as failed and never stops the other channel", async () => {
    setup();
    failEmail = true;
    await run("both");
    assert.deepEqual(sent.map((s) => s.kind), ["sms"]);
    assert.deepEqual(recorded.map((r) => [r.channel, r.provider_id]), [["email", "failed"], ["sms", "sms-id"]]);
  });

  test("if the appointment or client cannot be read, nothing is sent", async () => {
    setup({ apptError: true });
    await run("both");
    assert.equal(sent.length, 0);
    setup({ clientError: true });
    await run("both");
    assert.equal(sent.length, 0);
  });
});
