// Block 2C-2B: unit tests for lib/recurringSeriesReplenishmentRpc.ts.
// migrations/027b's own two RPCs' locking/validation logic is proven
// exclusively by migrations/027b_add_recurring_series_replenishment.test.ts's
// source-level assertions against the SQL itself (no live database is
// reachable from any test in this repository) -- this file's only job is
// to prove the THIN TypeScript wrapper: it calls .rpc() with the correct
// parameters, maps a well-formed response correctly, fails closed on a
// malformed one, and never swallows a real RPC-call error.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      rpc: (fn: string, args?: unknown) => currentFake.supabaseAdmin.rpc(fn, args),
    },
  },
});

const {
  replenishRecurringSeries,
  quarantineRecurringSeriesForReplenishment,
  RecurringSeriesReplenishmentRpcError,
} = await import("./recurringSeriesReplenishmentRpc.ts");

function resetFixtures(rpcResponses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin({}, rpcResponses);
}

describe("replenishRecurringSeries -- thin wrapper around replenish_recurring_series", () => {
  function callParams(overrides: Record<string, unknown> = {}) {
    return {
      seriesId: "series-1",
      workspaceId: "ws-1",
      expectedSnapshotUpdatedAt: "2026-01-01T00:00:00.000Z",
      occurrences: ["2026-02-01T09:00:00.000Z", "2026-02-08T09:00:00.000Z"],
      ...overrides,
    };
  }

  test("calls the RPC with exactly the documented parameter names, no snapshot business fields", async () => {
    resetFixtures({ replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 2, skipped_count: 0 } }] });
    await replenishRecurringSeries(callParams());
    assert.equal(currentFake.rpcCalls.length, 1);
    const call = currentFake.rpcCalls[0];
    assert.equal(call.fn, "replenish_recurring_series");
    assert.deepEqual(call.args, {
      p_series_id: "series-1",
      p_workspace_id: "ws-1",
      p_expected_snapshot_updated_at: "2026-01-01T00:00:00.000Z",
      p_occurrences: ["2026-02-01T09:00:00.000Z", "2026-02-08T09:00:00.000Z"],
    });
  });

  test("does not sort or otherwise mutate the caller-supplied occurrences array -- the RPC is the sole authority on that validation", async () => {
    resetFixtures({ replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] });
    const outOfOrder = ["2026-02-08T09:00:00.000Z", "2026-02-01T09:00:00.000Z"];
    await replenishRecurringSeries(callParams({ occurrences: outOfOrder }));
    const call = currentFake.rpcCalls[0];
    assert.deepEqual((call.args as Record<string, unknown>).p_occurrences, outOfOrder);
  });

  test("a well-formed 'replenished' response maps outcome/insertedCount/skippedCount correctly", async () => {
    resetFixtures({ replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 5, skipped_count: 3 } }] });
    const result = await replenishRecurringSeries(callParams());
    assert.deepEqual(result, { outcome: "replenished", insertedCount: 5, skippedCount: 3 });
  });

  for (const outcome of ["conflict", "invalid_input", "client_stopped", "employee_review_required", "missing_snapshot_review_required"] as const) {
    test(`returns outcome '${outcome}' verbatim with zero counts when the RPC reports it`, async () => {
      resetFixtures({ replenish_recurring_series: [{ data: { outcome, inserted_count: 0, skipped_count: 0 } }] });
      const result = await replenishRecurringSeries(callParams());
      assert.deepEqual(result, { outcome, insertedCount: 0, skippedCount: 0 });
    });
  }

  test("failure injection: a real RPC-call error throws RecurringSeriesReplenishmentRpcError, preserving the original as .cause", async () => {
    resetFixtures({ replenish_recurring_series: [{ error: { message: "simulated rpc failure" } }] });
    await assert.rejects(
      () => replenishRecurringSeries(callParams()),
      (err: unknown) => {
        assert.ok(err instanceof RecurringSeriesReplenishmentRpcError);
        assert.ok((err as InstanceType<typeof RecurringSeriesReplenishmentRpcError>).cause);
        return true;
      }
    );
  });

  describe("malformed RPC response fails closed -- never trusted, never silently coerced", () => {
    const malformedCases: Array<[string, unknown]> = [
      ["null data", null],
      ["a bare string instead of an object", "replenished"],
      ["an array instead of an object", [{ outcome: "replenished" }]],
      ["missing outcome field", { inserted_count: 1, skipped_count: 0 }],
      ["missing inserted_count field", { outcome: "replenished", skipped_count: 0 }],
      ["missing skipped_count field", { outcome: "replenished", inserted_count: 1 }],
      ["an unrecognized outcome string", { outcome: "something_else", inserted_count: 0, skipped_count: 0 }],
      ["a non-string outcome", { outcome: 42, inserted_count: 0, skipped_count: 0 }],
      ["a non-integer inserted_count", { outcome: "replenished", inserted_count: "5", skipped_count: 0 }],
      ["a fractional inserted_count", { outcome: "replenished", inserted_count: 1.5, skipped_count: 0 }],
      ["a non-integer skipped_count", { outcome: "replenished", inserted_count: 0, skipped_count: null }],
      ["a fractional skipped_count", { outcome: "replenished", inserted_count: 0, skipped_count: 2.5 }],
      // Production-review correction: negative counts, and an array data
      // value more explicitly than the pre-existing array test case above.
      ["a negative inserted_count", { outcome: "replenished", inserted_count: -1, skipped_count: 0 }],
      ["a negative skipped_count", { outcome: "replenished", inserted_count: 0, skipped_count: -1 }],
      ["both counts negative", { outcome: "conflict", inserted_count: -3, skipped_count: -2 }],
      ["a bare empty array", []],
      ["a nested object array", [{ outcome: "replenished", inserted_count: 1, skipped_count: 0 }]],
    ];
    for (const [label, malformed] of malformedCases) {
      test(`${label} throws RecurringSeriesReplenishmentRpcError, never returns a fabricated result`, async () => {
        resetFixtures({ replenish_recurring_series: [{ data: malformed }] });
        await assert.rejects(
          () => replenishRecurringSeries(callParams()),
          (err: unknown) => err instanceof RecurringSeriesReplenishmentRpcError
        );
      });
    }
  });
});

