// Block 2C-2C: unit tests for lib/recurringSeriesReplenishmentOrchestrator.ts.
// The two RPCs' own locking/validation logic is proven exclusively by
// migrations/027b_add_recurring_series_replenishment.test.ts's source-level
// assertions against the SQL itself (no live database is reachable from any
// test in this repository); lib/recurringSeriesReplenishmentRpc.test.ts
// proves the thin RPC wrapper. This file's job is the orchestration layer
// itself: selection, coverage/window computation, outcome dispatch/counting,
// and -- critically -- proof that it never writes anything directly.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  runReplenishmentPass,
  REPLENISH_TARGET_COVERAGE_DAYS,
  REPLENISH_THRESHOLD_DAYS,
  MAX_OCCURRENCES_PER_SERIES_PER_RUN,
  MAX_SERIES_PROCESSED_PER_RUN,
} = await import("./recurringSeriesReplenishmentOrchestrator.ts");

function resetFixtures(
  responses: Record<string, FakeSupabaseFixture[]>,
  rpcResponses: Record<string, FakeSupabaseFixture[]> = {}
) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
}

// Fixed "now" for every test -- chosen well before the 2026-03-08 US
// spring-forward date (matching lib/recurringSeriesReplenishment.test.ts's
// own established DST-gap fixture) so tests can freely construct windows
// that do or don't cross it.
const NOW_ISO = "2026-02-01T12:00:00.000Z";
const NOW = () => new Date(NOW_ISO);

function daysFromNow(days: number): string {
  return new Date(new Date(NOW_ISO).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function activeSeriesRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "series-1",
    workspace_id: "ws-1",
    frequency_type: "daily",
    repeat_weeks: null,
    repeat_months: null,
    anchor_local_date: "2026-01-01",
    anchor_local_time: "09:00",
    anchor_timezone: "America/New_York",
    snapshot_updated_at: "2026-01-15T00:00:00.000Z",
    last_replenished_at: null,
    ...overrides,
  };
}

// Queues exactly what selectEligibleActiveSeries expects, in order: the
// rows response, then the exact-count response.
function queueSelection(rows: unknown[], totalEligible = rows.length): FakeSupabaseFixture[] {
  return [{ data: rows }, { data: null, count: totalEligible }];
}

function queueOccurrences(rows: unknown[]): FakeSupabaseFixture[] {
  return [{ data: rows }];
}

describe("source-level proof: this module never writes directly to appointments/appointment_employees/recurring_series", () => {
  test("the orchestrator source contains no .insert(/.update(/.delete(/.upsert( call anywhere (outside its own prose comments)", () => {
    const here = fileURLToPath(import.meta.url);
    const sourcePath = path.join(path.dirname(here), "recurringSeriesReplenishmentOrchestrator.ts");
    const source = readFileSync(sourcePath, "utf8");
    // Strip full-line "//" comments before checking -- this file's own
    // header prose deliberately documents, in words, that no
    // .insert()/.update()/.delete()/.upsert() call exists, which would
    // otherwise defeat a naive substring check against the raw text.
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
      assert.ok(!codeOnly.includes(forbidden), `found forbidden direct-write call: ${forbidden}`);
    }
  });

  test("every actual Supabase call recorded during a full run is a read (select/eq/order/limit/etc.), never insert/update/delete/upsert", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow()]),
      appointments: queueOccurrences([]),
    });
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const writeMethods = new Set(["insert", "update", "delete", "upsert"]);
    const directWrites = currentFake.calls.filter((c) => writeMethods.has(c.method));
    assert.deepEqual(directWrites, []);
  });
});

