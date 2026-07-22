// Focused tests for the canonical support-destination module
// (lib/support.ts). Pure constants, no I/O -- these tests exist to lock
// the exact contract future UI components (starting with the Phase 5.5D
// billing banner) will rely on, and to prove importing this module has no
// side effect and carries no sensitive detail.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Deliberately the very first test in this file (node:test runs tests
// within a file in declaration order by default, the same assumption
// every other sequential test file in this repo already relies on) --
// this is the ONLY point at which lib/support.ts is imported for the
// first time in this process, so the console spy below genuinely observes
// the module's own top-level evaluation, not a cached re-import.
test("importing lib/support.ts has no observable side effect (no console output)", async () => {
  const originalError = console.error;
  const originalLog = console.log;
  const originalWarn = console.warn;
  let called = false;
  console.error = () => { called = true; };
  console.log = () => { called = true; };
  console.warn = () => { called = true; };
  try {
    await import("./support.ts");
  } finally {
    console.error = originalError;
    console.log = originalLog;
    console.warn = originalWarn;
  }
  assert.equal(called, false, "importing lib/support.ts must not log or emit anything");
});

describe("canonical support destination", () => {
  test("SUPPORT_EMAIL is exactly the approved address", async () => {
    const { SUPPORT_EMAIL } = await import("./support.ts");
    assert.equal(SUPPORT_EMAIL, "support@scheduleflowtrack.com");
  });

  test("SUPPORT_MAILTO_URL is exactly mailto: the approved address, with no query string", async () => {
    const { SUPPORT_MAILTO_URL } = await import("./support.ts");
    assert.equal(SUPPORT_MAILTO_URL, "mailto:support@scheduleflowtrack.com");
    assert.ok(!SUPPORT_MAILTO_URL.includes("?"), "must carry no subject/body/query string");
  });

  test("never uses the internal owner backfill address", async () => {
    const { SUPPORT_EMAIL, SUPPORT_MAILTO_URL } = await import("./support.ts");
    assert.ok(!SUPPORT_EMAIL.includes("novalabsdigital.com"));
    assert.ok(!SUPPORT_MAILTO_URL.includes("novalabsdigital.com"));
  });

  test("SUPPORT_MAILTO_URL is derived from SUPPORT_EMAIL, not a second independent literal", async () => {
    const { SUPPORT_EMAIL, SUPPORT_MAILTO_URL } = await import("./support.ts");
    assert.equal(SUPPORT_MAILTO_URL, `mailto:${SUPPORT_EMAIL}`);
  });

  test("involves no HTTP/network endpoint -- both exports are plain strings, nothing else exported", async () => {
    const mod = await import("./support.ts");
    assert.equal(typeof mod.SUPPORT_EMAIL, "string");
    assert.equal(typeof mod.SUPPORT_MAILTO_URL, "string");
    assert.deepEqual(Object.keys(mod).sort(), ["SUPPORT_EMAIL", "SUPPORT_MAILTO_URL"]);
  });

  test("carries no workspace, Stripe, subscription, or entitlement identifier", async () => {
    const { SUPPORT_EMAIL, SUPPORT_MAILTO_URL } = await import("./support.ts");
    for (const forbidden of ["workspace", "stripe", "sub_", "cus_", "entitlement", "billing_mode"]) {
      assert.ok(!SUPPORT_EMAIL.toLowerCase().includes(forbidden));
      assert.ok(!SUPPORT_MAILTO_URL.toLowerCase().includes(forbidden));
    }
  });
});
