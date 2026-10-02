// Phase 5.6F: focused tests for lib/stripeCheckout.ts's one-time-trial
// enforcement -- the FIRST test coverage this file has ever had. Exercises
// resolveOrCreateCheckoutSession directly with a fake Stripe client (no
// real network call reachable), proving trial_period_days is included or
// omitted from the actual Checkout Session params based purely on the
// trialEligible argument the caller (app/api/stripe/checkout/route.ts)
// resolves from the workspace's own subscriptions.trial_consumed_at column
// -- never from any client-supplied value (this function has no such
// parameter to accept one from).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

const { resolveOrCreateCheckoutSession, CheckoutRetryableError } = await import("./stripeCheckout.ts");

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const SUBSCRIPTION_ROW_ID = "sub-row-1";
const CUSTOMER_ID = "cus_test123";
const PRICE_ID = "price_test123";

interface CreateCall {
  params: Stripe.Checkout.SessionCreateParams;
  opts: { idempotencyKey: string };
}

interface FakeSession {
  id: string;
  url: string | null;
  metadata?: Record<string, string>;
  allow_promotion_codes?: boolean;
}

// A session shaped exactly like what buildSessionParams(..., trialEligible,
// PRICE_ID) would produce -- the baseline for "an existing open session IS
// compatible and should be reused as-is."
function compatibleExistingSession(overrides: Partial<FakeSession> & { trialEligible: boolean }): FakeSession {
  const { trialEligible, ...rest } = overrides;
  return {
    id: "cs_existing",
    url: "https://checkout.stripe.com/c/pay/cs_existing",
    allow_promotion_codes: true,
    metadata: { workspace_id: WORKSPACE_ID, trial_eligible: String(trialEligible), price_id: PRICE_ID },
    ...rest,
  };
}

function fakeStripeClient(overrides: {
  listResult?: { data: FakeSession[] };
  createImpl?: (params: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => Promise<{ id: string; url: string | null }>;
  expireImpl?: (id: string) => Promise<unknown>;
} = {}) {
  const createCalls: CreateCall[] = [];
  const expireCalls: string[] = [];
  const defaultCreate = async () => ({ id: "cs_test_new", url: "https://checkout.stripe.com/c/pay/cs_test_new" });
  const defaultExpire = async (id: string) => ({ id, status: "expired" });
  const client = {
    checkout: {
      sessions: {
        list: async () => overrides.listResult ?? { data: [] },
        create: async (params: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => {
          createCalls.push({ params, opts });
          const impl = overrides.createImpl ?? defaultCreate;
          return impl(params, opts);
        },
        expire: async (id: string) => {
          expireCalls.push(id);
          const impl = overrides.expireImpl ?? defaultExpire;
          return impl(id);
        },
      },
    },
  } as unknown as Stripe;
  return { client, createCalls, expireCalls };
}

describe("one trial per workspace -- resolved server-side, never from client input", () => {
  test("trialEligible=true includes trial_period_days: 30 in the actual Checkout Session params", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].params.subscription_data?.trial_period_days, 30);
  });

  test("trialEligible=false omits trial_period_days entirely -- not set to 0, simply absent", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, false);
    assert.equal(createCalls.length, 1);
    assert.equal("trial_period_days" in (createCalls[0].params.subscription_data ?? {}), false);
  });

  test("resolveOrCreateCheckoutSession has no parameter through which a caller could request/override trial eligibility other than the one explicit boolean the route itself computes", () => {
    // Structural guarantee: exactly 6 positional parameters, the last of
    // which is trialEligible -- there is no options bag, no request body,
    // no query string this function reads to derive eligibility itself.
    assert.equal(resolveOrCreateCheckoutSession.length, 6);
  });

  test("workspace_id is still stamped into subscription_data.metadata regardless of trial eligibility", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, false);
    assert.equal(createCalls[0].params.subscription_data?.metadata?.workspace_id, WORKSPACE_ID);
  });

  test("allow_promotion_codes is true regardless of trial eligibility -- the customer can type a code, none is ever preset", async () => {
    const { client: clientA, createCalls: callsA } = fakeStripeClient();
    const { client: clientB, createCalls: callsB } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, clientA, PRICE_ID, true);
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, clientB, PRICE_ID, false);
    assert.equal(callsA[0].params.allow_promotion_codes, true);
    assert.equal(callsB[0].params.allow_promotion_codes, true);
    assert.equal("discounts" in callsA[0].params, false);
  });

  test("top-level metadata carries workspace_id plus a trial/price fingerprint used later to judge whether an open session is still reusable", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls[0].params.metadata?.workspace_id, WORKSPACE_ID);
    assert.equal(createCalls[0].params.metadata?.trial_eligible, "true");
    assert.equal(createCalls[0].params.metadata?.price_id, PRICE_ID);
  });

  test("the idempotency key is identical regardless of trial eligibility -- eligibility does not create a second concurrency path", async () => {
    const { client: clientA, createCalls: callsA } = fakeStripeClient();
    const { client: clientB, createCalls: callsB } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, clientA, PRICE_ID, true);
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, clientB, PRICE_ID, false);
    assert.equal(callsA[0].opts.idempotencyKey, callsB[0].opts.idempotencyKey);
    assert.equal(callsA[0].opts.idempotencyKey, `checkout-${SUBSCRIPTION_ROW_ID}`);
  });
});