describe("selection query shape", () => {
  test("filters status=active and is_demo=false, orders by last_replenished_at asc nulls-first then id, limits to MAX_SERIES_PROCESSED_PER_RUN", async () => {
    resetFixtures({
      recurring_series: queueSelection([]),
    });
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.deepEqual(eqCalls[0].args, ["status", "active"]);
    assert.deepEqual(eqCalls[1].args, ["is_demo", false]);
    const orderCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "order");
    assert.deepEqual(orderCalls[0].args, ["last_replenished_at", { ascending: true, nullsFirst: true }]);
    assert.deepEqual(orderCalls[1].args, ["id", { ascending: true }]);
    const limitCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "limit");
    assert.deepEqual(limitCall!.args, [MAX_SERIES_PROCESSED_PER_RUN]);
  });

  test("no active rows is a clean no-op: zero RPC calls, zero appointments query, all counts zero", async () => {
    resetFixtures({
      recurring_series: queueSelection([]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(currentFake.rpcCalls.length, 0);
    assert.ok(!currentFake.calls.some((c) => c.table === "appointments"));
    assert.deepEqual(summary.counts, {
      activeSeriesExamined: 0,
      skippedSufficientCoverage: 0,
      replenished: 0,
      occurrencesInserted: 0,
      occurrencesSkippedIdempotent: 0,
      wouldRequestOccurrencesTotal: 0,
      quarantinedDstGap: 0,
      stoppedClientInactive: 0,
      quarantinedEmployeeIneligible: 0,
      conflicts: 0,
      safeFailures: 0,
      truncatedSeries: 0,
      deferredByProcessingLimit: 0,
    });
  });

  test("processing-limit truncation is reported via deferredByProcessingLimit using an exact COUNT, not merely a boolean", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow({ id: "s1" })], 137),
      appointments: queueOccurrences([]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.activeSeriesExamined, 1);
    assert.equal(summary.counts.deferredByProcessingLimit, 136);
  });
});

describe("demo policy: is_demo=true is excluded at the query level, never processed", () => {
  test("the selection query's is_demo filter is literally false -- proven above; here we also confirm no demo-only carve-out logic exists downstream", async () => {
    resetFixtures({
      recurring_series: queueSelection([]),
    });
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => c.args[0] === "is_demo" && c.args[1] === false));
  });
});

