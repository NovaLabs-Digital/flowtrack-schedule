// Phase 5.7D-R18: shared helpers for the appointment_employees junction
// table (migrations/021) -- one row per employee assigned to an
// appointment. Used by every route that reads or writes assignments
// (create, update, manage-recurrence, job, employee-hours) so the
// dual-write rule, the workspace-isolation check, and the "never silently
// discard recorded work" removal safeguard are each defined exactly once
// and can never drift between call sites.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { AppointmentEmployeeAssignment, EmployeeHours } from "@/app/components/dashboard/types";

// Defensive existence probe, matching the established hasColumn() pattern
// already used in the appointments create/update routes for not-yet-
// migrated columns -- here applied to a not-yet-migrated TABLE. Read paths
// (dashboard/schedule page data-fetch) use this to fall back to an empty
// list, the same way they already treat services/employees/employeeHours
// as optional. Write paths in this phase assume the table exists, matching
// this project's established migrate-then-deploy rollout order (see
// Phase 5.7D-R17A) -- not applied defensively at every write call site, to
// avoid a guard that can only ever matter for a few hours between
// migration and deploy.
export async function hasAppointmentEmployeesTable(): Promise<boolean> {
  const { error } = await supabaseAdmin.from("appointment_employees").select("id").limit(0);
  return !error;
}

// The read-only compatibility mirror written to appointments.employee_id:
// the one employee's id when exactly one is assigned, otherwise NULL
// (zero or 2+ assigned) -- never an arbitrarily chosen "primary" employee.
// appointment_employees remains the sole authoritative source for "who is
// assigned"; this value exists only so a not-yet-converted reader sees
// "unassigned" rather than a stale or wrong single employee.
export function deriveLegacyEmployeeId(employeeIds: string[]): string | null {
  return employeeIds.length === 1 ? employeeIds[0] : null;
}

export function dedupeEmployeeIds(employeeIds: string[]): string[] {
  return Array.from(new Set(employeeIds.filter((id) => typeof id === "string" && id.trim() !== "")));
}

// Never trusts browser-submitted employee IDs -- every one must belong to
// the authenticated caller's own workspace, or the whole request is
// rejected (fail closed), never silently filtered down to only the valid
// subset.
export async function validateEmployeeIdsInWorkspace(
  employeeIds: string[],
  workspaceId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (employeeIds.length === 0) return { ok: true };
  const { data, error } = await supabaseAdmin
    .from("employees")
    .select("id")
    .in("id", employeeIds)
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  const foundIds = new Set((data ?? []).map((e: { id: string }) => e.id));
  const missing = employeeIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return { ok: false, error: "One or more assigned employees were not found." };
  }
  return { ok: true };
}

export function computeAssignmentDiff(
  currentEmployeeIds: string[],
  desiredEmployeeIds: string[]
): { toAdd: string[]; toRemove: string[] } {
  const currentSet = new Set(currentEmployeeIds);
  const desiredSet = new Set(desiredEmployeeIds);
  return {
    toAdd: desiredEmployeeIds.filter((id) => !currentSet.has(id)),
    toRemove: currentEmployeeIds.filter((id) => !desiredSet.has(id)),
  };
}

// An assignment that already has ANY recorded activity -- a Job Tracking
// timestamp (started and/or completed; even "started but not yet
// completed" is real, in-progress work) or a saved manual
// appointment_employee_hours entry -- must never be silently discarded by
// ordinary appointment editing. Removing it requires a dedicated,
// not-yet-built historical correction path. Returns the subset of
// `toRemove` that is blocked for this reason; an empty result means every
// requested removal is safe (the assignment was never worked at all).
export function findBlockedRemovals(
  toRemove: string[],
  currentAssignments: Pick<AppointmentEmployeeAssignment, "employee_id" | "actual_started_at" | "actual_completed_at">[],
  employeeHoursForAppointment: Pick<EmployeeHours, "employee_id">[]
): string[] {
  const assignmentByEmployeeId = new Map(currentAssignments.map((a) => [a.employee_id, a]));
  const hasManualEntry = new Set(employeeHoursForAppointment.map((h) => h.employee_id));
  return toRemove.filter((employeeId) => {
    const assignment = assignmentByEmployeeId.get(employeeId);
    const hasTrackedActivity = !!assignment && (!!assignment.actual_started_at || !!assignment.actual_completed_at);
    return hasTrackedActivity || hasManualEntry.has(employeeId);
  });
}

