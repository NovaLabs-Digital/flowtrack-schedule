// Block 2B + its fail-closed safety correction: unit tests for
// lib/recurringSeries.ts. evaluateSeriesConsistency is pure and tested
// directly; every Supabase-touching helper uses the same in-process fake
// Supabase client as every other route-level test (lib/testSupport.ts),
// including explicit failure-injection coverage proving each compare-and-set
// primitive throws RecurringSeriesRegistryError (never swallows) on a real
// database failure, and returns a plain boolean/array on a merely-no-op
// (row not in the expected starting status) result. Run with
// --experimental-test-module-mocks.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

const {
  RecurringSeriesRegistryError,
  RECURRING_SERIES_REVIEW_WARNING,
  evaluateSeriesConsistency,
  insertQuarantinedSeries,
  quarantineActiveSeries,
  quarantineIfObservedActive,
  quarantineActiveSeriesForClient,
  finalizeSeriesStopped,
  finalizeStoppedSeriesByIds,
  finalizeSeriesActive,
  fetchSeriesById,
  fetchLiveOccurrenceSnapshots,
} = await import("./recurringSeries.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

type OccOverrides = Partial<{
  id: string;
  scheduledFor: string;
  serviceType: string;
  priceCents: number | null;
  durationMinutes: number | null;
  teamColor: string | null;
  employeeIds: string[];
}>;

function occ(overrides: OccOverrides = {}) {
  return {
    id: overrides.id ?? "appt-1",
    scheduledFor: overrides.scheduledFor ?? "2026-06-02T13:00:00.000Z",
    serviceType: overrides.serviceType ?? "Regular Cleaning",
    priceCents: overrides.priceCents === undefined ? 10000 : overrides.priceCents,
    durationMinutes: overrides.durationMinutes === undefined ? 60 : overrides.durationMinutes,
    teamColor: overrides.teamColor === undefined ? null : overrides.teamColor,
    employeeIds: overrides.employeeIds ?? ["emp-1"],
  };
}

describe("evaluateSeriesConsistency -- no live occurrences / bad template", () => {
  test("empty occurrence list is blocked with no_live_occurrences", () => {
    const result = evaluateSeriesConsistency([], "appt-1", "weekly", "America/New_York", null);
    assert.deepEqual(result, { ok: false, blockers: ["no_live_occurrences"] });
  });

  test("a template id not present among the occurrences is blocked with template_not_in_series", () => {
    const result = evaluateSeriesConsistency([occ({ id: "appt-1" })], "appt-does-not-exist", "weekly", "America/New_York", null);
    assert.deepEqual(result, { ok: false, blockers: ["template_not_in_series"] });
  });
});

describe("evaluateSeriesConsistency -- fully consistent series", () => {
  test("a clean weekly series (same time, same weekday, same fields) is ok with timePattern consistent", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-02T13:00:00.000Z" }), // Tue
      occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z" }), // Tue
      occ({ id: "c", scheduledFor: "2026-06-16T13:00:00.000Z" }), // Tue
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.deepEqual(result, { ok: true, timePattern: "consistent" });
  });

  test("employee set order does not matter -- [a,b] and [b,a] are the same set", () => {
    const occurrences = [
      occ({ id: "a", employeeIds: ["emp-1", "emp-2"] }),
      occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", employeeIds: ["emp-2", "emp-1"] }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, true);
  });
});

describe("evaluateSeriesConsistency -- field-level mismatches, each independently detected", () => {
  test("service_type mismatch", () => {
    const occurrences = [occ({ id: "a", serviceType: "Regular" }), occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", serviceType: "Deep Clean" })];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("service_type_mismatch"));
  });

  test("price_cents mismatch, including null vs a real value", () => {
    const occurrences = [occ({ id: "a", priceCents: null }), occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", priceCents: 5000 })];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("price_mismatch"));
  });

  test("duration_minutes mismatch", () => {
    const occurrences = [occ({ id: "a", durationMinutes: 60 }), occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", durationMinutes: 90 })];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("duration_mismatch"));
  });

  test("team_color mismatch", () => {
    const occurrences = [occ({ id: "a", teamColor: "#FF0000" }), occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", teamColor: "#00FF00" })];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("team_color_mismatch"));
  });

  test("employee_set mismatch (different membership, not just order)", () => {
    const occurrences = [occ({ id: "a", employeeIds: ["emp-1"] }), occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", employeeIds: ["emp-2"] })];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("employee_set_mismatch"));
  });

  test("multiple simultaneous blockers are all reported together, not just the first found", () => {
    const occurrences = [
      occ({ id: "a", serviceType: "Regular", priceCents: 100 }),
      occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z", serviceType: "Deep Clean", priceCents: 200 }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.blockers.includes("service_type_mismatch"));
      assert.ok(result.blockers.includes("price_mismatch"));
    }
  });
});

describe("evaluateSeriesConsistency -- business-local time pattern", () => {
  test("the exact legacy pre-Phase-5 DST signature (UTC constant, real offset change, exactly two local times, 60-minute gap) is allowed", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-03-03T14:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-03-10T14:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.deepEqual(result, { ok: true, timePattern: "legacy_dst_signature" });
  });

  test("a clean 60-minute local difference with NO real offset change (not a DST crossing) is blocked, not silently allowed", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-04-07T13:00:00.000Z" }), // 9:00 AM EDT
      occ({ id: "b", scheduledFor: "2026-04-14T14:00:00.000Z" }), // 10:00 AM EDT
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.blockers, ["time_pattern_unexplained"]);
  });

  test("more than two distinct local times is blocked, never treated as a DST signature", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-02T13:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-06-09T14:00:00.000Z" }),
      occ({ id: "c", scheduledFor: "2026-06-16T15:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.blockers, ["time_pattern_unexplained"]);
  });
});

describe("evaluateSeriesConsistency -- frequency-specific weekday/day rules", () => {
  test("daily: multiple weekdays are legitimately expected, never flagged", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-02T13:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-06-03T13:00:00.000Z" }),
      occ({ id: "c", scheduledFor: "2026-06-04T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "daily", "America/New_York", null);
    assert.equal(result.ok, true);
  });

  test("weekdays: every occurrence on Mon-Fri passes", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-01T13:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-06-05T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekdays", "America/New_York", null);
    assert.equal(result.ok, true);
  });

  test("weekdays: a Saturday/Sunday occurrence is blocked", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-01T13:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-06-06T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekdays", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("weekend_occurrence_in_weekdays_series"));
  });

  test("weekly: exactly one distinct local weekday passes", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-02T13:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-06-09T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, true);
  });

  test("weekly: more than one distinct local weekday is blocked", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-06-02T13:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-06-10T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "weekly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("weekly_weekday_pattern_inconsistent"));
  });

  test("monthly: clamped day-of-month progression (Jan 31 -> Feb 28 -> Mar 31) is valid", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-01-31T14:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-02-28T14:00:00.000Z" }),
      occ({ id: "c", scheduledFor: "2026-03-31T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "monthly", "America/New_York", 1);
    assert.equal(result.ok, true);
  });

  test("monthly: a day-of-month that does not match the clamped expectation is blocked", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-01-31T14:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-02-27T14:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "monthly", "America/New_York", 1);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("monthly_progression_invalid"));
  });

  test("monthly: a month-distance not divisible by repeat_months is blocked", () => {
    const occurrences = [
      occ({ id: "a", scheduledFor: "2026-01-15T14:00:00.000Z" }),
      occ({ id: "b", scheduledFor: "2026-03-15T13:00:00.000Z" }),
    ];
    const result = evaluateSeriesConsistency(occurrences, "a", "monthly", "America/New_York", 3);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.blockers.includes("monthly_progression_invalid"));
  });

  test("monthly: a null repeat_months is blocked outright", () => {
    const occurrences = [occ({ id: "a", scheduledFor: "2026-01-15T14:00:00.000Z" })];
    const result = evaluateSeriesConsistency(occurrences, "a", "monthly", "America/New_York", null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.blockers, ["monthly_progression_invalid"]);
  });
});