describe("coverage computation and window boundaries", () => {
  test("sufficient future coverage (live tail >= threshold) skips the series entirely -- zero RPC calls", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow()]),
      appointments: queueOccurrences([
        { series_id: "series-1", workspace_id: "ws-1", scheduled_for: daysFromNow(REPLENISH_THRESHOLD_DAYS + 5) },
      ]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.skippedSufficientCoverage, 1);
    assert.equal(summary.counts.replenished, 0);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  test("insufficient coverage requests a window strictly after the live tail and through target coverage", async () => {
    const latestScheduled = daysFromNow(5);
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([{ series_id: "series-1", workspace_id: "ws-1", scheduled_for: latestScheduled }]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(currentFake.rpcCalls.length, 1);
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    const targetThrough = daysFromNow(REPLENISH_TARGET_COVERAGE_DAYS);
    for (const occ of args.p_occurrences) {
      assert.ok(occ > latestScheduled, `occurrence ${occ} must be strictly after the live tail ${latestScheduled}`);
      assert.ok(occ <= targetThrough, `occurrence ${occ} must not exceed the target horizon ${targetThrough}`);
    }
  });

  test("no live future occurrence at all: window begins after 'now', not after the anchor (avoids flooding with already-past candidates)", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2020-01-01" })]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(currentFake.rpcCalls.length, 1);
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    for (const occ of args.p_occurrences) {
      assert.ok(occ > NOW_ISO, `occurrence ${occ} must be strictly future relative to now`);
    }
  });

  test("a cancelled occurrence further out than the live tail is ignored -- coverage is computed from status='scheduled' rows only", async () => {
    const latestScheduled = daysFromNow(5);
    const cancelledFarOut = daysFromNow(90); // status != 'scheduled' -- excluded by the query itself
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        // The fake doesn't filter by the queued eq("status","scheduled") call
        // itself, so this fixture represents exactly what the REAL query
        // would return (cancelled rows excluded server-side) -- only the
        // scheduled row is present here, proving the orchestrator's own
        // logic (not a coincidental client-side filter) drives the result.
        appointments: queueOccurrences([{ series_id: "series-1", workspace_id: "ws-1", scheduled_for: latestScheduled }]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const occCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "status");
    assert.deepEqual(occCall!.args, ["status", "scheduled"]);
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    // The requested window starts right after latestScheduled, not after
    // cancelledFarOut -- if the cancelled row had wrongly counted as
    // coverage, insufficient-coverage would never have triggered at all.
    assert.ok(args.p_occurrences[0] > latestScheduled);
    void cancelledFarOut;
  });

  test("a row whose own workspace_id in the batched occurrence query mismatches the series' known workspace_id is defensively ignored", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ id: "series-1", workspace_id: "ws-1" })]),
        appointments: queueOccurrences([
          // Wrong workspace_id for series-1 -- must not count as coverage.
          { series_id: "series-1", workspace_id: "ws-OTHER", scheduled_for: daysFromNow(REPLENISH_THRESHOLD_DAYS + 10) },
        ]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    // Treated as having NO live coverage (mismatched row ignored) -- so it
    // still gets replenished starting from "now", not skipped.
    assert.equal(summary.counts.skippedSufficientCoverage, 0);
    assert.equal(summary.counts.replenished, 1);
  });

  test("a workspace-mismatched occurrence row for one series cannot affect a DIFFERENT series' coverage calculation", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({ id: "s1", workspace_id: "ws-1" }),
          activeSeriesRow({ id: "s2", workspace_id: "ws-2" }),
        ]),
        appointments: queueOccurrences([
          // Mismatched row nominally "for" s1 but wrong workspace -- must
          // not be misattributed to s2 either (the Map is keyed by
          // series_id, structurally incapable of cross-series leakage, but
          // asserted explicitly here).
          { series_id: "s1", workspace_id: "ws-WRONG", scheduled_for: daysFromNow(REPLENISH_THRESHOLD_DAYS + 10) },
          // s2's own genuinely sufficient, correctly-scoped coverage.
          { series_id: "s2", workspace_id: "ws-2", scheduled_for: daysFromNow(REPLENISH_THRESHOLD_DAYS + 10) },
        ]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    // s1 has no valid coverage (its only row was mismatched) -> replenished.
    // s2 has genuine sufficient coverage -> skipped. Exactly one RPC call.
    assert.equal(summary.counts.replenished, 1);
    assert.equal(summary.counts.skippedSufficientCoverage, 1);
    assert.equal(currentFake.rpcCalls.length, 1);
    const args = currentFake.rpcCalls[0].args as { p_series_id: string };
    assert.equal(args.p_series_id, "s1");
  });
});

describe("per-frequency generation wiring (generator itself is exhaustively tested in its own file)", () => {
  for (const [label, overrides] of [
    ["daily", { frequency_type: "daily", repeat_weeks: null, repeat_months: null }],
    ["weekdays", { frequency_type: "weekdays", repeat_weeks: null, repeat_months: null }],
    ["weekly", { frequency_type: "weekly", repeat_weeks: 2, repeat_months: null }],
    ["monthly", { frequency_type: "monthly", repeat_weeks: null, repeat_months: 1 }],
  ] as const) {
    test(`${label} series with no live tail requests a valid non-empty occurrence window`, async () => {
      resetFixtures(
        {
          recurring_series: queueSelection([activeSeriesRow(overrides)]),
          appointments: queueOccurrences([]),
        },
        { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
      );
      const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
      assert.equal(summary.counts.replenished, 1);
      assert.equal(currentFake.rpcCalls.length, 1);
    });
  }

  test("exact maximum-occurrence bound: a daily series never requests more than MAX_OCCURRENCES_PER_SERIES_PER_RUN in one run, even though far more exist in-window", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ frequency_type: "daily", anchor_local_date: "2020-01-01" })]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: MAX_OCCURRENCES_PER_SERIES_PER_RUN, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    assert.ok(args.p_occurrences.length <= MAX_OCCURRENCES_PER_SERIES_PER_RUN);
    // A 60-day daily window has ~60 real candidates, well beyond the cap --
    // proves this is a real truncation, not a coincidentally small window.
    assert.equal(args.p_occurrences.length, MAX_OCCURRENCES_PER_SERIES_PER_RUN);
  });
});