export async function fetchAssignments(appointmentId: string, workspaceId: string): Promise<AppointmentEmployeeAssignment[]> {
  const { data, error } = await supabaseAdmin
    .from("appointment_employees")
    .select("id, appointment_id, employee_id, actual_started_at, actual_completed_at, created_at, updated_at")
    .eq("appointment_id", appointmentId)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AppointmentEmployeeAssignment[];
}

// Phase 5.7D-R19 launch-blocker fix: sortAssignmentsStable used to live
// here, but this module imports the server-only supabaseAdmin client
// (below), so any client component importing it pulled that Supabase
// client into the browser bundle. It now lives in
// lib/sortAssignmentsStable.ts, which has no Supabase/server dependency --
// see that file for the implementation and full explanation. Nothing in
// this file calls it directly (fetchAssignments below already returns
// DB-ordered rows via its own .order() clauses).

export async function fetchEmployeeHoursForAppointments(appointmentIds: string[], workspaceId: string): Promise<EmployeeHours[]> {
  if (appointmentIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("appointment_employee_hours")
    .select("id, appointment_id, employee_id, hours_worked, note, created_at, updated_at")
    .in("appointment_id", appointmentIds)
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data ?? []) as EmployeeHours[];
}

export async function insertAssignments(appointmentId: string, workspaceId: string, employeeIds: string[]): Promise<void> {
  if (employeeIds.length === 0) return;
  const rows = employeeIds.map((employee_id) => ({ appointment_id: appointmentId, employee_id, workspace_id: workspaceId }));
  const { error } = await supabaseAdmin.from("appointment_employees").insert(rows);
  if (error) throw error;
}

export async function removeAssignments(appointmentId: string, employeeIds: string[]): Promise<void> {
  if (employeeIds.length === 0) return;
  const { error } = await supabaseAdmin
    .from("appointment_employees")
    .delete()
    .eq("appointment_id", appointmentId)
    .in("employee_id", employeeIds);
  if (error) throw error;
}

// Plans an appointment's assignment change against its CURRENT rows,
// without mutating anything -- callers (the update route) run this for the
// origin appointment and, in "future" mode, every sibling BEFORE applying
// any mutation anywhere, so a blocked removal on any one of them aborts the
// whole request cleanly rather than leaving some appointments changed and
// others not.
export async function planAssignmentSync(
  appointmentId: string,
  workspaceId: string,
  desiredEmployeeIds: string[],
  employeeHoursForAppointment: Pick<EmployeeHours, "employee_id">[]
): Promise<
  | { ok: true; toAdd: string[]; toRemove: string[] }
  | { ok: false; blockedEmployeeIds: string[] }
> {
  const currentAssignments = await fetchAssignments(appointmentId, workspaceId);
  const currentEmployeeIds = currentAssignments.map((a) => a.employee_id);
  const { toAdd, toRemove } = computeAssignmentDiff(currentEmployeeIds, desiredEmployeeIds);
  const blocked = findBlockedRemovals(toRemove, currentAssignments, employeeHoursForAppointment);
  if (blocked.length > 0) return { ok: false, blockedEmployeeIds: blocked };
  return { ok: true, toAdd, toRemove };
}

export async function applyAssignmentSync(appointmentId: string, workspaceId: string, toAdd: string[], toRemove: string[]): Promise<void> {
  if (toRemove.length > 0) await removeAssignments(appointmentId, toRemove);
  if (toAdd.length > 0) await insertAssignments(appointmentId, workspaceId, toAdd);
}
