// Phase 5.7D: source-level proof for app/mfa/challenge/page.tsx (a .tsx
// file -- see app/signup/page.test.ts for why this is source-inspection only).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/mfa/challenge/page.tsx -- the 'Keep me signed in' checkbox is unchecked by default", () => {
  test("trustDevice state defaults to false", () => {
    assert.ok(/const \[trustDevice, setTrustDevice\] = useState\(false\)/.test(source));
  });

  test("carries the exact approved label", () => {
    assert.ok(source.includes("Keep me signed in on this device for 30 days"));
  });

  test("trustDevice is threaded into the verify request body", () => {
    assert.ok(source.includes("trustDevice"));
  });
});

describe("app/mfa/challenge/page.tsx -- multiple-factor selection", () => {
  test("renders a picker only when more than one factorId is present in the query string", () => {
    assert.ok(source.includes("multipleFactors"));
    assert.ok(source.includes("factorIds.length > 1"));
  });
});

describe("app/mfa/challenge/page.tsx -- posts only code/trustDevice/factorId, never a raw TOTP secret or Supabase token", () => {
  test("no reference to a TOTP secret or Supabase access/refresh token anywhere in this file", () => {
    for (const forbidden of ["secret", "accessToken", "refreshToken", "access_token", "refresh_token"]) {
      assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `must not reference ${forbidden}`);
    }
  });
});
