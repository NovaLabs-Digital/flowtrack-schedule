// Unit tests for lib/recurrenceChange.ts (pure: request builder, snapshot
// normalizer, RPC outcome mapper). Executed behavior, no I/O.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { buildRecurrenceChangeRequest, normalizeExpectedSnapshot, mapRecurrenceRpcResult, isUuid, type BuildResult } from "./recurrenceChange.ts";

// assert.ok narrows the union, so these return typed values without casts.
function requestOf(r: BuildResult) { assert.ok(r.ok, "expected a built request"); return r.request; }
function failureOf(r: BuildResult) { assert.ok(!r.ok, "expected a rejection"); return r; }

const EMP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIELDS = {
  scheduled_for: "2026-09-22T13:00:00.000Z", scheduled_end: "2026-09-22T14:00:00.000Z", service_type: " Regular Cleaning ",
  notes: "  bring keys  ", duration_minutes: 60, price_cents: 9000, team_color: null, status: "scheduled",
};
const base = (over: Record<string, unknown> = {}) => ({
  fields: FIELDS, employeeIds: [], frequencyType: "weekly", repeatWeeks: 4, repeatMonths: null, timezone: "America/New_York", ...over,
});

describe("buildRecurrenceChangeRequest", () => {
  test("Izabel: every 4 weeks from Sept 22 2026 9:00 AM New York gives Oct 20 / Nov 17 / Dec 15 at 9:00 AM local across the DST end", () => {
    const r = buildRecurrenceChangeRequest(base());
    assert.ok(r.ok);
    const local = r.request.occurrences.map((i) => DateTime.fromISO(i).setZone("America/New_York"));
    assert.deepEqual(local.slice(0, 3).map((d) => d.toFormat("yyyy-MM-dd h:mm a")), ["2026-10-20 9:00 AM", "2026-11-17 9:00 AM", "2026-12-15 9:00 AM"]);
    assert.ok(local.every((d) => d.toFormat("h:mm a") === "9:00 AM"));
    // the UTC hour genuinely shifts (13:00Z -> 14:00Z) while local time holds
    assert.notEqual(new Date(r.request.occurrences[0]).getUTCHours(), new Date(r.request.occurrences[2]).getUTCHours());
  });

  test("dates are anchored on the REQUESTED start, not on anything previously stored", () => {
    const a = buildRecurrenceChangeRequest(base());
    const b = buildRecurrenceChangeRequest(base({ fields: { ...FIELDS, scheduled_for: "2026-09-29T08:30:00.000Z", scheduled_end: "2026-09-29T09:30:00.000Z" } }));
    assert.ok(a.ok && b.ok);
    assert.notDeepEqual(a.request.occurrences, b.request.occurrences);
    assert.ok(a.request.occurrences.every((o) => new Date(o) > new Date(FIELDS.scheduled_for)));
  });

  test("normalizes text, employees (deduplicated, lowercased, sorted) and instants", () => {
    const r = buildRecurrenceChangeRequest(base({ employeeIds: [EMP_B, EMP_A.toUpperCase(), EMP_A], fields: { ...FIELDS, scheduled_for: "2026-09-22T09:00:00-04:00" } }));
    assert.ok(r.ok);
    assert.deepEqual(r.request.employee_ids, [EMP_A, EMP_B]);
    assert.equal(r.request.fields.scheduled_for, "2026-09-22T13:00:00.000Z");
    assert.equal(r.request.fields.service_type, "Regular Cleaning");
    assert.equal(r.request.fields.notes, "bring keys");
    assert.equal(requestOf(buildRecurrenceChangeRequest(base({ fields: { ...FIELDS, notes: "   " } }))).fields.notes, null);
  });

  test("the same input always produces the identical request (stable operation fingerprint), key order included", () => {
    const one = JSON.stringify(requestOf(buildRecurrenceChangeRequest(base())));
    const two = JSON.stringify(requestOf(buildRecurrenceChangeRequest(base())));
    assert.equal(one, two);
  });

  test("one_time has no occurrences and no interval; weekly/monthly carry only their own interval", () => {
    const one = buildRecurrenceChangeRequest(base({ frequencyType: "one_time" }));
    assert.ok(one.ok);
    assert.deepEqual(one.request.occurrences, []);
    assert.deepEqual(one.request.recurrence, { frequency_type: "one_time", repeat_weeks: null, repeat_months: null });
    const monthly = buildRecurrenceChangeRequest(base({ frequencyType: "monthly", repeatMonths: 12, repeatWeeks: 4 }));
    assert.ok(monthly.ok);
    assert.deepEqual(monthly.request.recurrence, { frequency_type: "monthly", repeat_weeks: null, repeat_months: 12 });
    assert.equal(monthly.request.occurrences.length, 2);
  });

  test("rejects invalid input with a 400 and a clear message", () => {
    const bad = (over: Record<string, unknown>, re: RegExp) => {
      const r = failureOf(buildRecurrenceChangeRequest(base(over)));
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.match(r.error, re);
    };
    bad({ frequencyType: "yearly" }, /Invalid frequency_type/);
    bad({ repeatWeeks: 0 }, /weeks between 1 and 8/);
    bad({ repeatWeeks: 9 }, /weeks between 1 and 8/);
    bad({ frequencyType: "monthly", repeatMonths: 13 }, /months between 1 and 12/);
    bad({ frequencyType: "monthly", repeatMonths: null }, /months between 1 and 12/);
    bad({ fields: null }, /Missing appointment fields/);
    bad({ fields: { ...FIELDS, scheduled_for: "garbage" } }, /scheduled_for/);
    bad({ fields: { ...FIELDS, duration_minutes: 0 } }, /duration_minutes/);
    bad({ fields: { ...FIELDS, price_cents: -5 } }, /price_cents/);
    bad({ fields: { ...FIELDS, service_type: "  " } }, /service_type/);
    bad({ fields: { ...FIELDS, status: "cancelled" } }, /status back to Scheduled/);
    bad({ employeeIds: ["not-a-uuid"] }, /employee_ids/);
  });

  test("a series that would land on a nonexistent DST local time is rejected WHOLE (no partial request)", () => {
    const r = buildRecurrenceChangeRequest(base({
      frequencyType: "weekly", repeatWeeks: 1,
      fields: { ...FIELDS, scheduled_for: "2026-02-22T07:30:00.000Z", scheduled_end: "2026-02-22T08:30:00.000Z" },
    }));
    assert.match(failureOf(r).error, /daylight-saving/);
  });
});

