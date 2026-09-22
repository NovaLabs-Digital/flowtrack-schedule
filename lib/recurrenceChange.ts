// Pure request builder + outcome mapper for the atomic recurrence change
// (migrations/029's apply_recurrence_change). No Supabase / env / network
// dependency, so route tests and the real-PostgreSQL integration tests
// (test-db/) build byte-identical requests through the same code.
//
// The RPC binds an operation id to workspace + appointment + the ENTIRE
// normalized request (its sha256 fingerprint), so anything that changes the
// intended result must be inside `request` -- and nothing else may be:
// `expected` (what the owner saw) is deliberately outside the fingerprint.
import { generateFutureDatesSafe } from "@/lib/recurrence";

export const RECURRENCE_FREQUENCIES = ["one_time", "daily", "weekdays", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

export type DesiredAppointmentFields = {
  scheduled_for: string;
  scheduled_end: string | null;
  service_type: string;
  notes: string | null;
  duration_minutes: number;
  price_cents: number | null;
  team_color: string | null;
  status: "scheduled";
};

export type ExpectedSnapshot = {
  scheduled_for: string;
  scheduled_end: string | null;
  service_type: string;
  notes: string | null;
  duration_minutes: number | null;
  price_cents: number | null;
  team_color: string | null;
  status: string;
  series_id: string | null;
  frequency_type: string;
  employee_ids: string[];
  timezone: string;
};

export type RecurrenceChangeRequest = {
  fields: DesiredAppointmentFields;
  employee_ids: string[];
  recurrence: { frequency_type: RecurrenceFrequency; repeat_weeks: number | null; repeat_months: number | null };
  timezone: string;
  occurrences: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function iso(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function canonicalIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids)) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (!isUuid(id)) return null;
    out.push(id.toLowerCase());
  }
  return Array.from(new Set(out)).sort();
}

function intOrNull(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return Number.isInteger(v) ? (v as number) : undefined;
}

// Canonicalizes the owner-supplied "what I saw" snapshot. Returns null when
// malformed -- the route answers 400 rather than guessing.
export function normalizeExpectedSnapshot(raw: unknown): ExpectedSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const scheduledFor = iso(r.scheduled_for);
  const scheduledEnd = r.scheduled_end === null || r.scheduled_end === undefined ? null : iso(r.scheduled_end);
  const employeeIds = canonicalIds(r.employee_ids ?? []);
  const duration = intOrNull(r.duration_minutes);
  const price = intOrNull(r.price_cents);
  if (
    !scheduledFor || (r.scheduled_end != null && scheduledEnd === null) || !employeeIds ||
    typeof r.service_type !== "string" || duration === undefined || price === undefined ||
    typeof r.timezone !== "string" || typeof r.status !== "string"
  ) return null;
  if (r.series_id != null && !isUuid(r.series_id)) return null;
  return {
    scheduled_for: scheduledFor,
    scheduled_end: scheduledEnd,
    service_type: r.service_type,
    notes: typeof r.notes === "string" ? r.notes : null,
    duration_minutes: duration,
    price_cents: price,
    team_color: typeof r.team_color === "string" ? r.team_color : null,
    status: r.status,
    series_id: r.series_id == null ? null : (r.series_id as string).toLowerCase(),
    frequency_type: typeof r.frequency_type === "string" && r.frequency_type ? r.frequency_type : "one_time",
    employee_ids: employeeIds,
    timezone: r.timezone,
  };
}

export type BuildResult =
  | { ok: true; request: RecurrenceChangeRequest }
  | { ok: false; status: number; error: string };