describe("RECURRING_SERIES_REVIEW_WARNING -- the structured, non-sensitive warning contract", () => {
  test("carries a stable code and a message with no database/table vocabulary", () => {
    assert.equal(RECURRING_SERIES_REVIEW_WARNING.code, "recurring_series_review_required");
    for (const forbidden of ["recurring_series", "SQL", "database", "Supabase", "constraint", "null"]) {
      assert.ok(!RECURRING_SERIES_REVIEW_WARNING.message.includes(forbidden));
    }
  });
});

describe("insertQuarantinedSeries -- always inserts review_required, never active", () => {
  test("inserts with the exact expected shape: review_required, no template, reviewed_at null", async () => {
    resetFixtures({ recurring_series: [{ data: null }] });
    await insertQuarantinedSeries({
      seriesId: "series-1",
      workspaceId: "ws-1",
      clientId: "client-1",
      isDemo: false,
      frequencyType: "weekly",
      repeatWeeks: 1,
      repeatMonths: null,
      scheduledForIso: "2026-06-02T13:00:00.000Z",
      timezone: "America/New_York",
    });
    const insertCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "insert");
    assert.ok(insertCall);
    const row = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(row.id, "series-1");
    assert.equal(row.status, "review_required");
    assert.equal(row.source, "owner_created");
    assert.equal(row.template_appointment_id, null);
    assert.equal(row.reviewed_at, null);
    assert.equal(row.anchor_local_date, "2026-06-02");
    assert.equal(row.anchor_local_time, "09:00");
    assert.equal(row.anchor_timezone, "America/New_York");
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError, never swallowed", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "insert failed" } }] });
    await assert.rejects(
      () =>
        insertQuarantinedSeries({
          seriesId: "series-1",
          workspaceId: "ws-1",
          clientId: "client-1",
          isDemo: false,
          frequencyType: "weekly",
          repeatWeeks: 1,
          repeatMonths: null,
          scheduledForIso: "2026-06-02T13:00:00.000Z",
          timezone: "America/New_York",
        }),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("quarantineActiveSeries -- active -> review_required compare-and-set", () => {
  test("returns true and issues the compare-and-set update when a row transitions", async () => {
    resetFixtures({ recurring_series: [{ data: [{ id: "series-1" }] }] });
    const transitioned = await quarantineActiveSeries("series-1", "ws-1");
    assert.equal(transitioned, true);
    const updateCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "update");
    const patch = updateCall!.args[0] as Record<string, unknown>;
    assert.equal(patch.status, "review_required");
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "id" && (c.args as unknown[])[1] === "series-1"));
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "workspace_id" && (c.args as unknown[])[1] === "ws-1"));
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "status" && (c.args as unknown[])[1] === "active"));
  });

  test("a no-op (row wasn't active) returns false, not an error", async () => {
    resetFixtures({ recurring_series: [{ data: [] }] });
    const transitioned = await quarantineActiveSeries("series-1", "ws-1");
    assert.equal(transitioned, false);
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError -- the caller must abort before any appointment mutation", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "update failed" } }] });
    await assert.rejects(
      () => quarantineActiveSeries("series-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("quarantineIfObservedActive -- observe-first compare-and-set, distinguishing a safe no-op from a real conflict", () => {
  test("observed active + successful CAS -> outcome 'quarantined'", async () => {
    resetFixtures({
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // fetchSeriesById (observe)
        { data: [{ id: "series-1" }] }, // compare-and-set active -> review_required
      ],
    });
    const result = await quarantineIfObservedActive("series-1", "ws-1");
    assert.deepEqual(result, { outcome: "quarantined" });
    const updateCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal((updateCall!.args[0] as Record<string, unknown>).status, "review_required");
  });

  test("observed missing/stopped/review_required -> outcome 'not_active', with NO compare-and-set attempted at all", async () => {
    for (const observedStatus of [null, "stopped", "review_required"]) {
      resetFixtures({
        recurring_series: [{ data: observedStatus === null ? null : { id: "series-1", status: observedStatus } }],
      });
      const result = await quarantineIfObservedActive("series-1", "ws-1");
      assert.deepEqual(result, { outcome: "not_active" }, `observedStatus=${observedStatus}`);
      assert.equal(
        currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update").length,
        0,
        `observedStatus=${observedStatus} must never attempt a write`
      );
    }
  });

  test("observed active, but the CAS matches zero rows (concurrent change) -> outcome 'conflict', never silently proceeds", async () => {
    resetFixtures({
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observed active
        { data: [] }, // but the CAS itself finds nothing left to transition -- raced
      ],
    });
    const result = await quarantineIfObservedActive("series-1", "ws-1");
    assert.deepEqual(result, { outcome: "conflict" });
  });

  test("failure injection: a database error during the observe read throws, never returns a fabricated outcome", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "read failed" } }] });
    await assert.rejects(
      () => quarantineIfObservedActive("series-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });

  test("failure injection: a database error during the compare-and-set throws, never returns a fabricated outcome", async () => {
    resetFixtures({
      recurring_series: [{ data: { id: "series-1", status: "active" } }, { error: { message: "update failed" } }],
    });
    await assert.rejects(
      () => quarantineIfObservedActive("series-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("quarantineActiveSeriesForClient -- bulk, returns the exact ids transitioned", () => {
  test("returns the ids from the update's own result set", async () => {
    resetFixtures({ recurring_series: [{ data: [{ id: "series-1" }, { id: "series-2" }] }] });
    const ids = await quarantineActiveSeriesForClient("client-1", "ws-1");
    assert.deepEqual(ids, ["series-1", "series-2"]);
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "client_id" && (c.args as unknown[])[1] === "client-1"));
  });

  test("returns an empty array when nothing was active, not an error", async () => {
    resetFixtures({ recurring_series: [{ data: [] }] });
    const ids = await quarantineActiveSeriesForClient("client-1", "ws-1");
    assert.deepEqual(ids, []);
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError -- archival must abort before the client is archived", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "update failed" } }] });
    await assert.rejects(
      () => quarantineActiveSeriesForClient("client-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("finalizeSeriesStopped -- review_required -> stopped compare-and-set", () => {
  test("returns true and sets stopped_at when a row transitions", async () => {
    resetFixtures({ recurring_series: [{ data: [{ id: "series-1" }] }] });
    const transitioned = await finalizeSeriesStopped("series-1", "ws-1");
    assert.equal(transitioned, true);
    const updateCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "update");
    const patch = updateCall!.args[0] as Record<string, unknown>;
    assert.equal(patch.status, "stopped");
    assert.ok(patch.stopped_at);
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "status" && (c.args as unknown[])[1] === "review_required"));
  });

  test("a no-op (row wasn't review_required) returns false, not an error -- e.g. nothing was ever quarantined", async () => {
    resetFixtures({ recurring_series: [{ data: [] }] });
    const transitioned = await finalizeSeriesStopped("series-1", "ws-1");
    assert.equal(transitioned, false);
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError -- the series stays review_required, never silently active", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "update failed" } }] });
    await assert.rejects(
      () => finalizeSeriesStopped("series-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("finalizeStoppedSeriesByIds -- bulk, scoped to an exact id set, returns exactly which ids transitioned", () => {
  test("no-ops with zero calls when given an empty id list", async () => {
    resetFixtures({});
    const finalized = await finalizeStoppedSeriesByIds([], "ws-1");
    assert.deepEqual(finalized, []);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });

  test("issues one scoped update for a non-empty id list and returns every id that transitioned", async () => {
    resetFixtures({ recurring_series: [{ data: [{ id: "series-1" }, { id: "series-2" }] }] });
    const finalized = await finalizeStoppedSeriesByIds(["series-1", "series-2"], "ws-1");
    assert.deepEqual(finalized, ["series-1", "series-2"]);
    const updateCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "update");
    assert.ok(updateCall);
    const inCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "in");
    assert.deepEqual(inCall!.args, ["id", ["series-1", "series-2"]]);
  });

  test("a concurrently-changed id is simply excluded from the result -- never forced through, never silently reported as fully finalized", async () => {
    resetFixtures({ recurring_series: [{ data: [{ id: "series-1" }] }] }); // only series-1 still matched review_required
    const finalized = await finalizeStoppedSeriesByIds(["series-1", "series-2"], "ws-1");
    assert.deepEqual(finalized, ["series-1"]);
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "update failed" } }] });
    await assert.rejects(
      () => finalizeStoppedSeriesByIds(["series-1"], "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("finalizeSeriesActive -- review_required -> active compare-and-set, the ONLY path to active", () => {
  function callParams(overrides: Record<string, unknown> = {}) {
    return {
      seriesId: "series-1",
      workspaceId: "ws-1",
      clientId: "client-1",
      templateAppointmentId: "appt-1",
      scheduledForIso: "2026-06-02T13:00:00.000Z",
      timezone: "America/New_York",
      ...overrides,
    };
  }
  function activeClient(overrides: Record<string, unknown> = {}) {
    return { id: "client-1", status: "active", archived_at: null, ...overrides };
  }

  test("sets template/anchor/reviewed_at/status together and returns outcome 'activated' when the client is active", async () => {
    resetFixtures({
      clients: [{ data: activeClient() }],
      recurring_series: [{ data: [{ id: "series-1" }] }],
    });
    const result = await finalizeSeriesActive(callParams());
    assert.deepEqual(result, { outcome: "activated" });
    const updateCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "update");
    const patch = updateCall!.args[0] as Record<string, unknown>;
    assert.equal(patch.status, "active");
    assert.equal(patch.template_appointment_id, "appt-1");
    assert.equal(patch.anchor_local_date, "2026-06-02");
    assert.equal(patch.anchor_local_time, "09:00");
    assert.ok(patch.reviewed_at);
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "status" && (c.args as unknown[])[1] === "review_required"));
  });

  test("a no-op (row wasn't review_required -- already active, already stopped, or claimed by a concurrent request) returns outcome 'conflict', not an error", async () => {
    resetFixtures({ clients: [{ data: activeClient() }], recurring_series: [{ data: [] }] });
    const result = await finalizeSeriesActive(callParams());
    assert.deepEqual(result, { outcome: "conflict" });
  });

  test("race: the client became inactive concurrently -- outcome 'client_not_active', no compare-and-set write attempted at all", async () => {
    resetFixtures({ clients: [{ data: { id: "client-1", status: "inactive", archived_at: null } }] });
    const result = await finalizeSeriesActive(callParams());
    assert.deepEqual(result, { outcome: "client_not_active" });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });

  test("race: the client became archived concurrently -- outcome 'client_not_active', regardless of its status field", async () => {
    resetFixtures({ clients: [{ data: { id: "client-1", status: "active", archived_at: "2026-08-10T00:00:00.000Z" } }] });
    const result = await finalizeSeriesActive(callParams());
    assert.deepEqual(result, { outcome: "client_not_active" });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });

  test("the client no longer exists at all -- outcome 'client_not_active', fails closed rather than assuming eligibility", async () => {
    resetFixtures({ clients: [{ data: null }] });
    const result = await finalizeSeriesActive(callParams());
    assert.deepEqual(result, { outcome: "client_not_active" });
  });

  test("the client check is scoped by both client_id and workspace_id", async () => {
    resetFixtures({ clients: [{ data: activeClient() }], recurring_series: [{ data: [{ id: "series-1" }] }] });
    await finalizeSeriesActive(callParams({ clientId: "client-check" }));
    const eqCalls = currentFake.calls.filter((c) => c.table === "clients" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "id" && (c.args as unknown[])[1] === "client-check"));
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "workspace_id" && (c.args as unknown[])[1] === "ws-1"));
  });

  test("failure injection: a database error reading the client throws RecurringSeriesRegistryError -- the series stays review_required, never silently active", async () => {
    resetFixtures({ clients: [{ error: { message: "client read failed" } }] });
    await assert.rejects(
      () => finalizeSeriesActive(callParams()),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });

  test("failure injection: a database error on the compare-and-set itself throws RecurringSeriesRegistryError -- the series stays review_required, never silently active", async () => {
    resetFixtures({ clients: [{ data: activeClient() }], recurring_series: [{ error: { message: "update failed" } }] });
    await assert.rejects(
      () => finalizeSeriesActive(callParams()),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("fetchSeriesById -- workspace-scoped lookup", () => {
  test("returns the row when found", async () => {
    resetFixtures({ recurring_series: [{ data: { id: "series-1", status: "review_required" } }] });
    const row = await fetchSeriesById("series-1", "ws-1");
    assert.equal(row?.id, "series-1");
  });

  test("returns null when not found", async () => {
    resetFixtures({ recurring_series: [{ data: null }] });
    const row = await fetchSeriesById("series-none", "ws-1");
    assert.equal(row, null);
  });

  test("the query is scoped by both id and workspace_id", async () => {
    resetFixtures({ recurring_series: [{ data: null }] });
    await fetchSeriesById("series-1", "ws-check");
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "workspace_id" && (c.args as unknown[])[1] === "ws-check"));
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError", async () => {
    resetFixtures({ recurring_series: [{ error: { message: "select failed" } }] });
    await assert.rejects(
      () => fetchSeriesById("series-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});

describe("fetchLiveOccurrenceSnapshots -- the shared read both activation and This & Future re-validation use", () => {
  test("shapes each row with its assignment set", async () => {
    resetFixtures({
      appointments: [
        {
          data: [
            { id: "appt-1", scheduled_for: "2026-06-02T13:00:00.000Z", service_type: "Regular Cleaning", price_cents: 10000, duration_minutes: 60, team_color: null },
          ],
        },
      ],
      appointment_employees: [{ data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "emp-1", actual_started_at: null, actual_completed_at: null, created_at: "", updated_at: "" }] }],
    });
    const snapshots = await fetchLiveOccurrenceSnapshots("series-1", "ws-1");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].id, "appt-1");
    assert.deepEqual(snapshots[0].employeeIds, ["emp-1"]);
  });

  test("returns an empty array when there are no live occurrences, without calling appointment_employees", async () => {
    resetFixtures({ appointments: [{ data: [] }] });
    const snapshots = await fetchLiveOccurrenceSnapshots("series-1", "ws-1");
    assert.deepEqual(snapshots, []);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointment_employees"), []);
  });

  test("failure injection: a database error throws RecurringSeriesRegistryError", async () => {
    resetFixtures({ appointments: [{ error: { message: "select failed" } }] });
    await assert.rejects(
      () => fetchLiveOccurrenceSnapshots("series-1", "ws-1"),
      (err: unknown) => err instanceof RecurringSeriesRegistryError
    );
  });
});
