// Block 2C-2C: the orchestration layer connecting Block 2C-2A's pure
// generator (lib/recurringSeriesReplenishment.ts) and Block 2C-2B's atomic
// RPCs (lib/recurringSeriesReplenishmentRpc.ts) to a bounded, repeatable
// per-invocation "top up the rolling buffer" pass. This module has no HTTP
// concerns (auth, request parsing, response shaping) at all -- that is
// app/api/cron/replenish-recurring-series/route.ts's job, kept separate so
// this file is directly unit-testable the same way lib/reconcileSubscriptions.ts's
// reconcileRows already is.
//
// This module NEVER writes to appointments, appointment_employees, or
// recurring_series directly. Every mutation goes through exactly one of the
// two deployed RPCs (replenishRecurringSeries, quarantineRecurringSeriesForReplenishment).
// The only writes this file's own Supabase calls ever perform are none --
// every .from("recurring_series")/.from("appointments") call here is a
// .select(), never .insert()/.update()/.delete()/.upsert(). See this file's
// own test suite for a source-level proof of that claim.
import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateOccurrencesInWindow } from "@/lib/recurringSeriesReplenishment";
import {
  replenishRecurringSeries,
  quarantineRecurringSeriesForReplenishment,
  RecurringSeriesReplenishmentRpcError,
} from "@/lib/recurringSeriesReplenishmentRpc";
import type { RecurringFrequency } from "@/lib/recurringSeries";
// Block 2C-2F: the ONE source of truth for "is this workspace currently
// allowed to have operational data mutated," already used everywhere else in
// this app (route/session enforcement in lib/entitlementServer.ts itself).
// No billing rule of any kind is reimplemented here -- this module only ever
// consumes fetchEntitlementForWorkspace's own resolved
// EntitlementResult.canMutateOperationalData, exactly as every other caller
// does. Injectable (see RunReplenishmentPassOptions.fetchEntitlement below)
// purely for testability, matching this file's own existing `now?`
// convention and lib/entitlementServer.ts's own EntitlementFetcher pattern
// -- every real invocation omits the override and gets this true default.
import { fetchEntitlementForWorkspace } from "@/lib/entitlementServer";
import { fetchAllPages, fetchAllPagesChunkedIn } from "@/lib/paginate";
import type { EntitlementResult } from "@/lib/entitlement";

type EntitlementFetcherFn = (workspaceId: string) => Promise<EntitlementResult>;

// ============================================================================
// Rolling-horizon policy -- named constants, centrally encoded, per the
// approved plan. See the accompanying implementation report ("Selected
// rolling-horizon and threshold values") for the full justification; summary:
// ============================================================================
//
// REPLENISH_TARGET_COVERAGE_DAYS: how far into the future a series' live
// (status='scheduled') tail should reach once this pass finishes acting on
// it. Deliberately much smaller than the one-time creation horizons in
// lib/recurrence.ts (182 days for daily/weekdays/weekly, 24 months for
// monthly) -- this is a ROLLING top-up, not a re-materialization of the
// full original horizon on every run.
export const REPLENISH_TARGET_COVERAGE_DAYS = 60;

// REPLENISH_THRESHOLD_DAYS: once a series' live tail drops below this many
// days ahead of "now", it becomes eligible for replenishment this run.
// Chosen well below REPLENISH_TARGET_COVERAGE_DAYS (30 vs 60) so a single
// daily cron cadence -- which only lets the buffer shrink by ~1 day between
// runs -- can never let a series run dry; also matches the existing
// "expiresWithin30Days" 30-day urgency threshold app/api/recurring-series/route.ts's
// GET already uses for the owner review queue, so "30 days out" is already
// an established meaningful boundary in this product, not a new invented one.
export const REPLENISH_THRESHOLD_DAYS = 30;

// MAX_OCCURRENCES_PER_SERIES_PER_RUN: the number of occurrences requested
// for one series in one run. Set to exactly 20 -- migrations/027b's
// replenish_recurring_series itself hard-rejects cardinality(p_occurrences)
// > 20 as invalid_input, so this uses the RPC's full per-call capacity
// rather than an arbitrary smaller number. A series needing more than 20
// occurrences to reach full target coverage (e.g. a freshly activated daily
// series with zero live tail, needing up to 60) is simply topped up
// incrementally over several runs -- self-correcting, and exactly the
// "maintain a buffer, don't re-materialize the whole horizon at once"
// behavior requested.
export const MAX_OCCURRENCES_PER_SERIES_PER_RUN = 20;