describe("quarantineRecurringSeriesForReplenishment -- thin wrapper around quarantine_recurring_series_for_replenishment", () => {
  function callParams(overrides: Record<string, unknown> = {}) {
    return {
      seriesId: "series-1",
      workspaceId: "ws-1",
      expectedSnapshotUpdatedAt: "2026-01-01T00:00:00.000Z",
      reason: "dst_gap" as const,
      ...overrides,
    };
  }

  test("calls the RPC with exactly the documented parameter names", async () => {
    resetFixtures({ quarantine_recurring_series_for_replenishment: [{ data: "quarantined" }] });
    await quarantineRecurringSeriesForReplenishment(callParams());
    assert.equal(currentFake.rpcCalls.length, 1);
    const call = currentFake.rpcCalls[0];
    assert.equal(call.fn, "quarantine_recurring_series_for_replenishment");
    assert.deepEqual(call.args, {
      p_series_id: "series-1",
      p_workspace_id: "ws-1",
      p_expected_snapshot_updated_at: "2026-01-01T00:00:00.000Z",
      p_reason: "dst_gap",
    });
  });

  for (const reason of ["dst_gap", "employee_no_longer_eligible", "missing_snapshot"] as const) {
    test(`passes reason '${reason}' through unchanged`, async () => {
      resetFixtures({ quarantine_recurring_series_for_replenishment: [{ data: "quarantined" }] });
      await quarantineRecurringSeriesForReplenishment(callParams({ reason }));
      const call = currentFake.rpcCalls[0];
      assert.equal((call.args as Record<string, unknown>).p_reason, reason);
    });
  }

  for (const outcome of ["quarantined", "conflict", "invalid_reason"] as const) {
    test(`returns outcome '${outcome}' verbatim when the RPC reports it`, async () => {
      resetFixtures({ quarantine_recurring_series_for_replenishment: [{ data: outcome }] });
      const result = await quarantineRecurringSeriesForReplenishment(callParams());
      assert.deepEqual(result, { outcome });
    });
  }

  test("failure injection: a real RPC-call error throws RecurringSeriesReplenishmentRpcError, preserving the original as .cause", async () => {
    resetFixtures({ quarantine_recurring_series_for_replenishment: [{ error: { message: "simulated rpc failure" } }] });
    await assert.rejects(
      () => quarantineRecurringSeriesForReplenishment(callParams()),
      (err: unknown) => {
        assert.ok(err instanceof RecurringSeriesReplenishmentRpcError);
        assert.ok((err as InstanceType<typeof RecurringSeriesReplenishmentRpcError>).cause);
        return true;
      }
    );
  });

  describe("malformed RPC response fails closed", () => {
    const malformedCases: Array<[string, unknown]> = [
      ["null data", null],
      ["a non-string value", { outcome: "quarantined" }],
      ["an unrecognized outcome string", "something_else"],
      ["an empty string", ""],
    ];
    for (const [label, malformed] of malformedCases) {
      test(`${label} throws RecurringSeriesReplenishmentRpcError, never returns a fabricated result`, async () => {
        resetFixtures({ quarantine_recurring_series_for_replenishment: [{ data: malformed }] });
        await assert.rejects(
          () => quarantineRecurringSeriesForReplenishment(callParams()),
          (err: unknown) => err instanceof RecurringSeriesReplenishmentRpcError
        );
      });
    }
  });
});