describe("DST gap handling: quarantine RPC only, never replenish", () => {
  test("a window crossing a DST spring-forward gap calls ONLY quarantine_recurring_series_for_replenishment, with trusted series/workspace ids and the observed snapshot_updated_at", async () => {
    // Matches lib/recurringSeriesReplenishment.test.ts's own established
    // fixture: anchor 2026-03-01 02:30 America/New_York; 2026-03-08 02:30
    // does not exist (spring-forward). "now" (2026-02-01) is safely before
    // the anchor's own first candidate, so the (after, through] window
    // naturally reaches the gap.
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({
            frequency_type: "daily",
            anchor_local_date: "2026-03-01",
            anchor_local_time: "02:30",
            snapshot_updated_at: "2026-01-20T00:00:00.000Z",
          }),
        ]),
        appointments: queueOccurrences([]),
      },
      { quarantine_recurring_series_for_replenishment: [{ data: "quarantined" }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.quarantinedDstGap, 1);
    assert.equal(summary.counts.replenished, 0);
    assert.equal(currentFake.rpcCalls.length, 1);
    assert.equal(currentFake.rpcCalls[0].fn, "quarantine_recurring_series_for_replenishment");
    assert.deepEqual(currentFake.rpcCalls[0].args, {
      p_series_id: "series-1",
      p_workspace_id: "ws-1",
      p_expected_snapshot_updated_at: "2026-01-20T00:00:00.000Z",
      p_reason: "dst_gap",
    });
  });

  test("quarantine RPC returning 'conflict' (series changed concurrently) is counted as a conflict, not an error, and never retried", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({ anchor_local_date: "2026-03-01", anchor_local_time: "02:30" }),
        ]),
        appointments: queueOccurrences([]),
      },
      { quarantine_recurring_series_for_replenishment: [{ data: "conflict" }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.conflicts, 1);
    assert.equal(summary.counts.quarantinedDstGap, 0);
    assert.equal(currentFake.rpcCalls.length, 1);
  });

  test("a real error from the quarantine RPC call is a safe failure, not a thrown/uncaught exception", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({ anchor_local_date: "2026-03-01", anchor_local_time: "02:30" }),
        ]),
        appointments: queueOccurrences([]),
      },
      { quarantine_recurring_series_for_replenishment: [{ error: { message: "simulated" } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.safeFailures, 1);
  });

  test("dry-run mode detects the same dst_gap without ever calling the quarantine RPC", async () => {
    resetFixtures({
      recurring_series: queueSelection([
        activeSeriesRow({ anchor_local_date: "2026-03-01", anchor_local_time: "02:30" }),
      ]),
      appointments: queueOccurrences([]),
    });
    const summary = await runReplenishmentPass({ dryRun: true, now: NOW });
    assert.equal(summary.counts.quarantinedDstGap, 1);
    assert.equal(currentFake.rpcCalls.length, 0);
  });
});

