// Block 2C-2B: the narrowly scoped server-side wrapper around
// migrations/027b's two new RPCs (replenish_recurring_series,
// quarantine_recurring_series_for_replenishment). Mirrors this codebase's
// established RPC-wrapper convention exactly (see lib/recurringSeries.ts's
// activateSeriesWithSnapshot, lib/appointmentEmployees.ts's
// syncAssignmentsAtomically): call the RPC, throw a dedicated error class
// with a safe hardcoded message (raw Supabase/Postgres error preserved
// only as `.cause`, for logging) on a real database failure, otherwise
// return the RPC's own closed outcome.
//
// This file has no HTTP route and no scheduler -- it is not imported by
// any app/api route yet. Block 2C-2B is the database foundation and this
// thin server wrapper only; the replenishment cron orchestrator (which
// route calls this, on what schedule, choosing which series and which
// occurrence window) is a later, separate block.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export class RecurringSeriesReplenishmentRpcError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RecurringSeriesReplenishmentRpcError";
    this.cause = cause;
  }
}

// The exact six closed outcomes migrations/027b's replenish_recurring_series
// can return -- see that migration's own header for what each one means.
export type ReplenishOutcome =
  | "replenished"
  | "conflict"
  | "invalid_input"
  | "client_stopped"
  | "employee_review_required"
  | "missing_snapshot_review_required";

const REPLENISH_OUTCOMES: ReadonlySet<string> = new Set([
  "replenished",
  "conflict",
  "invalid_input",
  "client_stopped",
  "employee_review_required",
  "missing_snapshot_review_required",
]);

export type ReplenishResult = {
  outcome: ReplenishOutcome;
  insertedCount: number;
  skippedCount: number;
};

// Unlike activate_recurring_series/sync_appointment_assignments's own
// TypeScript wrappers (which cast the RPC's bare TEXT response directly,
// `data as X`, with no runtime shape check), this function validates the
// response before trusting it. Two reasons this is deliberately stricter,
// not merely inconsistent with that precedent: (1) migrations/027b's
// replenish_recurring_series returns a JSONB object (outcome + two counts)
// rather than a bare string, so there is materially more that could be
// malformed; (2) a malformed response here would otherwise silently
// propagate a wrong insertedCount/skippedCount into whatever a future cron
// does with those numbers (e.g. logging/alerting), rather than merely
// mis-typing a status string. Any shape mismatch fails closed -- throws
// the same RecurringSeriesReplenishmentRpcError a real database error
// would, never exposing the raw malformed value in the thrown message.
//
// Production-review correction: explicitly rejects a bare array in
// addition to `null` -- `typeof [] === "object"` in JavaScript, so a
// plain `typeof data !== "object"` check alone would NOT reject an array
// (e.g. if the RPC were ever mistakenly changed to RETURNS SETOF/TABLE,
// PostgREST would wrap the result in an array-of-one-row instead of a
// single object). Also requires both counts to be non-negative, not
// merely integers -- a negative inserted_count/skipped_count can never be
// a legitimate value.
function parseReplenishResponse(data: unknown): ReplenishResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new RecurringSeriesReplenishmentRpcError("Received a malformed response from replenish_recurring_series.");
  }
  const row = data as Record<string, unknown>;
  const { outcome, inserted_count, skipped_count } = row;

  if (typeof outcome !== "string" || !REPLENISH_OUTCOMES.has(outcome)) {
    throw new RecurringSeriesReplenishmentRpcError("Received an unrecognized outcome from replenish_recurring_series.");
  }
  if (!Number.isInteger(inserted_count) || (inserted_count as number) < 0) {
    throw new RecurringSeriesReplenishmentRpcError("Received an invalid inserted_count from replenish_recurring_series.");
  }
  if (!Number.isInteger(skipped_count) || (skipped_count as number) < 0) {
    throw new RecurringSeriesReplenishmentRpcError("Received an invalid skipped_count from replenish_recurring_series.");
  }

  return {
    outcome: outcome as ReplenishOutcome,
    insertedCount: inserted_count as number,
    skippedCount: skipped_count as number,
  };
}

// Calls replenish_recurring_series exactly as migrations/027b defines it --
// no snapshot business fields are accepted or passed here; every one of
// those is read from the locked recurring_series row inside the RPC
// itself. `occurrences` must already be the strictly increasing, future,
// <=20-entry array the RPC requires (e.g. lib/recurringSeriesReplenishment.ts's
// own generateOccurrencesInWindow() output, sliced to a batch) -- this
// wrapper does not re-validate or re-sort it; the RPC is the sole
// authority on that validation, and duplicating it here would only risk
// the two disagreeing.
export async function replenishRecurringSeries(params: {
  seriesId: string;
  workspaceId: string;
  expectedSnapshotUpdatedAt: string;
  occurrences: string[];
}): Promise<ReplenishResult> {
  const { data, error } = await supabaseAdmin.rpc("replenish_recurring_series", {
    p_series_id: params.seriesId,
    p_workspace_id: params.workspaceId,
    p_expected_snapshot_updated_at: params.expectedSnapshotUpdatedAt,
    p_occurrences: params.occurrences,
  });
  if (error) {
    throw new RecurringSeriesReplenishmentRpcError(`Failed to replenish recurring_series ${params.seriesId}`, error);
  }
  return parseReplenishResponse(data);
}

// The three closed quarantine reasons migrations/027b's
// quarantine_recurring_series_for_replenishment accepts -- exactly the
// subset of migrations/027a's own review_reason closed-set CHECK this RPC
// is scoped to write.
export type QuarantineReason = "dst_gap" | "employee_no_longer_eligible" | "missing_snapshot";

export type QuarantineOutcome = "quarantined" | "conflict" | "invalid_reason";

const QUARANTINE_OUTCOMES: ReadonlySet<string> = new Set(["quarantined", "conflict", "invalid_reason"]);

function parseQuarantineResponse(data: unknown): { outcome: QuarantineOutcome } {
  if (typeof data !== "string" || !QUARANTINE_OUTCOMES.has(data)) {
    throw new RecurringSeriesReplenishmentRpcError(
      "Received an unrecognized outcome from quarantine_recurring_series_for_replenishment."
    );
  }
  return { outcome: data as QuarantineOutcome };
}

// Calls quarantine_recurring_series_for_replenishment. Intended for the
// ONE quarantine reason only TypeScript can ever detect -- dst_gap, from
// lib/recurringSeriesReplenishment.ts's own generateOccurrencesInWindow()
// -- before replenish_recurring_series would ever be called for that
// series; the other two accepted reasons (employee_no_longer_eligible,
// missing_snapshot) are already handled atomically by
// replenish_recurring_series itself and do not need this RPC called
// separately in the normal replenishment flow.
export async function quarantineRecurringSeriesForReplenishment(params: {
  seriesId: string;
  workspaceId: string;
  expectedSnapshotUpdatedAt: string;
  reason: QuarantineReason;
}): Promise<{ outcome: QuarantineOutcome }> {
  const { data, error } = await supabaseAdmin.rpc("quarantine_recurring_series_for_replenishment", {
    p_series_id: params.seriesId,
    p_workspace_id: params.workspaceId,
    p_expected_snapshot_updated_at: params.expectedSnapshotUpdatedAt,
    p_reason: params.reason,
  });
  if (error) {
    throw new RecurringSeriesReplenishmentRpcError(`Failed to quarantine recurring_series ${params.seriesId}`, error);
  }
  return parseQuarantineResponse(data);
}
