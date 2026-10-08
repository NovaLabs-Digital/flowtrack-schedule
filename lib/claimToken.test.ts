import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { generateClaimToken } from "./claimToken.ts";

describe("generateClaimToken", () => {
  test("returns a well-formed UUID", () => {
    assert.match(generateClaimToken(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("two consecutive calls never return the same value", () => {
    const a = generateClaimToken();
    const b = generateClaimToken();
    assert.notEqual(a, b);
  });
});
