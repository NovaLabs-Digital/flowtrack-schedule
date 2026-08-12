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

// MAX_SERIES_PROCESSED_PER_RUN: bounds total work (and therefore wall-clock
// time) per invocation, mirroring lib/reconcileSubscriptions.ts's own
// RECONCILE_BATCH_LIMIT precedent. 100 is conservative against the route's
// maxDuration = 60s budget.
//
// Accurate database-call model (corrected -- an earlier draft of this
// comment claimed "3 queries total", which was only ever true of the
// SELECT/read side and did not account for RPC calls):
//   - exactly 3 bounded SELECT-side queries per run, regardless of batch
//     size: the active-series list, an exact COUNT for the deferred-count,
//     and one batched latest-occurrence query;
//   - PLUS, in EITHER mode, at most one entitlement lookup per DISTINCT
//     workspace among the series that actually need a mutation decision
//     this run (sufficient-coverage and generation-failure series never
//     reach this lookup at all -- see the entitlement cache below) --
//     bounded above by min(distinct workspaces among the selected batch,
//     MAX_SERIES_PROCESSED_PER_RUN), so at most 100, never more;
//   - PLUS, in LIVE mode only, at most one mutation RPC call per series
//     that is actually eligible for replenishment this run AND whose
//     workspace's entitlement permits the mutation -- NOT per series
//     merely examined, and bounded above by MAX_SERIES_PROCESSED_PER_RUN
//     (so at most 100 RPC calls in the worst case, never more);
//   - ZERO mutation RPC calls in DRY-RUN mode, for any number of series.
// 3 (reads) + up to 100 (entitlement lookups) + up to 100 (writes, live
// mode only) stays comfortably within the 60s budget even at the full
// batch size.
export const MAX_SERIES_PROCESSED_PER_RUN = 100;

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

