// Block 2B (Automatic Recurring-Series Replenishment) + its fail-closed
// safety correction: the recurring_series registry -- one row per recurring
// series, additive to the existing appointments.series_id value (see
// migrations/026's own header for why no column is added to appointments).
//
// Every mutation helper below is a compare-and-set against an EXPECTED
// current status, and every one of them throws RecurringSeriesRegistryError
// on a real database failure rather than swallowing it -- callers decide,
// deliberately, what a failure means at each point in a route's sequence:
// a failure BEFORE any appointment mutation aborts the whole request (never
// leaves an active series pointed at appointments that are about to change
// underneath it); a failure AFTER a successful appointment mutation is
// caught by the ROUTE (not here) and surfaces as a non-sensitive warning on
// an otherwise-successful response, with the registry left in
// review_required -- the one state that is always safe to be wrong in,
// because it blocks any future automatic replenishment rather than
// permitting it.
//
// review_required is therefore the fail-closed quarantine state for every
// multi-step registry transition, not only the legacy-backfill state it
// started as in the original Block 2B design.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { zonedDateValue, zonedTimeValue } from "@/lib/timezone";
import { fetchAssignments } from "@/lib/appointmentEmployees";
import { DateTime } from "luxon";

export class RecurringSeriesRegistryError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RecurringSeriesRegistryError";
    this.cause = cause;
  }
}

// Attach this to a mutation route's success response whenever the
// appointment mutation itself fully succeeded but registry finalization did
// not -- never a raw database error message, never a table/column name. The
// UI must display it and must NEVER automatically retry the (already
// successful) appointment mutation because of it.
export const RECURRING_SERIES_REVIEW_WARNING = {
  code: "recurring_series_review_required",
  message:
    "This recurring series needs a quick review before automatic scheduling can continue. Open Settings -> Recurring Series to confirm it.",
} as const;

export type RecurringSeriesStatus = "active" | "stopped" | "review_required";
export type RecurringSeriesSource = "legacy_backfill" | "owner_created";
export type RecurringFrequency = "daily" | "weekdays" | "weekly" | "monthly";

export type RecurringSeriesRow = {
  id: string;
  workspace_id: string;
  status: RecurringSeriesStatus;
  client_id: string;
  is_demo: boolean;
  template_appointment_id: string | null;
  frequency_type: RecurringFrequency;
  repeat_weeks: number | null;
  repeat_months: number | null;
  anchor_local_date: string;
  anchor_local_time: string;
  anchor_timezone: string;
  source: RecurringSeriesSource;
  created_at: string;
  updated_at: string;
  stopped_at: string | null;
  reviewed_at: string | null;
  last_replenished_at: string | null;
};

export const RECURRING_SERIES_COLUMNS =
  "id, workspace_id, status, client_id, is_demo, template_appointment_id, frequency_type, repeat_weeks, repeat_months, anchor_local_date, anchor_local_time, anchor_timezone, source, created_at, updated_at, stopped_at, reviewed_at, last_replenished_at";

// ============================================================================
// Compare-and-set primitives -- every write below is conditioned on the
// row's CURRENT status, never a blind update. A 0-row result is not an
// error: it means the row wasn't in the expected starting state (already
// transitioned, never existed, or raced with something else), which every
// call site below treats as a harmless no-op. Only a real database failure
// throws.
// ============================================================================

async function compareAndSetStatus(
  seriesId: string,
  workspaceId: string,
  fromStatus: RecurringSeriesStatus,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("recurring_series")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", seriesId)
    .eq("workspace_id", workspaceId)
    .eq("status", fromStatus)
    .select("id");
  if (error) {
    throw new RecurringSeriesRegistryError(
      `Failed to transition recurring_series ${seriesId} from ${fromStatus}`,
      error
    );
  }
  return Array.isArray(data) && data.length > 0;
}

