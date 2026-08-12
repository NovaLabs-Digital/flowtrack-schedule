// Block 2C-2C: route-level tests for
// app/api/cron/replenish-recurring-series/route.ts. The orchestration
// logic itself (selection, coverage, generation, RPC outcome handling,
// concurrency/idempotency proofs) is exhaustively tested in
// lib/recurringSeriesReplenishmentOrchestrator.test.ts against
// runReplenishmentPass() directly -- this file proves only the route's own
// concerns: the shared Bearer-token cron auth gate (matching
// app/api/cron/reconcile-subscriptions/route.test.ts's established
// pattern), the REPLENISHMENT_DRY_RUN env-var-only dry-run control (never a
// request-supplied value), and the response/error shape. This route is
// deliberately unscheduled in vercel.json as of this round.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CRON_SECRET = "test-cron-secret";
delete process.env.REPLENISHMENT_DRY_RUN;

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let throwOnFirstQuery = false;

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => {
        if (throwOnFirstQuery) {
          throw new Error("simulated infrastructure failure");
        }
        return currentFake.supabaseAdmin.from(table);
      },
      rpc: (fn: string, args?: unknown) => currentFake.supabaseAdmin.rpc(fn, args),
    },
  },
});

const { GET } = await import("./route.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
  throwOnFirstQuery = false;
}

function req(token: string | null | undefined = "test-cron-secret", headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (token !== null && token !== undefined) h.authorization = `Bearer ${token}`;
  return new Request("http://localhost/api/cron/replenish-recurring-series", { headers: h });
}

function emptySelection(): FakeSupabaseFixture[] {
  return [{ data: [] }, { data: null, count: 0 }];
}

describe("GET /api/cron/replenish-recurring-series -- scheduler authentication (shared Bearer convention)", () => {
  test("missing Authorization header is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(req(null));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("wrong scheme is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(new Request("http://localhost/api/cron/replenish-recurring-series", { headers: { authorization: "Basic dGVzdA==" } }));
    assert.equal(res.status, 401);
    assert.equal(currentFake.calls.length, 0);
  });

  test("empty Bearer token is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(new Request("http://localhost/api/cron/replenish-recurring-series", { headers: { authorization: "Bearer " } }));
    assert.equal(res.status, 401);
    assert.equal(currentFake.calls.length, 0);
  });

  test("wrong token is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(req("wrong-secret"));
    assert.equal(res.status, 401);
    assert.equal(currentFake.calls.length, 0);
  });

  test("missing CRON_SECRET env fails closed even with a well-formed Bearer header", async () => {
    resetFixtures({});
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await GET(req("test-cron-secret"));
      assert.equal(res.status, 401);
      assert.equal(currentFake.calls.length, 0);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });

  test("an owner/tester session cookie cannot substitute for cron authorization -- still 401 with no Authorization header", async () => {
    resetFixtures({});
    const res = await GET(req(null, { cookie: "session=fake-owner-session-token" }));
    assert.equal(res.status, 401);
    assert.equal(currentFake.calls.length, 0);
  });

  test("correct Bearer token is accepted and reaches the database query", async () => {
    resetFixtures({ recurring_series: emptySelection() });
    const res = await GET(req("test-cron-secret"));
    assert.equal(res.status, 200);
    assert.ok(currentFake.calls.some((c) => c.table === "recurring_series"));
  });

  test("the secret value never appears in any response body", async () => {
    resetFixtures({});
    const denied = await GET(req("wrong-secret"));
    assert.ok(!JSON.stringify(await denied.json()).includes("test-cron-secret"));

    resetFixtures({ recurring_series: emptySelection() });
    const allowed = await GET(req("test-cron-secret"));
    assert.ok(!JSON.stringify(await allowed.json()).includes("test-cron-secret"));
  });
});