async function selectEligibleActiveSeries(
  limit: number
): Promise<{ rows: ActiveSeriesRow[]; totalEligible: number }> {
  // Sequential, not Promise.all -- two small, independent reads against the
  // same table; run one after the other so this function's own query order
  // is simple to reason about (and to assert on in tests) rather than
  // relying on concurrent-resolution ordering.
  const rowsRes = await supabaseAdmin
    .from("recurring_series")
    .select(ACTIVE_SERIES_COLUMNS)
    .eq("status", "active")
    .eq("is_demo", false)
    // Oldest-least-recently-replenished-first (NULLs -- never replenished
    // yet -- sort first), with id as a deterministic tiebreaker. Mirrors
    // lib/reconcileSubscriptions.ts's own "oldest-unconfirmed-first"
    // fairness convention: if MAX_SERIES_PROCESSED_PER_RUN is ever
    // exceeded, series NOT processed this run are exactly the ones with
    // the most recent last_replenished_at, so they naturally rise to the
    // front of the next run's ordering instead of being starved forever.
    .order("last_replenished_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (rowsRes.error) throw rowsRes.error;

  const countRes = await supabaseAdmin
    .from("recurring_series")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("is_demo", false);
  if (countRes.error) throw countRes.error;

  return {
    rows: (rowsRes.data as ActiveSeriesRow[] | null) ?? [],
    totalEligible: countRes.count ?? 0,
  };
}

// One batched query for every selected series' latest LIVE (status =
// 'scheduled') occurrence -- never N individual queries, keeping this run's
// total query count constant regardless of batch size. A cancelled
// occurrence at any timestamp, however recent, never counts toward
// coverage -- exactly the "cancelled occurrences must not falsely count as
// live future coverage" requirement. workspace_id is read back and cross-
// checked against the series' own known workspace_id defensively (this
// query spans every workspace's active series at once, like
// app/api/cron/reminders/route.ts already does -- there is no single
// workspace-scoped filter available here, so per-row cross-checking is the
// available defense-in-depth instead).
async function fetchLatestScheduledOccurrences(
  seriesById: Map<string, ActiveSeriesRow>
): Promise<Map<string, string>> {
  const seriesIds = [...seriesById.keys()];
  const latest = new Map<string, string>();
  if (seriesIds.length === 0) return latest;

  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("series_id, workspace_id, scheduled_for")
    .in("series_id", seriesIds)
    .eq("status", "scheduled")
    .order("scheduled_for", { ascending: true });
  if (error) throw error;

  for (const row of (data as { series_id: string; workspace_id: string; scheduled_for: string }[] | null) ?? []) {
    const series = seriesById.get(row.series_id);
    if (!series || series.workspace_id !== row.workspace_id) continue;
    const current = latest.get(row.series_id);
    if (!current || row.scheduled_for > current) {
      latest.set(row.series_id, row.scheduled_for);
    }
  }
  return latest;
}

// ============================================================================
// Per-series processing
// ============================================================================

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
  // Fresh, local to this one invocation only -- see the cache's own
  // documentation above RunReplenishmentPassOptions for why this must never
  // be hoisted to module scope.
  const entitlementCache = new Map<string, EntitlementResult>();

  const counts = emptyCounts();

  const { rows: seriesRows, totalEligible } = await selectEligibleActiveSeries(MAX_SERIES_PROCESSED_PER_RUN);
  counts.activeSeriesExamined = seriesRows.length;
  counts.deferredByProcessingLimit = Math.max(0, totalEligible - seriesRows.length);

  if (seriesRows.length === 0) {
    return { dryRun, counts };
  }

  const seriesById = new Map(seriesRows.map((s) => [s.id, s]));
  const latestScheduledById = await fetchLatestScheduledOccurrences(seriesById);

  const targetThroughIso = addElapsedDays(nowDate, REPLENISH_TARGET_COVERAGE_DAYS);
  const thresholdIso = addElapsedDays(nowDate, REPLENISH_THRESHOLD_DAYS);

  for (const series of seriesRows) {
    try {
      const latestScheduledFor = latestScheduledById.get(series.id) ?? null;
      // Coverage boundary: the latest live occurrence if it's genuinely in
      // the future, otherwise "now" -- the explicitly justified safe
      // boundary for a series with no live tail at all (or, defensively, a
      // stale one somehow still in the past).
      const coverageIso = latestScheduledFor && latestScheduledFor > nowIso ? latestScheduledFor : nowIso;

      if (coverageIso >= thresholdIso) {
        applyOutcome(counts, { kind: "skipped_sufficient_coverage" });
        continue;
      }

      if (!series.snapshot_updated_at) {
        // Structurally shouldn't happen for a status='active' row (see this
        // file's header) -- handled defensively rather than assumed
        // impossible, matching this codebase's established style.
        console.error("CRON_REPLENISH_UNEXPECTED_NULL_SNAPSHOT_UPDATED_AT");
        applyOutcome(counts, { kind: "safe_failure" });
        continue;
      }

      const afterIso = coverageIso;

      const genResult = generateOccurrencesInWindow({
        frequencyType: series.frequency_type,
        repeatWeeks: series.repeat_weeks,
        repeatMonths: series.repeat_months,
        anchorLocalDate: series.anchor_local_date,
        anchorLocalTime: series.anchor_local_time,
        anchorTimezone: series.anchor_timezone,
        after: afterIso,
        through: targetThroughIso,
        maxOccurrences: MAX_OCCURRENCES_PER_SERIES_PER_RUN,
      });

      if (!genResult.ok) {
        if (genResult.reason === "dst_gap") {
          // Block 2C-2F: a DST-gap quarantine is still an operational write
          // (quarantine_recurring_series_for_replenishment mutates the
          // series row) -- it is gated exactly like a normal replenishment,
          // never mutated merely to record a quarantine reason for a
          // workspace whose billing access currently forbids it. The
          // registry itself is left untouched (still status='active') so
          // this series is naturally re-examined on a later run once access
          // is restored.
          const entitlement = await resolveCachedEntitlement(series.workspace_id, entitlementCache, fetchEntitlement);
          if (entitlement === "lookup_error") {
            applyOutcome(counts, { kind: "safe_failure" });
            continue;
          }
          if (!isMutationPermitted(entitlement)) {
            applyOutcome(counts, {
              kind: isEntitlementLookupUnavailable(entitlement) ? "safe_failure" : "skipped_entitlement_restricted",
            });
            continue;
          }

          if (dryRun) {
            applyOutcome(counts, { kind: "would_quarantine_dst_gap" });
            continue;
          }
          try {
            const q = await quarantineRecurringSeriesForReplenishment({
              seriesId: series.id,
              workspaceId: series.workspace_id,
              expectedSnapshotUpdatedAt: series.snapshot_updated_at,
              reason: "dst_gap",
            });
            if (q.outcome === "quarantined") {
              applyOutcome(counts, { kind: "quarantined_dst_gap" });
            } else if (q.outcome === "conflict") {
              applyOutcome(counts, { kind: "conflict" });
            } else {
              // "invalid_reason" -- unreachable from this call site (reason
              // is always the literal "dst_gap"), handled defensively.
              console.error("CRON_REPLENISH_UNEXPECTED_QUARANTINE_OUTCOME");
              applyOutcome(counts, { kind: "safe_failure" });
            }
          } catch {
            console.error("CRON_REPLENISH_QUARANTINE_RPC_ERROR");
            applyOutcome(counts, { kind: "safe_failure" });
          }
          continue;
        }

        // invalid_input / invalid_timezone / iteration_limit -- fail
        // closed, no appointments created, no unsupported review_reason
        // invented. Structurally near-unreachable for a genuinely active
        // row (see this file's header), logged for visibility if it ever
        // does fire. The reason is folded into the event code itself
        // (never passed as a second console.error argument) so this stays
        // a fixed, stable tag, matching this route's "no raw values ever
        // passed to a logging call" convention.
        console.error(`CRON_REPLENISH_GENERATION_FAILED_${genResult.reason.toUpperCase()}`);
        applyOutcome(counts, { kind: "generation_failed" });
        continue;
      }

      // Reported honestly, in BOTH modes, independent of the outcome below:
      // a truncated window means real, valid occurrences existed beyond
      // MAX_OCCURRENCES_PER_SERIES_PER_RUN -- this run's own counts must
      // never be read as "this series reached full target coverage" when
      // that isn't true. See ReplenishmentRunCounts.truncatedSeries.
      if (genResult.truncated) {
        counts.truncatedSeries++;
      }

      if (genResult.occurrences.length === 0) {
        // Window was valid but empty (e.g. the only candidates land exactly
        // on already-materialized slots) -- nothing to request this run.
        applyOutcome(counts, { kind: "skipped_sufficient_coverage" });
        continue;
      }

      // Block 2C-2F: entitlement is resolved here -- only once a real
      // mutation (replenishment) is actually about to be proposed/attempted
      // -- never earlier. A series that never reaches this line (sufficient
      // coverage, or a non-dst_gap generation failure) never triggers an
      // entitlement lookup at all, keeping the added query count bounded to
      // series that actually need a mutation decision this run, per
      // workspace, via the cache above.
      const entitlement = await resolveCachedEntitlement(series.workspace_id, entitlementCache, fetchEntitlement);
      if (entitlement === "lookup_error") {
        applyOutcome(counts, { kind: "safe_failure" });
        continue;
      }
      if (!isMutationPermitted(entitlement)) {
        applyOutcome(counts, {
          kind: isEntitlementLookupUnavailable(entitlement) ? "safe_failure" : "skipped_entitlement_restricted",
        });
        continue;
      }

      if (dryRun) {
        applyOutcome(counts, { kind: "would_replenish", requested: genResult.occurrences.length });
        continue;
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
            applyOutcome(counts, {
              kind: "replenished",
              inserted: result.insertedCount,
              skipped: result.skippedCount,
            });
            break;
          case "conflict":
            applyOutcome(counts, { kind: "conflict" });
            break;
          case "client_stopped":
            applyOutcome(counts, { kind: "stopped_client_inactive" });
            break;
          case "employee_review_required":
            applyOutcome(counts, { kind: "quarantined_employee_ineligible" });
            break;
          case "missing_snapshot_review_required":
            // Structurally shouldn't happen for a status='active' row (see
            // this file's header) -- defensively handled, not assumed
            // impossible.
            console.error("CRON_REPLENISH_UNEXPECTED_MISSING_SNAPSHOT");
            applyOutcome(counts, { kind: "safe_failure" });
            break;
          case "invalid_input":
            // Unreachable in practice (this module's own occurrence array
            // always satisfies the RPC's own validation), handled
            // defensively.
            console.error("CRON_REPLENISH_UNEXPECTED_INVALID_INPUT");
            applyOutcome(counts, { kind: "safe_failure" });
            break;
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
        applyOutcome(counts, { kind: "safe_failure" });
      }
    } catch {
      // Outermost per-series guard -- an unexpected exception anywhere
      // above (a bug, a malformed row) never aborts the rest of the run.
      console.error("CRON_REPLENISH_SERIES_LOOP_ERROR");
      applyOutcome(counts, { kind: "safe_failure" });
    }
  }

  return { dryRun, counts };
}