// MAX_SERIES_PROCESSED_PER_RUN: a hard safety cap on how many series may
// reach a mutation decision (generation + entitlement + RPC) in one run.
// The real bound is RUN_TIME_BUDGET_MS below; this cap only stops a
// runaway run. Series past either bound are counted in
// deferredByProcessingLimit and stay the most urgent for the next run.
//
// History: this used to be 100 series SELECTED per run, ordered by
// last_replenished_at. Series skipped for sufficient coverage never advance
// last_replenished_at, so once more than 100 active series existed across
// all workspaces, the same 100 were selected every run and every later
// series was never examined (capacity report D2). Selection is now
// need-based: every active series' coverage is read, and only the series
// that actually need a top-up are processed, most urgent first.
export const MAX_SERIES_PROCESSED_PER_RUN = 500;

// RUN_TIME_BUDGET_MS: wall-clock budget for one run, leaving headroom under
// the route's maxDuration = 60s. Checked before each coverage read and
// before each series is processed; never interrupts a series mid-RPC.
export const RUN_TIME_BUDGET_MS = 45_000;

// COVERAGE_READ_CONCURRENCY: how many per-series coverage reads run at
// once. Each is one indexed lookup (idx_appointments_series_occurrence).
export const COVERAGE_READ_CONCURRENCY = 8;

// Bounded retries. A series whose processing fails (safe_failure or
// generation_failed) is recorded in rate_limit_counters under
// "replenish-failure:<seriesId>" via the existing atomic
// record_rate_limit_attempt RPC (migrations/017). Series with a failure
// record are processed only after every healthy series in the same run;
// after FAILURE_MAX_ATTEMPTS failures within FAILURE_WINDOW_SECONDS the
// series is skipped (backedOffAfterFailures) until FAILURE_LOCKOUT_SECONDS
// have passed. A success clears the record. Dry runs never write records.
// Conflicts are not failures (they mean another writer got there first).
export const FAILURE_BUCKET_PREFIX = "replenish-failure:";
export const FAILURE_WINDOW_SECONDS = 14 * 24 * 60 * 60;
export const FAILURE_MAX_ATTEMPTS = 3;
export const FAILURE_LOCKOUT_SECONDS = 3 * 24 * 60 * 60;

// ============================================================================
// Types
// ============================================================================

// Production-review correction: an earlier draft additionally returned a
// per-series `seriesDetails` array (seriesId, workspaceId, outcome,
// requested-occurrence count) for dry-run responses. Removed outright, not
// merely redacted -- aggregate counts alone fully answer every question a
// manual dry-run review needs ("how many series would be touched, and in
// what way") without ever placing a UUID (series or workspace) in a
// response body or log line. `wouldRequestOccurrencesTotal` and
// `truncatedSeries` below are the aggregate replacements for what the
// removed per-series array used to convey.
export interface ReplenishmentRunCounts {
  activeSeriesExamined: number;
  skippedSufficientCoverage: number;
  replenished: number;
  occurrencesInserted: number;
  occurrencesSkippedIdempotent: number;
  // Dry-run only (always 0 in live mode, which reports the RPC's own
  // occurrencesInserted/occurrencesSkippedIdempotent instead): the sum,
  // across every series that would be replenished this run, of how many
  // occurrences would be requested. An aggregate total, never a per-series
  // breakdown.
  wouldRequestOccurrencesTotal: number;
  quarantinedDstGap: number;
  stoppedClientInactive: number;
  quarantinedEmployeeIneligible: number;
  conflicts: number;
  safeFailures: number;
  // Counts series (in EITHER mode) whose generated/would-be occurrence
  // window was truncated -- real, valid occurrences existed beyond
  // MAX_OCCURRENCES_PER_SERIES_PER_RUN within the requested window. This
  // run's own `replenished`/`wouldRequestOccurrencesTotal` counts for that
  // series reflect only the capped batch actually requested, NOT full
  // target coverage -- this counter exists so that distinction is reported
  // honestly rather than silently implied to be complete. A truncated
  // series remains below REPLENISH_THRESHOLD_DAYS and is picked up again
  // (self-correcting) on a later run.
  truncatedSeries: number;
  deferredByProcessingLimit: number;
  // Block 2C-2F: a series that WOULD otherwise be replenished or
  // DST-quarantined this run (in either mode), but whose workspace's
  // current entitlement (lib/entitlement.ts's own
  // canMutateOperationalData, the same single source of truth every other
  // route in this app already gates on) does not permit an operational
  // mutation right now. Neither RPC is ever called for a series counted
  // here -- see resolveCachedEntitlement/isMutationPermitted below. Never
  // incremented for a series that needed no mutation in the first place
  // (sufficient coverage, or a non-dst_gap generation failure) -- an
  // entitlement lookup is never even attempted for those, so they cannot
  // be miscounted as "restricted."
  skippedEntitlementRestricted: number;
  // Needing series skipped this run because they failed FAILURE_MAX_ATTEMPTS
  // times recently (bounded retries; see the FAILURE_* constants).
  backedOffAfterFailures: number;
}