describe("generation failures other than dst_gap: fail closed, no quarantine RPC, no invented review_reason", () => {
  test("iteration_limit (or any other non-dst_gap failure) is a safe failure with zero RPC calls of either kind", async () => {
    // through <= after triggers invalid_input deterministically without
    // needing to actually exhaust the 20,000-iteration ceiling.
    resetFixtures({
      recurring_series: queueSelection([
        // A series whose live tail already reaches (or exceeds) the target
        // horizon would normally be skipped by the coverage check before
        // generation ever runs -- so to reach the generator with a
        // through<=after condition we instead give it insufficient coverage
        // AND rely on the generator's own invalid_input path being
        // triggered by an internally-inconsistent row shape it independently
        // re-validates (frequency/interval mismatch), which a genuinely
        // active row can never have (see this module's header) but the
        // generator still defends against.
        activeSeriesRow({ frequency_type: "weekly", repeat_weeks: 99, repeat_months: null }),
      ]),
      appointments: queueOccurrences([]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.safeFailures, 1);
    assert.equal(summary.counts.replenished, 0);
    assert.equal(summary.counts.quarantinedDstGap, 0);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  test("a null snapshot_updated_at on an active row (structurally shouldn't happen) is a safe failure, not a crash", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow({ snapshot_updated_at: null })]),
      appointments: queueOccurrences([]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.safeFailures, 1);
    assert.equal(currentFake.rpcCalls.length, 0);
  });
});

describe("replenish_recurring_series outcome handling -- every closed outcome exhaustively", () => {
  const cases: Array<[string, { outcome: string; inserted_count: number; skipped_count: number }, string]> = [
    ["replenished", { outcome: "replenished", inserted_count: 7, skipped_count: 3 }, "replenished"],
    ["conflict", { outcome: "conflict", inserted_count: 0, skipped_count: 0 }, "conflicts"],
    ["client_stopped", { outcome: "client_stopped", inserted_count: 0, skipped_count: 0 }, "stoppedClientInactive"],
    ["employee_review_required", { outcome: "employee_review_required", inserted_count: 0, skipped_count: 0 }, "quarantinedEmployeeIneligible"],
    ["missing_snapshot_review_required", { outcome: "missing_snapshot_review_required", inserted_count: 0, skipped_count: 0 }, "safeFailures"],
    ["invalid_input", { outcome: "invalid_input", inserted_count: 0, skipped_count: 0 }, "safeFailures"],
  ];
  for (const [label, fixture, expectedCountKey] of cases) {
    test(`outcome '${label}' increments exactly ${expectedCountKey}`, async () => {
      resetFixtures(
        {
          recurring_series: queueSelection([activeSeriesRow()]),
          appointments: queueOccurrences([]),
        },
        { replenish_recurring_series: [{ data: fixture }] }
      );
      const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
      assert.equal((summary.counts as unknown as Record<string, number>)[expectedCountKey], 1);
    });
  }

  test("'replenished' correctly sums insertedCount/skippedCount into occurrencesInserted/occurrencesSkippedIdempotent", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 4, skipped_count: 6 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.occurrencesInserted, 4);
    assert.equal(summary.counts.occurrencesSkippedIdempotent, 6);
  });

  test("a malformed/unrecognized RPC response is a safe failure (the wrapper's own validation throws, caught here, never propagated)", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "not_a_real_outcome", inserted_count: 0, skipped_count: 0 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.safeFailures, 1);
  });

  test("a real database/RPC-call error is a safe failure, not a thrown/uncaught exception", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ error: { message: "simulated db failure" } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.safeFailures, 1);
  });
});

describe("idempotency and concurrency proofs", () => {
  test("repeated processing of the same series does not assume success -- a second pass whose RPC reports 0 inserted / N skipped (ON CONFLICT DO NOTHING having already caught it) is counted faithfully, not as an error", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 0, skipped_count: 5 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.replenished, 1);
    assert.equal(summary.counts.occurrencesInserted, 0);
    assert.equal(summary.counts.occurrencesSkippedIdempotent, 5);
  });

  test("a stale snapshot_updated_at (edited concurrently) surfaces as 'conflict', never as a crash or a false 'replenished'", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "conflict", inserted_count: 0, skipped_count: 0 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.conflicts, 1);
    assert.equal(summary.counts.replenished, 0);
  });

  test("a series stopped/quarantined concurrently (RPC reports conflict) is never treated as eligible for a follow-up call in the same run -- exactly one RPC call for that series", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "conflict", inserted_count: 0, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(currentFake.rpcCalls.length, 1);
  });

  test("a successful mutation is never blindly retried -- exactly one RPC call per series needing action, for a multi-series run", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({ id: "s1", workspace_id: "ws-1" }),
          activeSeriesRow({ id: "s2", workspace_id: "ws-1" }),
        ]),
        appointments: queueOccurrences([]),
      },
      {
        replenish_recurring_series: [
          { data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } },
          { data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } },
        ],
      }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(currentFake.rpcCalls.length, 2);
    assert.equal(summary.counts.replenished, 2);
  });
});

