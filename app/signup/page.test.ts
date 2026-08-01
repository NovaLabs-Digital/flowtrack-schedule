// Phase 5.7D: source-level proof for app/signup/page.tsx. This is a .tsx
// file; Node's built-in test runner (this repo's only test runner) cannot
// load .tsx directly -- matching the established convention (see
// app/login/page.test.ts), this file proves what source inspection can
// actually prove: required copy, required links, required validation
// logic, and structural absence of forbidden content.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/signup/page.tsx -- required fields", () => {
  test("collects company name, email, password, confirm password, and a terms-acceptance checkbox", () => {
    assert.ok(source.includes("companyName"));
    assert.ok(source.includes('type="email"'));
    // Phase 5.7D-R17: password fields render via the shared PasswordInput
    // show/hide component, not a raw <input type="password">.
    assert.ok(source.includes('import PasswordInput from "@/app/components/PasswordInput";'));
    assert.ok(source.includes("<PasswordInput"));
    assert.ok(source.includes("confirmPassword"));
    assert.ok(source.includes('type="checkbox"'));
    assert.ok(source.includes("termsAccepted"));
  });

  test("client-side confirm-password check exists, and confirmPassword is never sent to the server", () => {
    assert.ok(source.includes("password !== confirmPassword"));
    const bodyMatch = source.match(/body: JSON\.stringify\(\{([^}]*)\}\)/);
    assert.ok(bodyMatch);
    assert.ok(!bodyMatch![1].includes("confirmPassword"));
  });

  test("links to /terms and /privacy, and to /login for an existing account", () => {
    assert.ok(source.includes('href="/terms"'));
    assert.ok(source.includes('href="/privacy"'));
    assert.ok(source.includes('href="/login"'));
    assert.ok(source.includes("Already have an account?"));
    assert.ok(source.includes("Sign in"));
  });
});

describe("app/signup/page.tsx -- password visibility (Phase 5.7D-R17)", () => {
  test("both the password and confirm-password fields use PasswordInput, with correct autoComplete hints", () => {
    const occurrences = [...source.matchAll(/<PasswordInput/g)].length;
    assert.equal(occurrences, 2, "expected exactly two PasswordInput usages: password and confirm password");
    assert.equal([...source.matchAll(/autoComplete="new-password"/g)].length, 2);
  });

  test("no raw <input type=\"password\"> remains in this file -- both fields were migrated to the shared component", () => {
    assert.ok(!source.includes('type="password"'));
  });
});

describe("app/signup/page.tsx -- no client-controlled provisioning field is ever sent", () => {
  test("the POST body never includes workspace_id, role, billing_mode, notifications_enabled, booking_enabled, or a trial field", () => {
    for (const forbidden of ["workspace_id", "workspaceId", '"role"', "billing_mode", "notifications_enabled", "booking_enabled", "trial_consumed_at"]) {
      assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`);
    }
  });
});

describe("app/signup/page.tsx -- beginner-friendly MFA explanation, shown before account creation", () => {
  test("includes the exact approved pre-signup two-step verification blurb", () => {
    assert.ok(source.includes("ScheduleFlowTrack uses two-step verification for business owners."));
    assert.ok(source.includes("scan a QR code with an authenticator app"));
    assert.ok(source.includes("Have your phone nearby"));
    assert.ok(source.includes("stay signed in for 30 days"));
  });
});

describe("app/signup/page.tsx -- redirect handling for every signup outcome", () => {
  test("handles check_email, enroll, and challenge outcomes distinctly", () => {
    assert.ok(source.includes('data.next === "check_email"'));
    assert.ok(source.includes('data.next === "enroll"'));
    assert.ok(source.includes('data.next === "challenge"'));
    assert.ok(source.includes('router.push("/mfa/enroll")'));
    assert.ok(source.includes("/mfa/challenge"));
  });
});

// Phase 5.7D-R8: the company-name field's placeholder was corrected from a
// customer-specific example to a generic one -- this repo's copy must never
// reference Nova Labs Digital's own founder/customer by name or imply any
// specific customer's business is a template for a new signup.
describe("app/signup/page.tsx -- generic company-name placeholder (Phase 5.7D-R8)", () => {
  test("the company-name placeholder is exactly 'Your company name' -- no 'e.g.' prefix, no example business name", () => {
    assert.ok(source.includes('placeholder="Your company name"'));
  });

  test("no customer-specific or founder-specific wording appears anywhere in this page's source", () => {
    for (const forbidden of ["Alberto", "Alberto’s Cleaning Services", "Alberto's Cleaning Services", "ACS", "Cleaning Services"]) {
      assert.ok(!source.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });
});

describe("app/signup/page.tsx -- footer Support link (post-launch correction)", () => {
  test("uses the canonical SUPPORT_MAILTO_URL constant, never a literal address", () => {
    assert.ok(source.includes('import { SUPPORT_MAILTO_URL } from "@/lib/support";'));
    assert.ok(!source.includes("support@scheduleflowtrack.com"), "must not hardcode the address inline");
  });

  test("the footer renders a Support link beside Terms of Service / Privacy Policy", () => {
    const footerIdx = source.lastIndexOf("Terms of Service");
    assert.notEqual(footerIdx, -1);
    const footerBlock = source.slice(footerIdx, footerIdx + 400);
    const hrefIdx = footerBlock.indexOf("href={SUPPORT_MAILTO_URL}");
    assert.notEqual(hrefIdx, -1, "expected a Support link near Terms of Service / Privacy Policy");
    assert.ok(footerBlock.slice(hrefIdx, hrefIdx + 150).includes("Support"));
  });
});
