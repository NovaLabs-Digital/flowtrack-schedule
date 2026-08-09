// Direct, isolated unit tests for lib/notify.ts's sanitizeCompanyName and
// getCompanyName -- the two pieces added so client-facing notifications can
// identify the actual business, not just generic "ScheduleFlowTrack"
// branding. Dummy Supabase/Twilio env vars are set before the module under
// test is dynamically imported (static imports are hoisted ahead of any
// top-level assignment), matching lib/entitlementServer.test.ts's exact
// convention -- the real lib/notify.ts constructs a Twilio client at
// module-load time, which would otherwise throw without real credentials.
// No real Supabase/Twilio/Resend/network call is reachable from this file.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.TWILIO_ACCOUNT_SID = "ACtestaccountsidtestaccountsidtest";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-auth-token";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

const { sanitizeCompanyName, getCompanyName, getCompanyIdentity } = await import("./notify.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

describe("sanitizeCompanyName -- pure sanitization and fallback, no I/O", () => {
  test("trims surrounding whitespace", () => {
    assert.equal(sanitizeCompanyName("  Acme Cleaning  "), "Acme Cleaning");
  });

  test("falls back to ScheduleFlowTrack for null, undefined, empty, or whitespace-only", () => {
    assert.equal(sanitizeCompanyName(null), "ScheduleFlowTrack");
    assert.equal(sanitizeCompanyName(undefined), "ScheduleFlowTrack");
    assert.equal(sanitizeCompanyName(""), "ScheduleFlowTrack");
    assert.equal(sanitizeCompanyName("   "), "ScheduleFlowTrack");
  });

  test("strips CR/LF -- prevents email header injection via a malformed company name", () => {
    assert.equal(sanitizeCompanyName("Acme\r\nBcc: attacker@evil.com"), "AcmeBcc: attacker@evil.com");
    assert.ok(!sanitizeCompanyName("Acme\r\nX-Injected: true").includes("\n"));
  });

  test("strips other control characters (null bytes, DEL, etc.)", () => {
    assert.equal(sanitizeCompanyName("Acme\x00\x1F\x7FCleaning"), "AcmeCleaning");
  });

  test("strips angle brackets -- prevents forging a second address inside the \"Name <addr>\" From header", () => {
    assert.equal(sanitizeCompanyName("Acme <attacker@evil.com>"), "Acme attacker@evil.com");
  });

  test("caps length at 150 characters", () => {
    const long = "A".repeat(300);
    assert.equal(sanitizeCompanyName(long).length, 150);
  });

  test("a legitimate business name with normal punctuation passes through unchanged", () => {
    assert.equal(sanitizeCompanyName("Journey Cleaning & Restoration, LLC"), "Journey Cleaning & Restoration, LLC");
  });

  test("malformed text that becomes empty after sanitization still falls back safely", () => {
    assert.equal(sanitizeCompanyName("<>"), "ScheduleFlowTrack");
    assert.equal(sanitizeCompanyName("\r\n\x00"), "ScheduleFlowTrack");
  });
});

describe("getCompanyName -- workspace-scoped lookup", () => {
  test("returns the sanitized company_name for the queried workspace", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Acme Cleaning" } }] });
    assert.equal(await getCompanyName("workspace-a"), "Acme Cleaning");
  });

  test("the query is scoped by .eq(\"workspace_id\", workspaceId), never an unfiltered select", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Acme" } }] });
    await getCompanyName("workspace-check");
    const eqCall = currentFake.calls.find((c) => c.table === "company_settings" && c.method === "eq");
    assert.ok(eqCall, "expected a scoped .eq(...) call against company_settings");
    assert.deepEqual(eqCall!.args, ["workspace_id", "workspace-check"]);
  });

  test("Company A's lookup can never return Company B's name -- each call is independently scoped and fetched fresh", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Company A" } }] });
    const nameA = await getCompanyName("workspace-a");
    assert.equal(nameA, "Company A");

    resetFixtures({ company_settings: [{ data: { company_name: "Company B" } }] });
    const nameB = await getCompanyName("workspace-b");
    assert.equal(nameB, "Company B");

    assert.notEqual(nameA, nameB);
  });

  test("falls back to ScheduleFlowTrack when company_settings has no row for this workspace (maybeSingle -> null)", async () => {
    resetFixtures({ company_settings: [{ data: null }] });
    assert.equal(await getCompanyName("workspace-none"), "ScheduleFlowTrack");
  });

  test("falls back to ScheduleFlowTrack when company_name is null on an existing row", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: null } }] });
    assert.equal(await getCompanyName("workspace-x"), "ScheduleFlowTrack");
  });

  test("falls back to ScheduleFlowTrack when company_name is blank/whitespace-only", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "   " } }] });
    assert.equal(await getCompanyName("workspace-y"), "ScheduleFlowTrack");
  });
});

describe("getCompanyIdentity -- combined workspace-scoped company_name + booking_enabled lookup", () => {
  test("booking_enabled: true is read through unchanged", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: true } }] });
    const identity = await getCompanyIdentity("workspace-a");
    assert.equal(identity.companyName, "Acme Cleaning");
    assert.equal(identity.bookingEnabled, true);
  });

  test("booking_enabled: false is read through unchanged", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: false } }] });
    const identity = await getCompanyIdentity("workspace-a");
    assert.equal(identity.bookingEnabled, false);
  });

  test("booking_enabled: null fails closed to false", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: null } }] });
    const identity = await getCompanyIdentity("workspace-a");
    assert.equal(identity.bookingEnabled, false);
  });

  test("no company_settings row at all fails closed to false (never assume booking is enabled)", async () => {
    resetFixtures({ company_settings: [{ data: null }] });
    const identity = await getCompanyIdentity("workspace-none");
    assert.equal(identity.bookingEnabled, false);
    assert.equal(identity.companyName, "ScheduleFlowTrack");
  });

  test("the query is scoped by .eq(\"workspace_id\", workspaceId), never an unfiltered select", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Acme", booking_enabled: true } }] });
    await getCompanyIdentity("workspace-check");
    const eqCall = currentFake.calls.find((c) => c.table === "company_settings" && c.method === "eq");
    assert.ok(eqCall);
    assert.deepEqual(eqCall!.args, ["workspace_id", "workspace-check"]);
  });

  test("Workspace A booking enabled / Workspace B booking disabled -- each call reflects only its own workspace, never the other's", async () => {
    resetFixtures({ company_settings: [{ data: { company_name: "Workspace A Co.", booking_enabled: true } }] });
    const a = await getCompanyIdentity("workspace-a");
    assert.equal(a.bookingEnabled, true);
    assert.equal(a.companyName, "Workspace A Co.");

    resetFixtures({ company_settings: [{ data: { company_name: "Workspace B Co.", booking_enabled: false } }] });
    const b = await getCompanyIdentity("workspace-b");
    assert.equal(b.bookingEnabled, false);
    assert.equal(b.companyName, "Workspace B Co.");

    assert.notEqual(a.bookingEnabled, b.bookingEnabled);
    assert.notEqual(a.companyName, b.companyName);
  });
});