// Builds the normalized request, generating occurrence instants with the
// existing DST-safe generator ANCHORED ON THE REQUESTED (new) start -- the
// value the owner typed, known before any server write.
export function buildRecurrenceChangeRequest(input: {
  fields: unknown;
  employeeIds: unknown;
  frequencyType: unknown;
  repeatWeeks: unknown;
  repeatMonths: unknown;
  timezone: string;
}): BuildResult {
  const bad = (error: string): BuildResult => ({ ok: false, status: 400, error });
  const f = input.fields as Record<string, unknown> | null;
  if (!f || typeof f !== "object") return bad("Missing appointment fields");

  const freq = typeof input.frequencyType === "string" ? input.frequencyType.trim() : "one_time";
  if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(freq)) return bad("Invalid frequency_type");
  const frequency = freq as RecurrenceFrequency;

  const weeksRaw = typeof input.repeatWeeks === "number" ? input.repeatWeeks : 1;
  const monthsRaw = typeof input.repeatMonths === "number" ? input.repeatMonths : null;
  if (frequency === "weekly" && (!Number.isInteger(weeksRaw) || weeksRaw < 1 || weeksRaw > 8)) {
    return bad("Repeat interval must be a whole number of weeks between 1 and 8.");
  }
  if (frequency === "monthly" && (!Number.isInteger(monthsRaw) || (monthsRaw as number) < 1 || (monthsRaw as number) > 12)) {
    return bad("Repeat interval must be a whole number of months between 1 and 12.");
  }

  const scheduledFor = iso(f.scheduled_for);
  const scheduledEnd = f.scheduled_end == null ? null : iso(f.scheduled_end);
  const employeeIds = canonicalIds(input.employeeIds ?? []);
  const duration = f.duration_minutes;
  const price = intOrNull(f.price_cents);
  if (!scheduledFor) return bad("Missing or invalid scheduled_for");
  if (f.scheduled_end != null && scheduledEnd === null) return bad("Invalid scheduled_end");
  if (!employeeIds) return bad("Invalid employee_ids");
  if (typeof f.service_type !== "string" || !f.service_type.trim()) return bad("Missing service_type");
  if (!Number.isInteger(duration) || (duration as number) <= 0) return bad("Invalid duration_minutes");
  if (price === undefined || (price !== null && price < 0)) return bad("Invalid price_cents");
  if (f.status !== undefined && f.status !== "scheduled") {
    return bad("Set the status back to Scheduled before changing the recurrence.");
  }

  let occurrences: string[] = [];
  if (frequency !== "one_time") {
    const gen = generateFutureDatesSafe(
      new Date(scheduledFor),
      frequency,
      frequency === "weekly" ? weeksRaw : 1,
      input.timezone,
      frequency === "monthly" ? (monthsRaw as number) : undefined
    );
    if (!gen.ok) return bad(gen.error);
    occurrences = gen.dates.map((d) => d.toISOString());
  }

  return {
    ok: true,
    request: {
      fields: {
        scheduled_for: scheduledFor,
        scheduled_end: scheduledEnd,
        service_type: f.service_type.trim(),
        notes: typeof f.notes === "string" ? f.notes.trim() || null : null,
        duration_minutes: duration as number,
        price_cents: price,
        team_color: typeof f.team_color === "string" ? f.team_color : null,
        status: "scheduled",
      },
      employee_ids: employeeIds,
      recurrence: {
        frequency_type: frequency,
        repeat_weeks: frequency === "weekly" ? weeksRaw : null,
        repeat_months: frequency === "monthly" ? (monthsRaw as number) : null,
      },
      timezone: input.timezone,
      occurrences,
    },
  };
}

// ---------------------------------------------------------------------------
// RPC outcome -> HTTP mapping
// ---------------------------------------------------------------------------

export type RpcOutcomeHttp = { status: number; body: Record<string, unknown> };

const STALE_MESSAGE = "This appointment was changed by someone else after you opened it. Nothing was saved -- please close and reopen it, then try again.";

export function mapRecurrenceRpcResult(data: unknown): RpcOutcomeHttp {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (d.outcome) {
    case "applied": {
      const protectedCount = Number(d.protected_count ?? 0);
      return {
        status: 200,
        body: {
          ok: true,
          cancelled: Number(d.cancelled_count ?? 0),
          created: Number(d.created_count ?? 0),
          protectedOccurrences: protectedCount,
          protected: d.protected ?? [],
          skippedForExclusion: Number(d.skipped_for_exclusion_count ?? 0),
          ...(d.replayed ? { alreadyApplied: true } : {}),
          ...(protectedCount > 0
            ? {
                notice: {
                  code: "recurrence_protected_occurrences",
                  message: `${protectedCount} occurrence${protectedCount !== 1 ? "s" : ""} with recorded work ${protectedCount !== 1 ? "were" : "was"} kept on the previous schedule and left unchanged.`,
                },
              }
            : {}),
        },
      };
    }
    case "operation_id_conflict":
      return { status: 409, body: { error: "This save request was already used for a different change. Please try again.", code: "OPERATION_ID_CONFLICT" } };
    case "stale_snapshot":
      return { status: 409, body: { error: STALE_MESSAGE, code: "STALE_SNAPSHOT", mismatched: d.mismatched ?? [] } };
    case "state_changed":
      return { status: 409, body: { error: STALE_MESSAGE, code: "STATE_CHANGED" } };
    case "appointment_not_found":
      return { status: 404, body: { error: "Appointment not found" } };
    case "appointment_is_historical":
      return { status: 409, body: { error: "This appointment is a past record and can no longer be changed.", code: "APPOINTMENT_IS_HISTORICAL" } };
    case "assignment_removal_blocked":
      return {
        status: 409,
        body: {
          error: "One or more employees being removed already have recorded worked hours and cannot be removed here. Use a dedicated historical correction instead.",
          code: "ASSIGNMENT_REMOVAL_BLOCKED",
          blockedEmployeeIds: d.blocked_employee_ids ?? [],
        },
      };
    case "employee_not_eligible":
      return { status: 409, body: { error: "One or more assigned employees are no longer active or no longer belong to this workspace. Please refresh and try again.", code: "ASSIGNMENT_SYNC_FAILED" } };
    case "client_not_active":
      return { status: 409, body: { error: "This client is no longer active, so a recurring schedule cannot be created.", code: "CLIENT_NOT_ACTIVE" } };
    case "invalid_input":
      return { status: 400, body: { error: "The requested change was not valid." } };
    case "rolled_back":
      return { status: 409, body: { error: "This change could not be completed and nothing was saved. Please refresh and try again.", code: "ROLLED_BACK" } };
    default:
      return { status: 500, body: { error: "Server error" } };
  }
}
