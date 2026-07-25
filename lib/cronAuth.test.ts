// Phase 5.6C: focused tests for the shared cron Bearer-auth helper used by
// both app/api/cron/reminders and app/api/cron/reconcile-subscriptions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedCronRequest } from "./cronAuth.ts";

describe("isAuthorizedCronRequest", () => {
  test("missing CRON_SECRET env fails closed even with a well-formed header", () => {
    assert.equal(isAuthorizedCronRequest("Bearer anything", undefined), false);
    assert.equal(isAuthorizedCronRequest("Bearer anything", ""), false);
  });

  test("missing Authorization header is rejected", () => {
    assert.equal(isAuthorizedCronRequest(null, "the-real-secret"), false);
  });

  test("wrong scheme is rejected", () => {
    assert.equal(isAuthorizedCronRequest("Basic the-real-secret", "the-real-secret"), false);
  });

  test("empty Bearer token is rejected", () => {
    assert.equal(isAuthorizedCronRequest("Bearer ", "the-real-secret"), false);
    assert.equal(isAuthorizedCronRequest("Bearer", "the-real-secret"), false);
  });

  test("wrong token is rejected", () => {
    assert.equal(isAuthorizedCronRequest("Bearer wrong-token", "the-real-secret"), false);
  });

  test("correct Bearer token is accepted", () => {
    assert.equal(isAuthorizedCronRequest("Bearer the-real-secret", "the-real-secret"), true);
  });

  test("scheme is case-sensitive -- 'bearer' (lowercase) is rejected, matching exactly what Vercel Cron sends", () => {
    assert.equal(isAuthorizedCronRequest("bearer the-real-secret", "the-real-secret"), false);
  });

  test("a token with extra leading whitespace does not match -- no trimming is performed", () => {
    assert.equal(isAuthorizedCronRequest("Bearer  the-real-secret", "the-real-secret"), false);
  });
});
