-- 031: owner worked-time correction ("Adjust Worked Time").
--
-- Problem: an employee who forgets to clock out (or otherwise mistracks a
-- job) produces a "complete" Job Tracking duration that is simply wrong
-- (e.g. 48h58m for a 1h30m scheduled cleaning). migrations/030's
-- save_employee_hours refused to write an appointment_employee_hours row at
-- all once Job Tracking was complete ('tracked_time_exists') -- there was no
-- way for the owner to correct payroll for that job short of a raw SQL edit,
-- and no such edit could be made without either destroying the original
-- actual_started_at/actual_completed_at or lying about them.
--
-- Fix: appointment_employee_hours becomes the owner-approved OVERRIDE, which
-- now wins even when a complete Job Tracking duration exists (see
-- lib/payroll.ts's resolveWorkedMinutes/resolveJobTrackingHours, updated in
-- lockstep with this migration to read it that way everywhere worked time is
-- displayed or totaled). This migration removes exactly the one guard that
-- prevented that write; every other rule save_employee_hours already
-- enforced is unchanged:
--   * still owner-only -- this function's one caller,
--     app/api/appointments/employee-hours/route.ts, already requires
--     requireOwner(session) before it ever reaches this RPC. An employee
--     session has no path to this function at all (its own Job Tracking
--     actions go through the separate record_job_action, migrations/030,
--     which never touches appointment_employee_hours).
--   * still requires the employee to actually be assigned to this
--     appointment in this workspace (step 2's lookup + not_assigned).
--   * still requires a non-empty p_note (the correction reason) --
--     unchanged, top-of-function validation.
--   * still leaves actual_started_at/actual_completed_at on
--     appointment_employees completely untouched -- this function has never
--     written to that table, only to appointment_employee_hours, and that
--     remains true here. The original tracked timestamps (and the
--     employee's own Job Notes) are preserved forever, exactly as recorded.
--   * still uses the same shared locking protocol (parent appointment FOR
--     SHARE first, then the assignment FOR UPDATE) -- unchanged, so a
--     concurrent apply_recurrence_change (migrations/029) can still never
--     race a correction the way migrations/030's own header describes.
--
-- Purely a function body change: no table, column, index, or grant is
-- added, dropped, or altered. Rollback = revert the two callers
-- (app/api/appointments/employee-hours/route.ts and the UI that calls it)
-- to stop offering a correction once tracking is complete; this function
-- may stay (CREATE OR REPLACE is idempotent either way).
BEGIN;

CREATE OR REPLACE FUNCTION save_employee_hours(
  p_workspace_id   UUID,
  p_appointment_id UUID,
  p_employee_id    UUID,
  p_hours_worked   NUMERIC,
  p_note           TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_status   TEXT;
  v_assign   appointment_employees%ROWTYPE;
  v_existing UUID;
  v_row      appointment_employee_hours%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_appointment_id IS NULL OR p_employee_id IS NULL
     OR p_hours_worked IS NULL OR p_hours_worked <= 0 OR p_hours_worked >= 1000
     OR p_note IS NULL OR btrim(p_note) = '' THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  -- 1. Parent appointment first (FOR SHARE). This is what stops a NEW hours
  -- row from slipping past apply_recurrence_change's protection check.
  SELECT status INTO v_status
  FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_assigned');
  END IF;

  -- 2. The employee's assignment, locked FOR UPDATE. Locking it is no
  -- longer to protect a tracked-time guard (removed below, migrations/031)
  -- -- it is kept so this write still serializes against a concurrent
  -- apply_recurrence_change's own FOR UPDATE on the same row (unchanged
  -- lock order: appointments -> appointment_employees), and so v_assign is
  -- read consistently even though this function no longer branches on it
  -- before the insert.
  SELECT * INTO v_assign
  FROM appointment_employees
  WHERE appointment_id = p_appointment_id AND employee_id = p_employee_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_assigned');
  END IF;

  -- migrations/031: a complete Job Tracking duration no longer blocks this
  -- write. This function's one caller (the employee-hours route) is
  -- owner-only, so a saved row here is always an owner-approved
  -- correction/override -- see this migration's header. v_assign's own
  -- actual_started_at/actual_completed_at are never written by this
  -- function, tracked-complete or not.

  SELECT id INTO v_existing
  FROM appointment_employee_hours
  WHERE appointment_id = p_appointment_id AND employee_id = p_employee_id;

  -- A NEW manual entry on an appointment that is no longer scheduled is
  -- rejected; correcting an entry that already exists is not.
  IF v_existing IS NULL AND v_status IS DISTINCT FROM 'scheduled' THEN
    RETURN jsonb_build_object('outcome', 'appointment_not_active');
  END IF;

  INSERT INTO appointment_employee_hours (appointment_id, employee_id, hours_worked, note, workspace_id, updated_at)
  VALUES (p_appointment_id, p_employee_id, p_hours_worked, p_note, p_workspace_id, now())
  ON CONFLICT (appointment_id, employee_id)
  DO UPDATE SET hours_worked = EXCLUDED.hours_worked, note = EXCLUDED.note, updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('outcome', 'ok', 'entry', jsonb_build_object(
    'id', v_row.id, 'appointment_id', v_row.appointment_id, 'employee_id', v_row.employee_id,
    'hours_worked', v_row.hours_worked, 'note', v_row.note,
    'created_at', v_row.created_at, 'updated_at', v_row.updated_at));
END;
$fn$;

-- Function identity (name + argument types) is unchanged from migrations/030,
-- so its existing privileges already carry over across CREATE OR REPLACE --
-- restated defensively anyway, matching this repo's existing convention for
-- every prior function-replacing migration (e.g. migrations/029).
REVOKE ALL ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) FROM anon;
REVOKE ALL ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) TO service_role;

COMMIT;