describe("normalizeExpectedSnapshot", () => {
  const good = {
    scheduled_for: "2026-09-29T08:30:00+00:00", scheduled_end: null, service_type: "Regular Cleaning", notes: null, duration_minutes: 60,
    price_cents: 9000, team_color: null, status: "scheduled", series_id: null, frequency_type: null, employee_ids: [EMP_B, EMP_A], timezone: "America/New_York",
  };

  test("canonicalizes instants, employee ids, and a missing frequency to one_time", () => {
    const n = normalizeExpectedSnapshot(good);
    assert.ok(n);
    assert.equal(n.scheduled_for, "2026-09-29T08:30:00.000Z");
    assert.deepEqual(n.employee_ids, [EMP_A, EMP_B]);
    assert.equal(n.frequency_type, "one_time");
  });

  test("returns null for anything malformed rather than guessing", () => {
    for (const bad of [null, "x", {}, { ...good, scheduled_for: "nope" }, { ...good, employee_ids: "x" }, { ...good, employee_ids: ["bad"] },
      { ...good, series_id: "not-a-uuid" }, { ...good, price_cents: 1.5 }, { ...good, timezone: undefined }]) {
      assert.equal(normalizeExpectedSnapshot(bad), null, JSON.stringify(bad));
    }
  });
});

describe("mapRecurrenceRpcResult", () => {
  test("applied maps counts, protected occurrences and the notice; replay is marked", () => {
    const m = mapRecurrenceRpcResult({ outcome: "applied", cancelled_count: 2, created_count: 4, protected_count: 1, protected: [{ id: "x" }], skipped_for_exclusion_count: 1, replayed: true });
    assert.equal(m.status, 200);
    assert.deepEqual(
      { ok: m.body.ok, cancelled: m.body.cancelled, created: m.body.created, protectedOccurrences: m.body.protectedOccurrences, alreadyApplied: m.body.alreadyApplied },
      { ok: true, cancelled: 2, created: 4, protectedOccurrences: 1, alreadyApplied: true });
    assert.match((m.body.notice as { message: string }).message, /1 occurrence with recorded work was kept/);
  });

  test("every non-applied outcome maps to a non-success status and never leaks internal detail", () => {
    for (const outcome of ["operation_id_conflict", "stale_snapshot", "state_changed", "appointment_is_historical", "assignment_removal_blocked",
      "employee_not_eligible", "client_not_active", "rolled_back", "appointment_not_found", "invalid_input", "anything-else", undefined]) {
      const m = mapRecurrenceRpcResult({ outcome, reason: "SECRET_INTERNAL", detail: "SECRET_INTERNAL" });
      assert.ok(m.status >= 400, String(outcome));
      assert.notEqual(m.body.ok, true);
      assert.ok(!JSON.stringify(m.body).includes("SECRET_INTERNAL"), String(outcome));
    }
    assert.equal(mapRecurrenceRpcResult(null).status, 500);
  });
});

test("isUuid accepts canonical UUIDs only", () => {
  assert.ok(isUuid("11111111-1111-4111-8111-111111111111"));
  assert.ok(!isUuid("11111111111141118111111111111111"));
  assert.ok(!isUuid(""));
  assert.ok(!isUuid(42));
});
