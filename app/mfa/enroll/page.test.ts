// Phase 5.7D: source-level proof for app/mfa/enroll/page.tsx (a .tsx file
// -- see app/signup/page.test.ts for why this is source-inspection only).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/mfa/enroll/page.tsx -- the five required enrollment steps", () => {
  test("tells the owner to open/install an authenticator app, scan the QR code, enter the code, confirm setup, and optionally add a backup", () => {
    assert.ok(/open or install an authenticator app/i.test(source));
    assert.ok(/scan the qr code/i.test(source));
    assert.ok(/enter the six-digit code/i.test(source));
    assert.ok(/confirm setup/i.test(source));
    assert.ok(/optionally add a backup authenticator/i.test(source));
  });
});

describe("app/mfa/enroll/page.tsx -- named example authenticator apps", () => {
  test("mentions all five approved examples", () => {
    for (const app of ["Google Authenticator", "Microsoft Authenticator", "Apple Passwords", "Authy", "1Password"]) {
      assert.ok(source.includes(app), `must mention ${app}`);
    }
  });
});

describe("app/mfa/enroll/page.tsx -- required disclosures", () => {
  test("includes a 'What is two-step verification?' explanation", () => {
    assert.ok(source.includes("What is two-step verification?"));
  });

  test("includes a manual setup-secret fallback for when QR scanning is unavailable", () => {
    assert.ok(source.includes("Can't scan?"));
    assert.ok(source.includes("secret"));
  });

  test("warns against sharing or screenshotting the QR code or secret", () => {
    assert.ok(/do not share or screenshot/i.test(source));
  });

  test("states this setup applies to owners only, not employees", () => {
    assert.ok(/does not apply to employees/i.test(source));
  });
});

describe("app/mfa/enroll/page.tsx -- never stores or logs the QR code or TOTP secret", () => {
  test("contains no console.log/console.error of the qr code or secret, and no fetch/localStorage persistence of either", () => {
    assert.ok(!source.includes("console.log(qrCode"));
    assert.ok(!source.includes("console.log(secret"));
    assert.ok(!source.includes("localStorage"));
    assert.ok(!source.includes("sessionStorage"));
  });

  test("fetches the QR code/secret from GET /api/auth/mfa/enroll and posts only the six-digit code to verify -- never re-sends the secret anywhere", () => {
    assert.ok(source.includes('fetch("/api/auth/mfa/enroll")'));
    assert.ok(source.includes('fetch("/api/auth/mfa/verify"'));
    const verifyBodyMatch = source.match(/body: JSON\.stringify\(\{([^}]*)\}\)/);
    assert.ok(verifyBodyMatch);
    assert.ok(!verifyBodyMatch![1].includes("secret"));
    assert.ok(!verifyBodyMatch![1].includes("qrCode"));
  });
});