describe("GET /api/cron/replenish-recurring-series -- fail-safe dry-run default (production-review correction round)", () => {
  // Production-review correction: an earlier draft had this backwards --
  // `env === "true"` meant an ABSENT variable (a freshly deployed
  // environment's actual default state) evaluated to LIVE mode. Every case
  // below proves the corrected, fail-safe behavior: dry-run is the default
  // for everything except the one exact, explicit opt-in string "false".

  test("REPLENISHMENT_DRY_RUN unset (the true default state of a fresh deployment) -> dryRun:true, no writes attempted", async () => {
    delete process.env.REPLENISHMENT_DRY_RUN;
    resetFixtures({ recurring_series: emptySelection() });
    const res = await GET(req());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dryRun, true);
    assert.ok(body.counts);
    assert.equal("seriesDetails" in body, false);
  });

  test("REPLENISHMENT_DRY_RUN='' (blank) -> dryRun:true", async () => {
    process.env.REPLENISHMENT_DRY_RUN = "";
    try {
      resetFixtures({ recurring_series: emptySelection() });
      const res = await GET(req());
      const body = await res.json();
      assert.equal(body.dryRun, true);
    } finally {
      delete process.env.REPLENISHMENT_DRY_RUN;
    }
  });

  test("REPLENISHMENT_DRY_RUN='true' -> dryRun:true (still safe, redundant with the default)", async () => {
    process.env.REPLENISHMENT_DRY_RUN = "true";
    try {
      resetFixtures({ recurring_series: emptySelection() });
      const res = await GET(req());
      const body = await res.json();
      assert.equal(body.dryRun, true);
    } finally {
      delete process.env.REPLENISHMENT_DRY_RUN;
    }
  });

  test("every unrecognized/malformed value fails closed to dryRun:true -- never coerced into enabling live mode", async () => {
    for (const value of ["1", "TRUE", "False", "FALSE", " false", "false ", "no", "0", "live", "disabled"]) {
      process.env.REPLENISHMENT_DRY_RUN = value;
      try {
        resetFixtures({ recurring_series: emptySelection() });
        const res = await GET(req());
        const body = await res.json();
        assert.equal(body.dryRun, true, `value ${JSON.stringify(value)} must fail closed to dry-run`);
      } finally {
        delete process.env.REPLENISHMENT_DRY_RUN;
      }
    }
  });

  test("REPLENISHMENT_DRY_RUN set to EXACTLY the literal lowercase 'false' is the only value that enables live mode", async () => {
    process.env.REPLENISHMENT_DRY_RUN = "false";
    try {
      resetFixtures({ recurring_series: emptySelection() });
      const res = await GET(req());
      const body = await res.json();
      assert.equal(body.dryRun, false);
    } finally {
      delete process.env.REPLENISHMENT_DRY_RUN;
    }
  });

  test("neither mode's response ever includes a seriesDetails key or any other per-series field -- aggregate counts only", async () => {
    for (const envValue of [undefined, "false"]) {
      if (envValue === undefined) delete process.env.REPLENISHMENT_DRY_RUN;
      else process.env.REPLENISHMENT_DRY_RUN = envValue;
      try {
        resetFixtures({ recurring_series: emptySelection() });
        const res = await GET(req());
        const body = await res.json();
        assert.deepEqual(Object.keys(body).sort(), ["counts", "dryRun", "ok"]);
      } finally {
        delete process.env.REPLENISHMENT_DRY_RUN;
      }
    }
  });

  test("a query parameter cannot force live mode nor override the env-var-driven default in either direction", async () => {
    delete process.env.REPLENISHMENT_DRY_RUN;
    resetFixtures({ recurring_series: emptySelection() });
    const res = await GET(
      new Request("http://localhost/api/cron/replenish-recurring-series?REPLENISHMENT_DRY_RUN=false&dryRun=false&live=true", {
        headers: { authorization: "Bearer test-cron-secret" },
      })
    );
    const body = await res.json();
    assert.equal(body.dryRun, true, "a query parameter must never be able to force live mode");
  });
});

describe("GET /api/cron/replenish-recurring-series -- route-wide failure handling", () => {
  test("an infrastructure-level failure before any row is read returns a safe 500 with no raw error detail", async () => {
    resetFixtures({});
    throwOnFirstQuery = true;
    const res = await GET(req());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: "Server error" });
  });
});