// Inserts a BRAND NEW series row already quarantined as review_required,
// with no confirmed template -- the safe starting state for any new series,
// whether it goes on to be finalized active in the same request (Create,
// Manage Recurrence) or left for owner review if that finalize step never
// runs. Anchor fields are derived from the intended first/template
// occurrence's own instant + the resolved workspace timezone, both of which
// are known before that occurrence's appointment row is ever inserted --
// this row must exist BEFORE the appointment insert, so its own insert
// failure aborts the request with zero appointment writes.
export async function insertQuarantinedSeries(params: {
  seriesId: string;
  workspaceId: string;
  clientId: string;
  isDemo: boolean;
  frequencyType: RecurringFrequency;
  repeatWeeks: number | null;
  repeatMonths: number | null;
  scheduledForIso: string;
  timezone: string;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("recurring_series").insert({
    id: params.seriesId,
    workspace_id: params.workspaceId,
    status: "review_required",
    client_id: params.clientId,
    is_demo: params.isDemo,
    template_appointment_id: null,
    frequency_type: params.frequencyType,
    repeat_weeks: params.repeatWeeks,
    repeat_months: params.repeatMonths,
    anchor_local_date: zonedDateValue(params.scheduledForIso, params.timezone),
    anchor_local_time: zonedTimeValue(params.scheduledForIso, params.timezone),
    anchor_timezone: params.timezone,
    source: "owner_created",
    reviewed_at: null,
  });
  if (error) {
    throw new RecurringSeriesRegistryError(`Failed to insert quarantined recurring_series ${params.seriesId}`, error);
  }
}

// Moves a series that IS currently active into review_required -- the
// required first step before any route mutates the appointments belonging
// to it. Returns whether a row was actually active (and is now
// quarantined); false means there was nothing eligible to quarantine (never
// existed, or wasn't active), which every call site treats as a harmless
// no-op, never an error -- but every call site DOES abort its route on a
// thrown error here, before any appointment mutation.
//
// Not used directly by any route as of this correction -- see
// quarantineIfObservedActive below, which wraps this with the explicit
// observe-first step required to tell "never was active" (safe no-op) apart
// from "was active a moment ago, but a concurrent request already moved it"
// (a real conflict that must abort, not silently proceed).
export async function quarantineActiveSeries(seriesId: string, workspaceId: string): Promise<boolean> {
  return compareAndSetStatus(seriesId, workspaceId, "active", { status: "review_required" });
}

export type QuarantineOutcome =
  // The series was observed active and is now quarantined review_required
  // by THIS call -- the caller may safely proceed with its mutation, and
  // must attempt the matching post-mutation finalize step afterward.
  | { outcome: "quarantined" }
  // The series was explicitly observed as NOT active (missing, stopped, or
  // already review_required) before any quarantine attempt was even made --
  // a genuinely safe no-op. The caller proceeds with its mutation and must
  // NOT attempt any later finalize step, since nothing was quarantined.
  | { outcome: "not_active" }
  // The series WAS observed active, but the immediately-following
  // compare-and-set (active -> review_required) matched zero rows -- some
  // other request changed its status in between. This is a genuine
  // concurrency conflict, never a safe no-op: the caller MUST abort before
  // any appointment mutation and MUST NOT later attempt to reactivate the
  // row.
  | { outcome: "conflict" };

// The only correct way to quarantine a series before mutating its
// appointments: observe the row's CURRENT status first, then attempt the
// compare-and-set ONLY when that observation was "active" -- so a
// subsequent zero-row result is unambiguous evidence of a concurrent
// change, not indistinguishable from "it was never active to begin with."
export async function quarantineIfObservedActive(seriesId: string, workspaceId: string): Promise<QuarantineOutcome> {
  const row = await fetchSeriesById(seriesId, workspaceId);
  if (!row || row.status !== "active") {
    return { outcome: "not_active" };
  }
  const transitioned = await compareAndSetStatus(seriesId, workspaceId, "active", { status: "review_required" });
  return transitioned ? { outcome: "quarantined" } : { outcome: "conflict" };
}

// Bulk version for client archival -- every currently-active series tied to
// this client. Returns the exact set of series ids quarantined by THIS
// call, so the caller's later finalize-to-stopped step can be scoped to
// precisely those rows and never sweep up an unrelated legacy
// review_required series that happens to belong to the same client.
export async function quarantineActiveSeriesForClient(clientId: string, workspaceId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("recurring_series")
    .update({ status: "review_required", updated_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .select("id");
  if (error) {
    throw new RecurringSeriesRegistryError(`Failed to quarantine active recurring_series for client ${clientId}`, error);
  }
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id);
}

// Finalizes an already-quarantined (review_required) series as stopped --
// the second half of every "stop this series" sequence. Returns whether it
// actually transitioned; a caller that already knows the row WAS active
// moments ago in this same request (see the *WasActive booleans in every
// route below) treats false here as a real problem worth warning about --
// otherwise false is just the expected outcome for a series that was never
// active to begin with.
export async function finalizeSeriesStopped(seriesId: string, workspaceId: string): Promise<boolean> {
  return compareAndSetStatus(seriesId, workspaceId, "review_required", {
    status: "stopped",
    stopped_at: new Date().toISOString(),
  });
}

// Bulk counterpart, scoped to an EXACT set of series ids (the ones a prior
// quarantineActiveSeriesForClient call just quarantined) rather than the
// whole client -- see the comment there for why that scoping matters. The
// compare-and-set condition (status = review_required) means a row that
// changed again concurrently is simply excluded from this UPDATE, never
// forced through -- returns exactly the ids that WERE transitioned, so the
// caller can tell a partial miss (some ids no longer matched) apart from
// full success, and warn rather than silently report success either way.
export async function finalizeStoppedSeriesByIds(seriesIds: string[], workspaceId: string): Promise<string[]> {
  if (seriesIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("recurring_series")
    .update({ status: "stopped", stopped_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in("id", seriesIds)
    .eq("workspace_id", workspaceId)
    .eq("status", "review_required")
    .select("id");
  if (error) {
    throw new RecurringSeriesRegistryError(`Failed to finalize stopped recurring_series for ${seriesIds.length} id(s)`, error);
  }
  return ((data as { id: string }[] | null) ?? []).map((r) => r.id);
}

export type FinalizeActiveOutcome =
  // The compare-and-set succeeded -- the series is now active.
  | { outcome: "activated" }
  // The registry's own client is inactive or archived AT THIS EXACT MOMENT
  // -- re-checked immediately before the write, not assumed from whatever a
  // caller observed earlier in its own request. The series stays
  // review_required; no write is attempted at all. This is what closes the
  // archive-race window: a client can go active -> (quarantine sweep) ->
  // inactive while a completely different request is mid-flight trying to
  // finalize a series for that same client -- this check is what stops that
  // finalize from ever landing after the fact.
  | { outcome: "client_not_active" }
  // The compare-and-set itself matched zero rows -- the series wasn't
  // review_required anymore (already active, already stopped, or claimed by
  // a concurrent activation/edit). Never forced through.
  | { outcome: "conflict" };

// Finalizes a review_required series as active with a confirmed template --
// the ONLY function anywhere in this codebase that ever sets status to
// "active". Used identically by owner activation
// (app/api/recurring-series/activate), a brand-new series's first finalize
// (Create, Manage Recurrence), and an already-active series's re-finalize
// after a "This & Future" edit (app/api/appointments/update). Anchor fields
// are always (re)derived from the given instant -- a no-op overwrite when
// the instant hasn't actually changed, so callers never need a separate
// "did the time change" branch.
//
// Re-checks the registry's own client status immediately before the write,
// every single time -- a series must never go active for a client that is
// inactive/archived at the moment of finalization, regardless of what any
// caller's own, earlier client check already confirmed. This is the second
// independent layer (beyond each route's own upfront client check) that
// closes the specific race where a client is archived while a separate
// request is concurrently finalizing a series for that same client.
export async function finalizeSeriesActive(params: {
  seriesId: string;
  workspaceId: string;
  clientId: string;
  templateAppointmentId: string;
  scheduledForIso: string;
  timezone: string;
}): Promise<FinalizeActiveOutcome> {
  const { data: client, error: clientErr } = await supabaseAdmin
    .from("clients")
    .select("id, status, archived_at")
    .eq("id", params.clientId)
    .eq("workspace_id", params.workspaceId)
    .maybeSingle();
  if (clientErr) {
    throw new RecurringSeriesRegistryError(
      `Failed to verify client status before activating recurring_series ${params.seriesId}`,
      clientErr
    );
  }
  if (!client || client.status === "inactive" || client.archived_at) {
    return { outcome: "client_not_active" };
  }

  const transitioned = await compareAndSetStatus(params.seriesId, params.workspaceId, "review_required", {
    template_appointment_id: params.templateAppointmentId,
    anchor_local_date: zonedDateValue(params.scheduledForIso, params.timezone),
    anchor_local_time: zonedTimeValue(params.scheduledForIso, params.timezone),
    anchor_timezone: params.timezone,
    reviewed_at: new Date().toISOString(),
    status: "active",
  });
  return transitioned ? { outcome: "activated" } : { outcome: "conflict" };
}

export async function fetchSeriesById(seriesId: string, workspaceId: string): Promise<RecurringSeriesRow | null> {
  const { data, error } = await supabaseAdmin
    .from("recurring_series")
    .select(RECURRING_SERIES_COLUMNS)
    .eq("id", seriesId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new RecurringSeriesRegistryError(`Failed to fetch recurring_series ${seriesId}`, error);
  return (data as RecurringSeriesRow | null) ?? null;
}

// ============================================================================
// Template-consistency evaluation -- pure, no I/O, unit-testable directly.
//
// This is the safety gate for owner activation, for "This & Future"
// re-finalization of an already-active series, and later, for automatic
// replenishment (not implemented yet). It never trusts a single "template"
// row's values in isolation -- every currently-scheduled future occurrence
// in the series must independently agree, per the approved Template
// Disagreement Policy: on disagreement, refuse and require owner review.
// Never majority/mode guessing.
// ============================================================================

export type OccurrenceSnapshot = {
  id: string;
  scheduledFor: string; // ISO instant
  serviceType: string;
  priceCents: number | null;
  durationMinutes: number | null;
  teamColor: string | null;
  employeeIds: string[];
};

export type ConsistencyBlocker =
  | "no_live_occurrences"
  | "template_not_in_series"
  | "service_type_mismatch"
  | "price_mismatch"
  | "duration_mismatch"
  | "team_color_mismatch"
  | "employee_set_mismatch"
  | "time_pattern_unexplained"
  | "weekend_occurrence_in_weekdays_series"
  | "weekly_weekday_pattern_inconsistent"
  | "monthly_progression_invalid";

export type ConsistencyResult =
  | { ok: true; timePattern: "consistent" | "legacy_dst_signature" }
  | { ok: false; blockers: ConsistencyBlocker[] };

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// A business-local time inconsistency is a review blocker, not proof of
// corrupt data -- it may be a legitimate historical "This & Future" time
// change. The ONE pattern this function treats as pre-approved rather than
// blocking is the exact "legacy pre-Phase-5 DST signature" confirmed safe
// against real production data in Block 2A: UTC time-of-day held constant
// across the live occurrences, those occurrences genuinely spanning two
// different real UTC offsets in their own timezone, exactly two distinct
// local times, and a clean 60-minute gap between them. Anything else --
// including a clean 60-minute gap with a CONSTANT offset (an edit, not a
// DST crossing), more than two local times, or UTC also varying alongside a
// real offset change -- remains an unclassified review blocker.
export function evaluateSeriesConsistency(
  occurrences: OccurrenceSnapshot[],
  templateAppointmentId: string,
  frequencyType: RecurringFrequency,
  timezone: string,
  repeatMonths: number | null
): ConsistencyResult {
  if (occurrences.length === 0) return { ok: false, blockers: ["no_live_occurrences"] };

  const template = occurrences.find((o) => o.id === templateAppointmentId);
  if (!template) return { ok: false, blockers: ["template_not_in_series"] };

  const blockers = new Set<ConsistencyBlocker>();

  if (new Set(occurrences.map((o) => o.serviceType)).size > 1) blockers.add("service_type_mismatch");
  if (new Set(occurrences.map((o) => o.priceCents ?? -1)).size > 1) blockers.add("price_mismatch");
  if (new Set(occurrences.map((o) => o.durationMinutes ?? -1)).size > 1) blockers.add("duration_mismatch");
  if (new Set(occurrences.map((o) => o.teamColor ?? "none")).size > 1) blockers.add("team_color_mismatch");

  const employeeSignature = (ids: string[]) => [...ids].sort().join(",");
  if (new Set(occurrences.map((o) => employeeSignature(o.employeeIds))).size > 1) blockers.add("employee_set_mismatch");

  const localized = occurrences.map((o) => {
    const dt = DateTime.fromISO(o.scheduledFor).setZone(timezone);
    return {
      hhmm: dt.toFormat("HH:mm"),
      isoWeekday: dt.weekday,
      offsetMinutes: dt.offset,
      utcHHmm: DateTime.fromISO(o.scheduledFor, { zone: "utc" }).toFormat("HH:mm"),
      day: dt.day,
      daysInMonth: dt.daysInMonth,
      year: dt.year,
      month: dt.month,
    };
  });

  const distinctLocalTimes = Array.from(new Set(localized.map((l) => l.hhmm))).sort();
  const distinctUtcTimes = new Set(localized.map((l) => l.utcHHmm));
  const distinctOffsets = new Set(localized.map((l) => l.offsetMinutes));

  let timePattern: "consistent" | "legacy_dst_signature" = "consistent";

  if (distinctLocalTimes.length > 1) {
    const isLegacyDstSignature =
      distinctUtcTimes.size === 1 &&
      distinctOffsets.size > 1 &&
      distinctLocalTimes.length === 2 &&
      Math.abs(minutesOfDay(distinctLocalTimes[0]) - minutesOfDay(distinctLocalTimes[1])) === 60;

    if (isLegacyDstSignature) {
      timePattern = "legacy_dst_signature";
    } else {
      blockers.add("time_pattern_unexplained");
    }
  }

  if (frequencyType === "weekdays") {
    if (localized.some((l) => l.isoWeekday === 6 || l.isoWeekday === 7)) {
      blockers.add("weekend_occurrence_in_weekdays_series");
    }
  } else if (frequencyType === "weekly") {
    if (new Set(localized.map((l) => l.isoWeekday)).size > 1) {
      blockers.add("weekly_weekday_pattern_inconsistent");
    }
  } else if (frequencyType === "monthly") {
    if (repeatMonths == null) {
      blockers.add("monthly_progression_invalid");
    } else {
      const templateLocal = DateTime.fromISO(template.scheduledFor).setZone(timezone);
      const anchorDay = templateLocal.day!;
      const anchorYearMonth = templateLocal.year * 12 + (templateLocal.month - 1);
      for (const o of occurrences) {
        const dt = DateTime.fromISO(o.scheduledFor).setZone(timezone);
        const expectedDay = Math.min(anchorDay, dt.daysInMonth!);
        const occYearMonth = dt.year * 12 + (dt.month - 1);
        const monthDistance = occYearMonth - anchorYearMonth;
        if (dt.day !== expectedDay || monthDistance % repeatMonths !== 0) {
          blockers.add("monthly_progression_invalid");
          break;
        }
      }
    }
  }
  // "daily" has no weekday-uniformity requirement -- multiple weekdays are
  // legitimately expected and never flagged.

  if (blockers.size > 0) return { ok: false, blockers: Array.from(blockers) };
  return { ok: true, timePattern };
}

// Fetches every currently-scheduled, future occurrence of a series together
// with its assignment set -- the exact snapshot shape evaluateSeriesConsistency
// needs. Shared by owner activation and "This & Future" re-finalization so
// both validate the live tail identically.
export async function fetchLiveOccurrenceSnapshots(seriesId: string, workspaceId: string): Promise<OccurrenceSnapshot[]> {
  const { data: rows, error } = await supabaseAdmin
    .from("appointments")
    .select("id, scheduled_for, service_type, price_cents, duration_minutes, team_color")
    .eq("series_id", seriesId)
    .eq("workspace_id", workspaceId)
    .eq("status", "scheduled")
    .gt("scheduled_for", new Date().toISOString());
  if (error) {
    throw new RecurringSeriesRegistryError(`Failed to fetch live occurrences for recurring_series ${seriesId}`, error);
  }
  const occurrences = (rows as any[] | null) ?? [];
  return Promise.all(
    occurrences.map(async (o) => {
      const assignments = await fetchAssignments(o.id, workspaceId);
      return {
        id: o.id,
        scheduledFor: o.scheduled_for,
        serviceType: o.service_type,
        priceCents: o.price_cents,
        durationMinutes: o.duration_minutes,
        teamColor: o.team_color,
        employeeIds: assignments.map((a) => a.employee_id),
      };
    })
  );
}
