// Phase 5.6C: auth-focused route-level tests for
// app/api/cron/reconcile-subscriptions/route.ts. This route's per-row
// reconciliation logic is already exhaustively tested in
// lib/reconcileSubscriptions.test.ts against reconcileRows() directly (fake
// deps, no route involved) -- this file proves only the route's own
// concerns: the Bearer-token authentication gate it shares with
// app/api/cron/reminders via lib/cronAuth.ts, and that it runs before any
// Stripe/database access. @/lib/supabaseAdmin and @/lib/stripe are mocked
// in-process (no real network call is reachable), matching the pattern
// already used in app/api/cron/reminders/route.test.ts. This route remains
// deliberately unscheduled in vercel.json -- see that route's own header
// comment.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CRON_SECRET = "test-cron-secret";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let fromCalls: string[] = [];

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => {
        fromCalls.push(table);
        return {
          select: () => ({
            eq: () => ({
              neq: () => ({
                lt: () => ({
                  order: () => ({
                    order: () => ({
                      limit: async () => ({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      },
    },
  },
});

mock.module("@/lib/stripe", {
  namedExports: {
    getStripeConfig: () => ({
      client: {
        subscriptions: {
          retrieve: async () => {
            throw new Error("not reachable in these auth-only tests -- no rows are ever returned");
          },
        },
      },
      priceId: "price_test",
      webhookSecret: "whsec_test",
    }),
  },
});

const { GET } = await import("./route.ts");

// `token` is the Bearer credential sent in the Authorization header;
// `extraQuery` optionally appends an unrelated query string.
function req(token: string | null | undefined = "test-cron-secret", extraQuery = "") {
  const base = "http://localhost/api/cron/reconcile-subscriptions";
  const url = `${base}${extraQuery ? `?${extraQuery}` : ""}`;
  const headers: Record<string, string> = {};
  if (token !== null && token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(url, { headers });
}

describe("GET /api/cron/reconcile-subscriptions -- scheduler authentication (Bearer, Phase 5.6C)", () => {
  test("missing Authorization header is denied before any Supabase call", async () => {
    fromCalls = [];
    const res = await GET(req(null));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(fromCalls.length, 0);
  });

  test("wrong scheme is denied before any Supabase call", async () => {
    fromCalls = [];
    const res = await GET(new Request("http://localhost/api/cron/reconcile-subscriptions", { headers: { authorization: "Basic dGVzdC1jcm9uLXNlY3JldA==" } }));
    assert.equal(res.status, 401);
    assert.equal(fromCalls.length, 0);
  });

  test("empty Bearer token is denied before any Supabase call", async () => {
    fromCalls = [];
    const res = await GET(new Request("http://localhost/api/cron/reconcile-subscriptions", { headers: { authorization: "Bearer " } }));
    assert.equal(res.status, 401);
    assert.equal(fromCalls.length, 0);
  });

  test("wrong token is denied before any Supabase call", async () => {
    fromCalls = [];
    const res = await GET(req("wrong-secret"));
    assert.equal(res.status, 401);
    assert.equal(fromCalls.length, 0);
  });

  test("missing CRON_SECRET env fails closed even with a well-formed Bearer header", async () => {
    fromCalls = [];
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await GET(req("test-cron-secret"));
      assert.equal(res.status, 401);
      assert.equal(fromCalls.length, 0);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });

  test("query-string-only authentication (?secret=) is rejected -- the Authorization header is required", async () => {
    fromCalls = [];
    const res = await GET(req(null, "secret=test-cron-secret"));
    assert.equal(res.status, 401);
    assert.equal(fromCalls.length, 0);
  });

  test("correct Bearer token is accepted and reaches the database query", async () => {
    fromCalls = [];
    const res = await GET(req("test-cron-secret"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { processed: 0, synchronized: 0, skipped: 0, failed: 0 });
    assert.ok(fromCalls.includes("subscriptions"));
  });

  test("a valid Bearer token still works if an unrelated ?secret= query parameter is present", async () => {
    fromCalls = [];
    const res = await GET(req("test-cron-secret", "secret=irrelevant-decoy"));
    assert.equal(res.status, 200);
    assert.ok(fromCalls.includes("subscriptions"));
  });

  test("the secret value never appears in any response body", async () => {
    fromCalls = [];
    const denied = await GET(req("wrong-secret"));
    const deniedText = JSON.stringify(await denied.json());
    assert.ok(!deniedText.includes("test-cron-secret"));

    fromCalls = [];
    const allowed = await GET(req("test-cron-secret"));
    const allowedText = JSON.stringify(await allowed.json());
    assert.ok(!allowedText.includes("test-cron-secret"));
  });
});
