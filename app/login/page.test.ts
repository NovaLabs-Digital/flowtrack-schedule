// Phase 5.6D: source-level proof that the login page links to the new legal
// pages, and that this phase did not add a consent checkbox or otherwise
// change login submission behavior (explicitly out of scope for 5.6D).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/login/page.tsx -- Phase 5.6D legal links", () => {
  test("links to /terms", () => {
    assert.ok(source.includes('href="/terms"'));
  });

  test("links to /privacy", () => {
    assert.ok(source.includes('href="/privacy"'));
  });

  test("does not add a consent checkbox or otherwise alter the login submit handler", () => {
    assert.ok(!source.includes('type="checkbox"'));
    assert.ok(!source.includes("I agree"));
    // handleSubmit's own required-fields guard is unchanged from before this phase.
    assert.ok(source.includes("Please enter your email and password."));
  });
});

describe("app/login/page.tsx -- Phase 5.7D signup link and MFA hand-off", () => {
  test('links to /signup with the exact approved "Create an account" copy', () => {
    assert.ok(source.includes('href="/signup"'));
    assert.ok(source.includes("New to ScheduleFlowTrack?"));
    assert.ok(source.includes("Create an account"));
  });

  test("a correct owner password response (data.next) redirects to /mfa/enroll or /mfa/challenge instead of /dashboard, before the old unconditional redirect", () => {
    const enrollIdx = source.indexOf('data.next === "enroll"');
    const challengeIdx = source.indexOf('data.next === "challenge"');
    const oldRedirectIdx = source.indexOf('router.push(data.redirect ||');
    assert.ok(enrollIdx > -1 && challengeIdx > -1 && oldRedirectIdx > -1);
    assert.ok(enrollIdx < oldRedirectIdx && challengeIdx < oldRedirectIdx);
    assert.ok(source.includes('router.push("/mfa/enroll")'));
    assert.ok(source.includes("/mfa/challenge"));
  });
});
