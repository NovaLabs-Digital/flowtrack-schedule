-- 021: Phase 5.7D-R18 — multiple employees per appointment.
--
-- Adds one new, additive junction table: appointment_employees. No existing
-- table, column, row, index, policy, or constraint is touched, dropped, or
-- rewritten. Safely re-runnable (CREATE TABLE/INDEX use IF NOT EXISTS; the
-- backfill INSERT is idempotent — see below).
--
-- Why a junction table, not a second employee_id column or an array column:
-- an appointment now has zero, one, or many assigned employees, each of
-- whom needs their OWN independent Job Tracking start/complete timestamps
-- (see appointments.actual_started_at/actual_completed_at, which were
-- appointment-level and could only ever represent one employee's time).
-- A junction table with its own tracking columns is the natural home for
-- that per-assignment state, and mirrors appointment_employee_hours
-- (migration 010), which was already keyed by (appointment_id, employee_id)
-- for exactly this reason.
--
-- appointments.employee_id, appointments.actual_started_at, and
-- appointments.actual_completed_at are NOT dropped, renamed, or altered by
-- this migration (or by this phase at all). Application code keeps
-- appointments.employee_id in sync as a read-only compatibility mirror
-- (NULL when zero or 2+ employees are assigned; the one employee's id when
-- exactly one is assigned) — see lib/appointmentEmployees.ts. The
-- appointment-level actual_started_at/actual_completed_at columns stop
-- receiving new writes as of this phase (per-assignment tracking on this
-- new table is authoritative going forward) but every existing historical
-- value is preserved exactly, untouched, forever — this migration does not
-- clear, rewrite, or normalize a single existing timestamp.
--
-- appointment_employee_hours (manual Worked Hours entries) is entirely
-- unchanged by this migration — its existing (appointment_id, employee_id)
-- unique key already models "one entry per employee per job" correctly for
-- multiple assigned employees, with no schema change needed.

CREATE TABLE IF NOT EXISTS appointment_employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id      UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT (the default when no clause is given) is deliberate:
  -- an employee row must never be hard-deleted while it still has
  -- assignment history attached — see StaffPanel/employees route, which
  -- already only ever deactivates (active=false) an employee, never
  -- deletes one. This constraint is a second, database-level line of
  -- defense against accidentally erasing an employee's historical work
  -- through ordinary employee removal, matching the requirement that FK
  -- deletion behavior cannot silently cascade away tracked/manual hours.
  employee_id         UUID NOT NULL REFERENCES employees(id),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  -- Per-assignment Job Tracking timestamps -- the authoritative source for
  -- this employee's worked time on this appointment going forward (see
  -- app/api/appointments/job/route.ts). NULL/NULL means never started;
  -- NULL completed with a start means in progress; both set means this
  -- employee's own tracking is complete (subject to the same
  -- MIN_VALID_TRACKING_MS minimum-duration rule as before -- see
  -- lib/payroll.ts's isJobTrackingComplete, unchanged, now applied to this
  -- row's two columns instead of the appointment's).
  actual_started_at   TIMESTAMPTZ,
  actual_completed_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- updated_at is set once at INSERT time by the DEFAULT below and is NOT
  -- automatically bumped on every UPDATE -- there is no trigger and no
  -- application code path that refreshes it on write. It currently means
  -- only "row created at," not "row last modified at." Documented here
  -- rather than left implicit, so a future reader doesn't assume it tracks
  -- modification time when nothing makes that true today. If true
  -- modification tracking is wanted later, either add an UPDATE trigger or
  -- have every application-level UPDATE explicitly set it — a separate,
  -- deliberate decision, not part of this additive phase.
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Duplicate assignment of the same employee to the same appointment is
-- rejected at the database layer, not only in application code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_employees_unique
  ON appointment_employees(appointment_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_appointment_employees_appointment_id ON appointment_employees(appointment_id);
CREATE INDEX IF NOT EXISTS idx_appointment_employees_employee_id ON appointment_employees(employee_id);
CREATE INDEX IF NOT EXISTS idx_appointment_employees_workspace_id ON appointment_employees(workspace_id);

-- RLS enabled at creation time, no policies -- matches the deny-all-for-
-- anon/authenticated, service-role-only pattern already established for
-- every other business/tenant table (see migration 014 and migration 015's
-- identical "enable at creation" approach for its own new tables).
ALTER TABLE appointment_employees ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- Backfill.
--
-- Exactly one appointment_employees row for every existing appointment that
-- currently has a non-null employee_id, carrying that appointment's own
-- historical actual_started_at/actual_completed_at forward unchanged (never
-- cleared, rewritten, or normalized -- see the column comment above). An
-- appointment with employee_id IS NULL (never assigned) gets NO row here --
-- it remains a valid, zero-assignment appointment, not a fabricated
-- "assigned to nobody in particular" record.
--
-- Idempotent: the NOT EXISTS guard means re-running this INSERT after a
-- first successful run inserts zero additional rows.
-- =============================================================================

INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id, actual_started_at, actual_completed_at)
SELECT a.id, a.employee_id, a.workspace_id, a.actual_started_at, a.actual_completed_at
FROM appointments a
WHERE a.employee_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM appointment_employees ae
    WHERE ae.appointment_id = a.id AND ae.employee_id = a.employee_id
  );
