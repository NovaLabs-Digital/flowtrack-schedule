// Direct, isolated unit tests for lib/notify.ts's sendEmail -- specifically
// proving the exact evidence requested: the literal "resend" fallback
// provider_id is written ONLY on a confirmed-success Resend response, NEVER
// after an error or an ambiguous (neither data nor error) result.
//
// Before this file existed, sendEmail's own branching logic (the part that
// decides what provider_id value gets recorded) had ZERO test coverage
// anywhere in this codebase -- lib/notify.test.ts only covers
// sanitizeCompanyName/getCompanyName/getCompanyIdentity (see that file's own
// header comment), and lib/testSupport.ts's createFakeNotify exists
// precisely because the real sendEmail could not otherwise be reached in a
// route test (it constructs a real Resend client against a real API key at
// call time). This file closes that gap by mocking the "resend" package
// itself (the same mock.module seam already used for "@/lib/supabaseAdmin"
// elsewhere), so the REAL sendEmail runs, with only the network call faked.
//
// Dummy Supabase/Twilio/Resend env vars are set before the module under test
// is dynamically imported, matching lib/notify.test.ts's and
// lib/entitlementServer.test.ts's exact convention. No real Supabase/
// Twilio/Resend/network call is reachable from this file.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.TWILIO_ACCOUNT_SID = "ACtestaccountsidtestaccountsidtest";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-auth-token";
process.env.TWILIO_FROM_NUMBER = "+15555550100";
process.env.RESEND_API_KEY = "test-resend-api-key";
process.env.RESEND_FROM_EMAIL = "notifications@example.com";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({ company_settings: [{ data: { notifications_enabled: true } }] });
let sendImpl: (payload: unknown, opts: unknown) => Promise<{ data: unknown; error: unknown }> =
  async () => ({ data: { id: "unset-fixture" }, error: null });

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

// The real lib/notify.ts: `import { Resend } from "resend"; ... new
// Resend(process.env.RESEND_API_KEY!)`, then `.emails.send(payload, opts)`.
// Faking the package itself (rather than trying to intercept a network
// call) means the REAL sendEmail body -- including its error/ambiguous-
// result handling -- runs unmodified.
class FakeResend {
  emails = { send: (payload: unknown, opts: unknown) => sendImpl(payload, opts) };
}
mock.module("resend", { namedExports: { Resend: FakeResend } });

const { sendEmail } = await import("./notify.ts");

function resetCompanySettings(notificationsEnabled = true) {
  currentFake = createFakeSupabaseAdmin({ company_settings: [{ data: { notifications_enabled: notificationsEnabled } }] });
}

describe("sendEmail -- the 'resend' fallback is written ONLY on confirmed success", () => {
  test("a real Resend id in `data` is returned verbatim -- the common success case", async () => {
    resetCompanySettings();
    sendImpl = async () => ({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null });
    const result = await sendEmail("client@example.com", "Subject", "Body", "ws-1");
    assert.equal(result, "4ef9a417-02e9-4d39-ad75-9611e0fcc33c");
  });

  test("confirmed success (error: null) with a data object that has no .id still falls back to 'resend' -- this IS genuine acceptance evidence", async () => {
    resetCompanySettings();
    sendImpl = async () => ({ data: {}, error: null });
    const result = await sendEmail("client@example.com", "Subject", "Body", "ws-1");
    assert.equal(result, "resend");
  });

  test("an error response (error truthy) THROWS -- it never reaches, and never returns, the 'resend' fallback", async () => {
    resetCompanySettings();
    sendImpl = async () => ({ data: null, error: { message: "Invalid `to` field" } });
    await assert.rejects(
      () => sendEmail("not-an-email", "Subject", "Body", "ws-1"),
      /Invalid `to` field/
    );
  });

  test("an ambiguous result (data: null AND error: null -- violates Resend's own documented contract) does NOT return 'resend' or any value classifyMessageStatus would treat as sent", async () => {
    resetCompanySettings();
    sendImpl = async () => ({ data: null, error: null });
    const result = await sendEmail("client@example.com", "Subject", "Body", "ws-1");
    assert.notEqual(result, "resend", "an ambiguous result must never be mistaken for the genuine success fallback");
    const { classifyMessageStatus } = await import("./messageStatus.ts");
    assert.deepEqual(classifyMessageStatus(result, "email"), { code: "unknown", label: "Unknown" }, "an ambiguous send result must classify as Unknown, never Sent");
  });

  test("the underlying provider call rejecting outright (a thrown/rejected promise, not a { data, error } response) propagates -- the caller's try/catch records it as failed, never as 'resend'", async () => {
    resetCompanySettings();
    sendImpl = async () => { throw new Error("network timeout"); };
    await assert.rejects(() => sendEmail("client@example.com", "Subject", "Body", "ws-1"), /network timeout/);
  });

  test("notifications-off (the owner's own Settings toggle) returns its skip sentinel without ever calling the provider", async () => {
    resetCompanySettings(false);
    let called = false;
    sendImpl = async () => { called = true; return { data: { id: "should-not-be-reached" }, error: null }; };
    const result = await sendEmail("client@example.com", "Subject", "Body", "ws-1");
    assert.equal(result, "notifications-off");
    assert.equal(called, false, "the provider must never be called once notifications are off for this workspace");
  });
});