function emptyCounts(): ReplenishmentRunCounts {
  return {
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
    skippedEntitlementRestricted: 0,
    backedOffAfterFailures: 0,
  };
}

export interface ReplenishmentRunSummary {
  dryRun: boolean;
  counts: ReplenishmentRunCounts;
}

interface ActiveSeriesRow {
  id: string;
  workspace_id: string;
  frequency_type: RecurringFrequency;
  repeat_weeks: number | null;
  repeat_months: number | null;
  anchor_local_date: string;
  anchor_local_time: string;
  anchor_timezone: string;
  // Guaranteed non-null for any status='active' row by migrations/027b's
  // recurring_series_active_snapshot_complete CHECK -- typed as possibly
  // null anyway (never trust a query result's shape over the schema you
  // can't see at compile time) and defensively handled as a safe failure if
  // it ever is null in practice (see processOneSeries below).
  snapshot_updated_at: string | null;
  last_replenished_at: string | null;
}

const ACTIVE_SERIES_COLUMNS =
  "id, workspace_id, frequency_type, repeat_weeks, repeat_months, anchor_local_date, anchor_local_time, anchor_timezone, snapshot_updated_at, last_replenished_at";

// ============================================================================
// Selection -- status='active' AND is_demo=false is the ENTIRE filter. See
// this module's header / the accompanying audit report for why no separate
// workspace/client-existence or snapshot-completeness query is needed: both
// are structurally guaranteed by existing FK RESTRICT constraints and
// migrations/027b's own CHECK constraint, for any row with status='active'.
// review_required and stopped rows are excluded by this WHERE clause alone
// -- never fetched, never considered, never a candidate for any RPC call.
// ============================================================================

// Every active, non-demo series across all workspaces, paginated with a
// stable order (id is unique), failing closed on any page error. No LIMIT:
// fairness comes from need-based ordering below, not from which rows a
// capped query happens to return.
async function selectAllActiveSeries(): Promise<ActiveSeriesRow[]> {
  const res = await fetchAllPages<ActiveSeriesRow>(async (from, to) =>
    supabaseAdmin
      .from("recurring_series")
      .select(ACTIVE_SERIES_COLUMNS)
      .eq("status", "active")
      .eq("is_demo", false)
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (res.error) throw res.error;
  return res.data ?? [];
}

// One series' latest LIVE (status = 'scheduled') occurrence -- an exact,
// indexed lookup per series instead of one batched read. The batched read
// this replaces selected every scheduled occurrence (history included) of
// up to 100 series in a single unpaginated, oldest-first query, so past
// PostgREST's 1000-row cap it saw only the oldest rows and mistook most
// series for having no future coverage (capacity report D2b). A cancelled
// occurrence never counts toward coverage. Filtered by the series' own
// workspace_id and cross-checked on the way back, so one workspace's rows
// can never count toward another's series. Takes the max of whatever comes
// back rather than trusting row order.
async function fetchLatestLiveOccurrence(series: ActiveSeriesRow): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("series_id, workspace_id, scheduled_for")
    .eq("series_id", series.id)
    .eq("workspace_id", series.workspace_id)
    .eq("status", "scheduled")
    .order("scheduled_for", { ascending: false })
    .limit(1);
  if (error) throw error;
  let latest: string | null = null;
  for (const row of (data as { series_id: string; workspace_id: string; scheduled_for: string }[] | null) ?? []) {
    if (row.series_id !== series.id || row.workspace_id !== series.workspace_id) continue;
    const iso = new Date(row.scheduled_for).toISOString();
    if (!latest || iso > latest) latest = iso;
  }
  return latest;
}

