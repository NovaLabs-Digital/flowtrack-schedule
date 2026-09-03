// Phase 5.7D-R13: pure-value tests for the public, non-secret price/trial
// display constants shown on the landing and signup pages before checkout.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SUBSCRIPTION_PRICE_DISPLAY, SUBSCRIPTION_TRIAL_DAYS } from "./billingDisplay.ts";

describe("lib/billingDisplay.ts", () => {
  test("the displayed monthly price is exactly $24.99, matching the Terms and Stripe Checkout", () => {
    assert.equal(SUBSCRIPTION_PRICE_DISPLAY, "$24.99");
  });

  test("the displayed trial length is exactly 30 days, matching the Terms", () => {
    assert.equal(SUBSCRIPTION_TRIAL_DAYS, 30);
  });
});