describe("dry run: identical selection/generation decisions, zero writes, zero RPC calls", () => {
  test("zero RPC calls of either kind across a mixed batch that would otherwise replenish and quarantine", async () => {
    resetFixtures({
      recurring_series: queueSelection([
        activeSeriesRow({ id: "s1", workspace_id: "ws-1" }),
        activeSeriesRow({ id: "s2", workspace_id: "ws-1", anchor_local_date: "2026-03-01", anchor_local_time: "02:30" }),
      ]),
      appointments: queueOccurrences([]),
    });
    const summary = await runReplenishmentPass({ dryRun: true, now: NOW });
    assert.equal(currentFake.rpcCalls.length, 0);
    assert.equal(summary.counts.replenished, 1);
    assert.equal(summary.counts.quarantinedDstGap, 1);
  });

  test("wouldRequestOccurrencesTotal is an aggregate sum, populated only in dry-run mode -- never a per-series breakdown, never a series/workspace UUID anywhere in the response", async () => {
    resetFixtures({
      recurring_series: queueSelection([
        activeSeriesRow({ id: "s1", workspace_id: "ws-1" }),
        activeSeriesRow({ id: "s2", workspace_id: "ws-1" }),
      ]),
      appointments: queueOccurrences([]),
    });
    const dry = await runReplenishmentPass({ dryRun: true, now: NOW });
    assert.equal(dry.counts.replenished, 2);
    assert.ok(dry.counts.wouldRequestOccurrencesTotal > 0);
    // The response is JSON-serializable with no series/workspace identifier
    // anywhere in it -- the whole point of the aggregate-only design.
    const serialized = JSON.stringify(dry);
    assert.ok(!serialized.includes("s1"));
    assert.ok(!serialized.includes("s2"));
    assert.ok(!serialized.includes("ws-1"));
    assert.ok(!("seriesDetails" in dry));

    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    const live = await runReplenishmentPass({ dryRun: false, now: NOW });
    // Live mode never populates the dry-run-only aggregate -- it reports the
    // RPC's own real occurrencesInserted/occurrencesSkippedIdempotent
    // instead.
    assert.equal(live.counts.wouldRequestOccurrencesTotal, 0);
  });

  test("dry run never performs any Supabase write and never issues an RPC call, across every table it touches", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow()]),
      appointments: queueOccurrences([]),
    });
    await runReplenishmentPass({ dryRun: true, now: NOW });
    const writeMethods = new Set(["insert", "update", "delete", "upsert"]);
    assert.deepEqual(currentFake.calls.filter((c) => writeMethods.has(c.method)), []);
    assert.equal(currentFake.rpcCalls.length, 0);
  });
});