interface FailureRecord {
  attemptCount: number;
  lockedUntil: string | null;
}

// Reads existing failure records for the given series. Fails open (empty
// map, logged): missing backoff information only means a failing series is
// retried normally this run, never that a healthy one is skipped.
async function fetchFailureRecords(seriesIds: string[]): Promise<Map<string, FailureRecord>> {
  const records = new Map<string, FailureRecord>();
  if (seriesIds.length === 0) return records;
  try {
    const keys = seriesIds.map((id) => FAILURE_BUCKET_PREFIX + id);
    const res = await fetchAllPagesChunkedIn<{ bucket_key: string; attempt_count: number; locked_until: string | null }>(
      keys,
      async (chunk, from, to) =>
        supabaseAdmin
          .from("rate_limit_counters")
          .select("bucket_key, attempt_count, locked_until")
          .in("bucket_key", chunk)
          .order("bucket_key", { ascending: true })
          .range(from, to)
    );
    if (res.error) throw res.error;
    for (const row of res.data ?? []) {
      if (!row.bucket_key.startsWith(FAILURE_BUCKET_PREFIX)) continue;
      records.set(row.bucket_key.slice(FAILURE_BUCKET_PREFIX.length), {
        attemptCount: row.attempt_count,
        lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : null,
      });
    }
  } catch {
    console.error("CRON_REPLENISH_FAILURE_RECORD_READ_ERROR");
    return new Map();
  }
  return records;
}

async function recordSeriesFailure(seriesId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc("record_rate_limit_attempt", {
      p_bucket_key: FAILURE_BUCKET_PREFIX + seriesId,
      p_window_seconds: FAILURE_WINDOW_SECONDS,
      p_max_attempts: FAILURE_MAX_ATTEMPTS,
      p_lockout_seconds: FAILURE_LOCKOUT_SECONDS,
    });
    if (error) throw error;
  } catch {
    console.error("CRON_REPLENISH_FAILURE_RECORD_WRITE_ERROR");
  }
}

async function clearSeriesFailure(seriesId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.rpc("clear_rate_limit", { p_bucket_key: FAILURE_BUCKET_PREFIX + seriesId });
    if (error) throw error;
  } catch {
    console.error("CRON_REPLENISH_FAILURE_RECORD_CLEAR_ERROR");
  }
}