describe("an already-open Checkout Session is reused only when it's actually compatible with the current request (Phase 5.7D-R13-HF2)", () => {
  test("a compatible open session (allow_promotion_codes true, matching trial/price fingerprint) is returned directly -- create() and expire() are never called", async () => {
    const { client, createCalls, expireCalls } = fakeStripeClient({
      listResult: { data: [compatibleExistingSession({ trialEligible: true })] },
    });
    const url = await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_existing");
    assert.equal(createCalls.length, 0);
    assert.equal(expireCalls.length, 0);
  });

  test("an open session belonging to a DIFFERENT workspace is ignored -- a new session is still created for this one", async () => {
    const { client, createCalls, expireCalls } = fakeStripeClient({
      listResult: { data: [{ id: "cs_other", url: "https://checkout.stripe.com/c/pay/cs_other", allow_promotion_codes: true, metadata: { workspace_id: "some-other-workspace" } }] },
    });
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls.length, 1);
    assert.equal(expireCalls.length, 0, "a different workspace's session is never ours to expire");
  });

  test("an open session created before allow_promotion_codes existed (field false/missing) is expired, then a fresh compatible session is created", async () => {
    const { client, createCalls, expireCalls } = fakeStripeClient({
      listResult: { data: [compatibleExistingSession({ trialEligible: true, allow_promotion_codes: false })] },
    });
    const url = await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.deepEqual(expireCalls, ["cs_existing"]);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].params.allow_promotion_codes, true);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_new");
  });

  test("an open session for a different trial-eligibility decision is expired, then replaced -- never silently reused with the wrong trial", async () => {
    // Session was created while trialEligible was true; the workspace is
    // asking again but is no longer eligible (e.g. consumed elsewhere).
    const { client, createCalls, expireCalls } = fakeStripeClient({
      listResult: { data: [compatibleExistingSession({ trialEligible: true })] },
    });
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, false);
    assert.deepEqual(expireCalls, ["cs_existing"]);
    assert.equal(createCalls.length, 1);
    assert.equal("trial_period_days" in (createCalls[0].params.subscription_data ?? {}), false);
  });

  test("an open session for a different price id is expired, then replaced", async () => {
    const { client, createCalls, expireCalls } = fakeStripeClient({
      listResult: { data: [compatibleExistingSession({ trialEligible: true, metadata: { workspace_id: WORKSPACE_ID, trial_eligible: "true", price_id: "price_old" } })] },
    });
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.deepEqual(expireCalls, ["cs_existing"]);
    assert.equal(createCalls.length, 1);
  });

  test("the replacement create() after expiring an incompatible session uses a key derived from the stale session's own id, not the plain workspace key", async () => {
    const { client, createCalls } = fakeStripeClient({
      listResult: { data: [compatibleExistingSession({ trialEligible: true, allow_promotion_codes: false })] },
    });
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls[0].opts.idempotencyKey, `checkout-${SUBSCRIPTION_ROW_ID}-refresh-cs_existing`);
  });

  test("if expiring the incompatible session itself fails (already expired/completed), a fresh session is still created rather than erroring", async () => {
    const { client, createCalls } = fakeStripeClient({
      listResult: { data: [compatibleExistingSession({ trialEligible: true, allow_promotion_codes: false })] },
      expireImpl: async () => {
        throw new Error("Session already expired");
      },
    });
    const url = await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls.length, 1);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_test_new");
  });
});

describe("stale idempotent replay (expired cached session) is retried with a fresh key, preserving trial eligibility", () => {
  test("a null-url create response triggers exactly one retry with the SAME trialEligible params", async () => {
    let callCount = 0;
    const { client, createCalls } = fakeStripeClient({
      createImpl: async () => {
        callCount++;
        if (callCount === 1) return { id: "cs_stale", url: null };
        return { id: "cs_fresh", url: "https://checkout.stripe.com/c/pay/cs_fresh" };
      },
    });
    const url = await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_fresh");
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].params.subscription_data?.trial_period_days, 30);
    assert.equal(createCalls[1].params.subscription_data?.trial_period_days, 30);
  });
});

describe("a genuine idempotency collision surfaces as a retryable error, not a silently wrong trial decision", () => {
  test("StripeIdempotencyError from create() becomes CheckoutRetryableError", async () => {
    const { client } = fakeStripeClient({
      createImpl: async () => {
        throw { type: "StripeIdempotencyError" };
      },
    });
    await assert.rejects(
      () => resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true),
      CheckoutRetryableError
    );
  });
});