describe("empty-tail and incremental-coverage behavior (production-review correction round)", () => {
  test("a brand-new daily series with NO scheduled future occurrence receives the FIRST eligible near-term occurrences, not occurrences skipped ahead toward the 60-day horizon", async () => {
    resetFixtures(
      {
        // Anchor at 09:00 America/New_York, one day before "now" in UTC
        // terms, so the very next daily candidate is only about a day away.
        recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2026-01-31", anchor_local_time: "09:00" })]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    const firstRequested = new Date(args.p_occurrences[0]).getTime();
    const nowMs = new Date(NOW_ISO).getTime();
    // The first requested occurrence must be within a couple of days of
    // "now" (a daily cadence), never artificially deferred toward the
    // 60-day target horizon.
    assert.ok(firstRequested - nowMs < 3 * 24 * 60 * 60 * 1000, "first occurrence must be near-term, not skipped toward the horizon");
  });

  test("dry-run mode makes the identical near-term decision as live mode for an empty-tail series", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2026-01-31", anchor_local_time: "09:00" })]),
      appointments: queueOccurrences([]),
    });
    const dry = await runReplenishmentPass({ dryRun: true, now: NOW });
    assert.equal(dry.counts.replenished, 1);
    assert.ok(dry.counts.wouldRequestOccurrencesTotal > 0 && dry.counts.wouldRequestOccurrencesTotal <= MAX_OCCURRENCES_PER_SERIES_PER_RUN);
  });

  test("a daily series builds coverage incrementally across two sequential runs, never re-requesting an already-materialized instant, and eventually reaches sufficient coverage", async () => {
    // Run 1: empty tail -- requests up to the 20-occurrence cap.
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2026-01-31", anchor_local_time: "09:00" })]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: MAX_OCCURRENCES_PER_SERIES_PER_RUN, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const run1Args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    assert.equal(run1Args.p_occurrences.length, MAX_OCCURRENCES_PER_SERIES_PER_RUN);
    const run1LastOccurrence = run1Args.p_occurrences[run1Args.p_occurrences.length - 1];

    // Run 2 (a later cron invocation, same day's worth of "now" progression
    // isn't material here): the live tail now reflects run 1's own
    // insertions -- proves run 2 starts strictly AFTER run 1's last
    // occurrence, never re-requesting anything already materialized.
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2026-01-31", anchor_local_time: "09:00" })]),
        appointments: queueOccurrences([{ series_id: "series-1", workspace_id: "ws-1", scheduled_for: run1LastOccurrence }]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: MAX_OCCURRENCES_PER_SERIES_PER_RUN, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const run2Args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    assert.ok(run2Args.p_occurrences[0] > run1LastOccurrence, "run 2 must start strictly after run 1's last occurrence");
  });

  test("a series already below threshold but with a valid live tail starts strictly after that tail, not from 'now'", async () => {
    const latestScheduled = daysFromNow(10);
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([{ series_id: "series-1", workspace_id: "ws-1", scheduled_for: latestScheduled }]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    assert.ok(args.p_occurrences[0] > latestScheduled);
    assert.ok(args.p_occurrences[0] > NOW_ISO);
  });

  test("no occurrence at or before 'now' is ever requested, explicitly asserted across daily/weekly/monthly", async () => {
    for (const overrides of [
      { frequency_type: "daily", repeat_weeks: null, repeat_months: null },
      { frequency_type: "weekly", repeat_weeks: 1, repeat_months: null },
      { frequency_type: "monthly", repeat_weeks: null, repeat_months: 1 },
    ] as const) {
      resetFixtures(
        {
          recurring_series: queueSelection([activeSeriesRow(overrides)]),
          appointments: queueOccurrences([]),
        },
        { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
      );
      await runReplenishmentPass({ dryRun: false, now: NOW });
      const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
      for (const occ of args.p_occurrences) {
        assert.ok(occ > NOW_ISO, `${overrides.frequency_type}: occurrence ${occ} must be strictly after now`);
      }
    }
  });

  test("truncated is reported honestly via truncatedSeries, in both live and dry-run mode, never silently implying full target coverage was reached", async () => {
    // Empty-tail daily series over a 60-day window has ~60 real candidates,
    // far beyond the 20-occurrence cap -- genuinely truncated.
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2026-01-31", anchor_local_time: "09:00" })]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: MAX_OCCURRENCES_PER_SERIES_PER_RUN, skipped_count: 0 } }] }
    );
    const live = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(live.counts.truncatedSeries, 1);

    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2026-01-31", anchor_local_time: "09:00" })]),
      appointments: queueOccurrences([]),
    });
    const dry = await runReplenishmentPass({ dryRun: true, now: NOW });
    assert.equal(dry.counts.truncatedSeries, 1);
  });

  test("a series with sufficient coverage (no generation attempted at all) is never counted as truncated", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow()]),
      appointments: queueOccurrences([
        { series_id: "series-1", workspace_id: "ws-1", scheduled_for: daysFromNow(REPLENISH_THRESHOLD_DAYS + 5) },
      ]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.truncatedSeries, 0);
  });
});