// Runs fn over items with at most `limit` in flight, starting items in
// order. Stops starting new items once shouldStop() is true; unstarted
// items are reported as "not_started".
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop: () => boolean
): Promise<({ ok: true; value: R } | { ok: false; reason: "error" | "not_started" })[]> {
  const results: ({ ok: true; value: R } | { ok: false; reason: "error" | "not_started" })[] = items.map(() => ({ ok: false, reason: "not_started" }));
  let next = 0;
  async function worker() {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      try {
        results[index] = { ok: true, value: await fn(items[index]) };
      } catch {
        results[index] = { ok: false, reason: "error" };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type ProcessOutcome =
  | { kind: "skipped_sufficient_coverage" }
  | { kind: "would_replenish"; requested: number }
  | { kind: "would_quarantine_dst_gap" }
  | { kind: "generation_failed" }
  | { kind: "replenished"; inserted: number; skipped: number }
  | { kind: "conflict" }
  | { kind: "stopped_client_inactive" }
  | { kind: "quarantined_employee_ineligible" }
  | { kind: "quarantined_dst_gap" }
  | { kind: "safe_failure" }
  | { kind: "skipped_entitlement_restricted" };

function applyOutcome(counts: ReplenishmentRunCounts, outcome: ProcessOutcome): void {
  switch (outcome.kind) {
    case "skipped_sufficient_coverage":
      counts.skippedSufficientCoverage++;
      return;
    case "would_replenish":
      counts.replenished++;
      counts.wouldRequestOccurrencesTotal += outcome.requested;
      return;
    case "would_quarantine_dst_gap":
      counts.quarantinedDstGap++;
      return;
    case "generation_failed":
      counts.safeFailures++;
      return;
    case "replenished":
      counts.replenished++;
      counts.occurrencesInserted += outcome.inserted;
      counts.occurrencesSkippedIdempotent += outcome.skipped;
      return;
    case "conflict":
      counts.conflicts++;
      return;
    case "stopped_client_inactive":
      counts.stoppedClientInactive++;
      return;
    case "quarantined_employee_ineligible":
      counts.quarantinedEmployeeIneligible++;
      return;
    case "quarantined_dst_gap":
      counts.quarantinedDstGap++;
      return;
    case "safe_failure":
      counts.safeFailures++;
      return;
    case "skipped_entitlement_restricted":
      counts.skippedEntitlementRestricted++;
      return;
    default: {
      // Exhaustiveness guard -- a new ProcessOutcome kind added above without
      // a corresponding case here fails to compile.
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled ProcessOutcome kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ============================================================================
// Main entry point
// ============================================================================
//
// Per-series processing (compute window, generate, dispatch exactly one RPC
// call, never retry) is inlined directly in the loop below rather than
// split into its own function -- it needs nowIso/thresholdIso/targetThroughIso
// plus the running counts accumulator, and threading those through a
// separate function signature added no clarity over one well-commented loop
// body.

export interface RunReplenishmentPassOptions {
  dryRun: boolean;
  // Injectable clock, matching lib/reconcileSubscriptions.ts's own
  // ReconcileDeps.now? convention exactly -- defaults to the true wall
  // clock. Tests supply a fixed instant for deterministic threshold math.
  now?: () => Date;
  // Block 2C-2F: injectable entitlement lookup, defaulting to the real
  // fetchEntitlementForWorkspace (lib/entitlementServer.ts) -- the same
  // production entry point every other server route already uses. Tests
  // supply a fake built from the real, already-tested resolveEntitlement/
  // resolveWorkspaceEntitlement (lib/entitlement.ts) so the GATING logic
  // here is exercised against genuine EntitlementResult shapes without a
  // live Supabase/Stripe dependency.
  fetchEntitlement?: EntitlementFetcherFn;
  // Injectable for tests: elapsed-time clock (ms), run budget and the
  // per-run processing cap. Production uses the defaults.
  clock?: () => number;
  budgetMs?: number;
  maxSeriesProcessed?: number;
}

// Block 2C-2F: per-RUN entitlement cache -- a plain Map created fresh
// inside runReplenishmentPass() below (never a module-level variable), so
// it can never survive across requests/serverless invocations and can
// never leak a lookup from one run into another. Keyed by the series'
// own trusted workspace_id (never client input), so a result can never be
// applied to a different workspace than the one it was resolved for.
// Caches BOTH permitted and restricted results -- a workspace that comes
// back restricted for its first actionable series in this run must not be
// looked up again for its second, third, etc. actionable series in the
// SAME run. A lookup that throws (the real fetchEntitlementForWorkspace
// never does -- see below -- this only matters for a misbehaving injected
// test fake) is deliberately NOT cached, so a transient failure doesn't
// wrongly lock out the rest of the run for that workspace.
async function resolveCachedEntitlement(
  workspaceId: string,
  cache: Map<string, EntitlementResult>,
  fetchEntitlement: EntitlementFetcherFn
): Promise<EntitlementResult | "lookup_error"> {
  const cached = cache.get(workspaceId);
  if (cached) return cached;
  let result: EntitlementResult;
  try {
    result = await fetchEntitlement(workspaceId);
  } catch {
    // The real fetchEntitlementForWorkspace already catches its own
    // Supabase query error internally and resolves to the dedicated
    // "service_unavailable" state (see lib/entitlement.ts's noDataResult)
    // rather than ever throwing -- so this branch is only reachable via a
    // misbehaving injected fetcher in a test. Handled defensively anyway,
    // matching this file's established style, and fails closed exactly
    // like a resolved "service_unavailable" result would.
    console.error("CRON_REPLENISH_ENTITLEMENT_LOOKUP_ERROR");
    return "lookup_error";
  }
  cache.set(workspaceId, result);
  return result;
}

// The ONE place this module ever asks "is a mutation allowed" -- reads
// exactly one already-resolved field (canMutateOperationalData) off the
// pure resolver's own output. No billing string (billingMode/stripeStatus/
// state/reason) is ever pattern-matched here -- that would risk silently
// drifting from lib/entitlement.ts's own policy. See the module-level
// comment above this file's imports.
function isMutationPermitted(entitlement: EntitlementResult): boolean {
  return entitlement.canMutateOperationalData === true;
}

// Block 2C-2F: distinguishes an AUTHORITATIVE "this workspace's billing
// state does not currently permit a mutation" determination (every
// EntitlementState except "service_unavailable" -- including "malformed"
// and "no_subscription", which lib/entitlement.ts's own module header
// explicitly documents as folded into the same LOCKED_CAPABILITIES
// treatment as a genuine locked lifecycle state, not as a transient
// failure) from a genuine, non-authoritative infrastructure hiccup
// ("service_unavailable", reason "query_error" -- lib/entitlement.ts's own
// header: "a transient failure in OUR OWN infrastructure is not
// authoritative evidence of anything about the workspace's real
// lifecycle"). Only the latter -- plus an injected fetcher's own thrown
// error, see resolveCachedEntitlement above -- is counted as a
// safeFailure; every other capability denial is counted as
// skippedEntitlementRestricted. This mirrors, rather than invents, the
// one distinction the resolver's own contract already draws.
function isEntitlementLookupUnavailable(entitlement: EntitlementResult): boolean {
  return entitlement.state === "service_unavailable";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Time-math policy, explicit and deliberate: REPLENISH_TARGET_COVERAGE_DAYS
// and REPLENISH_THRESHOLD_DAYS are ELAPSED-DURATION policy values -- "how
// much real time of runway should exist," not a business-local wall-clock
// concept -- so they are computed here via plain millisecond arithmetic
// (exact elapsed days from `now`), never Luxon calendar-day arithmetic in
// any zone. This is a DELIBERATE, different choice from
// lib/recurringSeriesReplenishment.ts's own generator, which correctly uses
// zone-aware calendar arithmetic FOR THE ACTUAL OCCURRENCE INSTANTS
// themselves (an appointment's wall-clock time must survive a DST
// transition unchanged, e.g. "9:00 AM" stays "9:00 AM" even if the UTC
// offset shifts along the way) -- these two policies serve different goals
// and must not be conflated: exact elapsed time for the safety-margin
// window boundaries computed here, zone-aware calendar time for the
// generator's own candidate occurrences. Because millisecond arithmetic is
// used, a DST transition falling anywhere inside the (now, now+60d] window
// has zero effect on where targetThroughIso/thresholdIso land -- they are
// always exactly 60*24h / 30*24h of real elapsed time after `now`,
// regardless of how many DST transitions (zero, one, or in principle more)
// occur in between.
function addElapsedDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * MS_PER_DAY).toISOString();
}

export async function runReplenishmentPass(options: RunReplenishmentPassOptions): Promise<ReplenishmentRunSummary> {
  const nowDate = (options.now ?? (() => new Date()))();
  const nowIso = nowDate.toISOString();
  const dryRun = options.dryRun;
  const fetchEntitlement = options.fetchEntitlement ?? fetchEntitlementForWorkspace;
  const clock = options.clock ?? (() => Date.now());
  const budgetMs = options.budgetMs ?? RUN_TIME_BUDGET_MS;
  const maxProcessed = options.maxSeriesProcessed ?? MAX_SERIES_PROCESSED_PER_RUN;
  const startedAt = clock();
  const outOfTime = () => clock() - startedAt >= budgetMs;
  const entitlementCache = new Map<string, EntitlementResult>();

  const counts = emptyCounts();

  const allSeries = await selectAllActiveSeries();
  counts.activeSeriesExamined = allSeries.length;
  if (allSeries.length === 0) {
    return { dryRun, counts };
  }

  const targetThroughIso = addElapsedDays(nowDate, REPLENISH_TARGET_COVERAGE_DAYS);
  const thresholdIso = addElapsedDays(nowDate, REPLENISH_THRESHOLD_DAYS);

  // 1. Coverage for every active series. A read error fails closed for
  // that series only (safe_failure, retried next run); series not read
  // before the budget ran out are deferred.
  const coverage = await mapWithConcurrency(allSeries, COVERAGE_READ_CONCURRENCY, fetchLatestLiveOccurrence, outOfTime);
  const needing: { series: ActiveSeriesRow; coverageIso: string }[] = [];
  coverage.forEach((result, index) => {
    if (!result.ok) {
      if (result.reason === "not_started") {
        counts.deferredByProcessingLimit++;
      } else {
        console.error("CRON_REPLENISH_COVERAGE_READ_ERROR");
        applyOutcome(counts, { kind: "safe_failure" });
      }
      return;
    }
    const latestScheduledFor = result.value;
    const coverageIso = latestScheduledFor && latestScheduledFor > nowIso ? latestScheduledFor : nowIso;
    if (coverageIso >= thresholdIso) {
      applyOutcome(counts, { kind: "skipped_sufficient_coverage" });
      return;
    }
    needing.push({ series: allSeries[index], coverageIso });
  });

  // 2. Most urgent first (soonest to run out), id as a stable tiebreaker.
  // Series with a recent failure go after every healthy one; series that
  // failed FAILURE_MAX_ATTEMPTS times are skipped until their lockout ends.
  const failures = await fetchFailureRecords(needing.map((n) => n.series.id));
  const queue = needing
    .filter((n) => {
      const record = failures.get(n.series.id);
      if (record?.lockedUntil && record.lockedUntil > nowIso) {
        counts.backedOffAfterFailures++;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const fa = failures.has(a.series.id) ? 1 : 0;
      const fb = failures.has(b.series.id) ? 1 : 0;
      if (fa !== fb) return fa - fb;
      if (a.coverageIso !== b.coverageIso) return a.coverageIso < b.coverageIso ? -1 : 1;
      return a.series.id < b.series.id ? -1 : a.series.id > b.series.id ? 1 : 0;
    });

  // 3. Process within the budget. Each series is attempted at most once per
  // run, so one failing series can never consume more than its own turn.
  let processed = 0;
  for (const item of queue) {
    if (processed >= maxProcessed || outOfTime()) {
      counts.deferredByProcessingLimit += queue.length - processed;
      break;
    }
    processed++;
    let outcome: ProcessOutcome;
    try {
      outcome = await processSeries(item.series, item.coverageIso, {
        targetThroughIso,
        dryRun,
        counts,
        entitlementCache,
        fetchEntitlement,
      });
    } catch {
      console.error("CRON_REPLENISH_SERIES_LOOP_ERROR");
      outcome = { kind: "safe_failure" };
    }
    applyOutcome(counts, outcome);
    if (!dryRun) {
      if (outcome.kind === "safe_failure" || outcome.kind === "generation_failed") {
        await recordSeriesFailure(item.series.id);
      } else if (outcome.kind === "replenished" && failures.has(item.series.id)) {
        await clearSeriesFailure(item.series.id);
      }
    }
  }

  return { dryRun, counts };
}

interface ProcessContext {
  targetThroughIso: string;
  dryRun: boolean;
  counts: ReplenishmentRunCounts;
  entitlementCache: Map<string, EntitlementResult>;
  fetchEntitlement: EntitlementFetcherFn;
}

// One series that needs a top-up: generate, gate on entitlement, then
// quarantine (DST gap) or replenish via the atomic RPC. Same decisions as
// the previous per-series loop body; it now returns its outcome instead of
// recording it inline.
async function processSeries(series: ActiveSeriesRow, coverageIso: string, ctx: ProcessContext): Promise<ProcessOutcome> {
  if (!series.snapshot_updated_at) {
    console.error("CRON_REPLENISH_UNEXPECTED_NULL_SNAPSHOT_UPDATED_AT");
    return { kind: "safe_failure" };
  }

  const genResult = generateOccurrencesInWindow({
    frequencyType: series.frequency_type,
    repeatWeeks: series.repeat_weeks,
    repeatMonths: series.repeat_months,
    anchorLocalDate: series.anchor_local_date,
    anchorLocalTime: series.anchor_local_time,
    anchorTimezone: series.anchor_timezone,
    after: coverageIso,
    through: ctx.targetThroughIso,
    maxOccurrences: MAX_OCCURRENCES_PER_SERIES_PER_RUN,
  });

  if (!genResult.ok) {
    if (genResult.reason === "dst_gap") {
      const entitlement = await resolveCachedEntitlement(series.workspace_id, ctx.entitlementCache, ctx.fetchEntitlement);
      if (entitlement === "lookup_error") return { kind: "safe_failure" };
      if (!isMutationPermitted(entitlement)) {
        return { kind: isEntitlementLookupUnavailable(entitlement) ? "safe_failure" : "skipped_entitlement_restricted" };
      }
      if (ctx.dryRun) return { kind: "would_quarantine_dst_gap" };
      try {
        const q = await quarantineRecurringSeriesForReplenishment({
          seriesId: series.id,
          workspaceId: series.workspace_id,
          expectedSnapshotUpdatedAt: series.snapshot_updated_at,
          reason: "dst_gap",
        });
        if (q.outcome === "quarantined") return { kind: "quarantined_dst_gap" };
        if (q.outcome === "conflict") return { kind: "conflict" };
        console.error("CRON_REPLENISH_UNEXPECTED_QUARANTINE_OUTCOME");
        return { kind: "safe_failure" };
      } catch {
        console.error("CRON_REPLENISH_QUARANTINE_RPC_ERROR");
        return { kind: "safe_failure" };
      }
    }
    console.error(`CRON_REPLENISH_GENERATION_FAILED_${genResult.reason.toUpperCase()}`);
    return { kind: "generation_failed" };
  }

  if (genResult.truncated) {
    ctx.counts.truncatedSeries++;
  }

  if (genResult.occurrences.length === 0) {
    return { kind: "skipped_sufficient_coverage" };
  }

  const entitlement = await resolveCachedEntitlement(series.workspace_id, ctx.entitlementCache, ctx.fetchEntitlement);
  if (entitlement === "lookup_error") return { kind: "safe_failure" };
  if (!isMutationPermitted(entitlement)) {
    return { kind: isEntitlementLookupUnavailable(entitlement) ? "safe_failure" : "skipped_entitlement_restricted" };
  }

  if (ctx.dryRun) {
    return { kind: "would_replenish", requested: genResult.occurrences.length };
  }

  try {
    const result = await replenishRecurringSeries({
      seriesId: series.id,
      workspaceId: series.workspace_id,
      expectedSnapshotUpdatedAt: series.snapshot_updated_at,
      occurrences: genResult.occurrences,
    });
    switch (result.outcome) {
      case "replenished":
        return { kind: "replenished", inserted: result.insertedCount, skipped: result.skippedCount };
      case "conflict":
        return { kind: "conflict" };
      case "client_stopped":
        return { kind: "stopped_client_inactive" };
      case "employee_review_required":
        return { kind: "quarantined_employee_ineligible" };
      case "missing_snapshot_review_required":
        console.error("CRON_REPLENISH_UNEXPECTED_MISSING_SNAPSHOT");
        return { kind: "safe_failure" };
      case "invalid_input":
        console.error("CRON_REPLENISH_UNEXPECTED_INVALID_INPUT");
        return { kind: "safe_failure" };
      default: {
        const _exhaustive: never = result.outcome;
        throw new Error(`Unhandled replenish outcome: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    if (err instanceof RecurringSeriesReplenishmentRpcError) {
      console.error("CRON_REPLENISH_RPC_ERROR");
    } else {
      console.error("CRON_REPLENISH_UNEXPECTED_ERROR");
    }
    return { kind: "safe_failure" };
  }
}
