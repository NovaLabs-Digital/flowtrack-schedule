// Phase 5.7D-R19 launch-blocker fix: sortAssignmentsStable was originally
// defined in lib/appointmentEmployees.ts, which also imports the
// server-only lib/supabaseAdmin.ts (a service-role Supabase client
// constructed at module load time from process.env.SUPABASE_URL, which is
// undefined in a browser bundle). Once client components (ScheduleGrid,
// AppointmentModal, DispatchPanel, MobileDashboard, MobileSchedule) began
// importing sortAssignmentsStable for Team Color's deterministic ordering,
// that entire module -- including its supabaseAdmin import -- was pulled
// into the /dashboard client bundle, crashing every page load with
// "supabaseUrl is required." This file contains ONLY the pure sorting
// function and a type-only import -- no Supabase import, no server-only
// import, no side effect -- so it is safe to import from client code.
// lib/appointmentEmployees.ts now imports it from here for its own
// (server-side) use, rather than the other way around.
import type { AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";

// A single, deterministic ordering for "which assignment came first" --
// used for Team Color's deterministic fallback (see lib/teamColor.ts), the
// employee names/indicators shown on a schedule card, and the order Worked
// Hours rows are listed in, so all three always agree on the same order.
// created_at is reliably populated (NOT NULL DEFAULT NOW(), migrations/021),
// but ties are real and expected -- every row backfilled by migration 021's
// own INSERT shares one migration-run timestamp -- so ties are broken by
// the assignment's own id, which is always unique, never by employee_id
// (which says nothing about assignment order). Callers should not assume
// the input is already sorted (a Map grouped from an unsorted query result
// is not reliably sorted per key) -- this always re-sorts rather than
// trusting caller order.
export function sortAssignmentsStable<T extends Pick<AppointmentEmployeeAssignment, "id" | "created_at">>(assignments: T[]): T[] {
  return [...assignments].sort((a, b) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