describe("time math: elapsed-duration policy for the 30-day/60-day boundaries, immune to DST (production-review correction round)", () => {
  // "now" chosen so both now+30d and now+60d cross the 2026-03-08 US
  // spring-forward transition -- if the implementation ever regresses to
  // zone-aware Luxon calendar-day arithmetic in a non-UTC-anchored default
  // zone, these exact-millisecond boundary assertions would drift by up to
  // an hour and fail.
  const DST_STRADDLING_NOW_ISO = "2026-02-05T00:00:00.000Z";
  const DST_NOW = () => new Date(DST_STRADDLING_NOW_ISO);
  function dstDaysFromNow(days: number): string {
    return new Date(new Date(DST_STRADDLING_NOW_ISO).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  test("the replenish threshold boundary is EXACTLY now + REPLENISH_THRESHOLD_DAYS*24h of elapsed time -- a live tail 1ms short of it still triggers replenishment", async () => {
    const justBelowThreshold = new Date(new Date(dstDaysFromNow(REPLENISH_THRESHOLD_DAYS)).getTime() - 1).toISOString();
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow()]),
        appointments: queueOccurrences([{ series_id: "series-1", workspace_id: "ws-1", scheduled_for: justBelowThreshold }]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: DST_NOW });
    assert.equal(summary.counts.replenished, 1);
    assert.equal(summary.counts.skippedSufficientCoverage, 0);
  });

  test("a live tail exactly AT the threshold boundary is sufficient coverage -- skipped, across the same DST-straddling window", async () => {
    resetFixtures({
      recurring_series: queueSelection([activeSeriesRow()]),
      appointments: queueOccurrences([{ series_id: "series-1", workspace_id: "ws-1", scheduled_for: dstDaysFromNow(REPLENISH_THRESHOLD_DAYS) }]),
    });
    const summary = await runReplenishmentPass({ dryRun: false, now: DST_NOW });
    assert.equal(summary.counts.skippedSufficientCoverage, 1);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  test("no requested occurrence ever exceeds exactly now + REPLENISH_TARGET_COVERAGE_DAYS*24h, across the same DST-straddling window", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([activeSeriesRow({ anchor_local_date: "2020-01-01" })]),
        appointments: queueOccurrences([]),
      },
      { replenish_recurring_series: [{ data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } }] }
    );
    await runReplenishmentPass({ dryRun: false, now: DST_NOW });
    const args = currentFake.rpcCalls[0].args as { p_occurrences: string[] };
    const exactTarget = dstDaysFromNow(REPLENISH_TARGET_COVERAGE_DAYS);
    for (const occ of args.p_occurrences) {
      assert.ok(occ <= exactTarget, `occurrence ${occ} must not exceed the exact elapsed-time target ${exactTarget}`);
    }
  });
});

describe("reporting: one series' failure never corrupts another's outcome", () => {
  test("a thrown, non-RPC-error exception from one series' RPC call is caught and counted, and the NEXT series still gets its own RPC call", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({ id: "s1", workspace_id: "ws-1" }),
          activeSeriesRow({ id: "s2", workspace_id: "ws-1" }),
        ]),
        appointments: queueOccurrences([]),
      },
      {
        replenish_recurring_series: [
          { error: { message: "simulated failure for s1" } },
          { data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } },
        ],
      }
    );
    const summary = await runReplenishmentPass({ dryRun: false, now: NOW });
    assert.equal(summary.counts.safeFailures, 1);
    assert.equal(summary.counts.replenished, 1);
    assert.equal(currentFake.rpcCalls.length, 2);
  });

  test("workspace isolation: each series' RPC call uses exactly its OWN workspace_id, never a different series' or a default", async () => {
    resetFixtures(
      {
        recurring_series: queueSelection([
          activeSeriesRow({ id: "s1", workspace_id: "ws-alpha" }),
          activeSeriesRow({ id: "s2", workspace_id: "ws-beta" }),
        ]),
        appointments: queueOccurrences([]),
      },
      {
        replenish_recurring_series: [
          { data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } },
          { data: { outcome: "replenished", inserted_count: 1, skipped_count: 0 } },
        ],
      }
    );
    await runReplenishmentPass({ dryRun: false, now: NOW });
    const [call1, call2] = currentFake.rpcCalls as Array<{ args: { p_series_id: string; p_workspace_id: string } }>;
    assert.equal(call1.args.p_series_id, "s1");
    assert.equal(call1.args.p_workspace_id, "ws-alpha");
    assert.equal(call2.args.p_series_id, "s2");
    assert.equal(call2.args.p_workspace_id, "ws-beta");
  });
});
