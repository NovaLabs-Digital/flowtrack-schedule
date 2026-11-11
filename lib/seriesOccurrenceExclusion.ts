import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Records one occurrence instant as skipped on its recurring series, using
// the existing recurring_series.excluded_occurrences mechanism (migration
// 029) that replenish_recurring_series already honours: a candidate instant
// listed there is never inserted by an automatic top-up.
//
// Called BEFORE a single occurrence is moved away from its original time.
// Without it, the vacated slot is free under the (series_id, scheduled_for)
// unique index, and a top-up that reaches that slot would recreate the job
// the owner moved -- a duplicate visit. Ordering makes this safe without a
// transaction: the slot is always either occupied by the original row or
// excluded. If the move then fails, the exclusion is harmless (the row is
// still there, and an existing row is never affected by exclusions).
//
// Cancellations keep their row (status = 'cancelled'), which already blocks
// re-insertion through the unique index; callers record an exclusion there
// too so the skip survives if the row is ever replaced.
//
// Concurrency: compare-and-set on updated_at. Every writer of a
// recurring_series row (activation, replenishment, recurrence change,
// quarantine) bumps updated_at, so a concurrent change makes this update
// match zero rows and it re-reads and retries, instead of overwriting a
// newer excluded_occurrences array.
const MAX_ATTEMPTS = 4;

export type ExclusionResult = "excluded" | "already_excluded" | "not_needed" | "no_series" | "conflict" | "error";

export async function excludeSeriesOccurrence(
  seriesId: string,
  workspaceId: string,
  occurrenceIso: string
): Promise<ExclusionResult> {
  try {
    return await excludeOnce(seriesId, workspaceId, occurrenceIso);
  } catch {
    return "error";
  }
}

async function excludeOnce(seriesId: string, workspaceId: string, occurrenceIso: string): Promise<ExclusionResult> {
  const instant = new Date(occurrenceIso).getTime();
  if (!Number.isFinite(instant)) return "error";
  // Top-ups only ever generate occurrences after "now", so a past slot can
  // never be recreated; historical corrections write nothing here.
  if (instant <= Date.now()) return "not_needed";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data, error } = await supabaseAdmin
      .from("recurring_series")
      .select("id, excluded_occurrences, updated_at")
      .eq("id", seriesId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) return "error";
    // Legacy appointments can carry a series_id with no registry row; with
    // no series there is nothing that could top it up.
    if (!data) return "no_series";

    const existing: string[] = Array.isArray(data.excluded_occurrences) ? data.excluded_occurrences : [];
    if (existing.some((x) => new Date(x).getTime() === instant)) return "already_excluded";

    const { data: updated, error: updateError } = await supabaseAdmin
      .from("recurring_series")
      .update({
        excluded_occurrences: [...existing, new Date(instant).toISOString()],
        updated_at: new Date().toISOString(),
      })
      .eq("id", seriesId)
      .eq("workspace_id", workspaceId)
      .eq("updated_at", data.updated_at)
      .select("id");
    if (updateError) return "error";
    if (Array.isArray(updated) && updated.length === 1) return "excluded";
  }
  return "conflict";
}
