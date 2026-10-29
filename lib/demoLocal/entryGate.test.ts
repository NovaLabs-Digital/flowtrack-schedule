import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEMO_ENTRY_EMAIL, DEMO_ENTRY_PASSWORD, isValidDemoEntry } from "./entryGate.ts";

describe("isValidDemoEntry (local demo entry gate, not authentication)", () => {
  test("the published demo credentials are the expected display values", () => {
    assert.equal(DEMO_ENTRY_EMAIL, "demo@scheduleflowtrack.com");
    assert.equal(DEMO_ENTRY_PASSWORD, "Demo2026!");
  });

  test("correct email and password -> true", () => {
    assert.equal(isValidDemoEntry(DEMO_ENTRY_EMAIL, DEMO_ENTRY_PASSWORD), true);
  });

  test("wrong email -> false", () => {
    assert.equal(isValidDemoEntry("someone@example.com", DEMO_ENTRY_PASSWORD), false);
    assert.equal(isValidDemoEntry("", DEMO_ENTRY_PASSWORD), false);
  });

  test("wrong password -> false", () => {
    assert.equal(isValidDemoEntry(DEMO_ENTRY_EMAIL, "demo2026!"), false);
    assert.equal(isValidDemoEntry(DEMO_ENTRY_EMAIL, ""), false);
  });

  test("both wrong -> false", () => {
    assert.equal(isValidDemoEntry("x", "y"), false);
  });
});
