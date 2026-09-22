-- 030: work-recording locking protocol for Job Tracking and manual hours.
--
-- Problem: app/api/appointments/job and app/api/appointments/employee-hours
-- used plain PostgREST reads followed by plain writes. Waiting on a row lock
-- does not make such a write re-check anything: once a concurrent
-- apply_recurrence_change (migration 029) committed and cancelled an
-- appointment, a queued "start" UPDATE would still land on an assignment of
-- a cancelled appointment, and a brand-new appointment_employee_hours INSERT
-- cannot be blocked by locking rows that do not exist yet (phantom insert).
--
-- Protocol (shared with apply_recurrence_change): every writer that RECORDS
-- WORK first locks the PARENT appointment row, then re-reads its status, then
-- writes.
--   * Writers take FOR SHARE (many workers may record work on one
--     appointment at once); apply_recurrence_change takes FOR UPDATE on every
--     replacement candidate BEFORE it evaluates recorded work.
--   * Work committed first  -> the replacement's later statement sees it and
--     protects that occurrence.
--   * Replacement committed first -> the writer's FOR SHARE re-evaluates the
--     row it waited on, sees status = 'cancelled', and rejects
--     (appointment_not_active) without writing.
--   * A new manual-hours row can only be inserted while holding the parent
--     lock, so it cannot slip past the replacement's protection check.
-- Lock order per appointment is always: appointments -> appointment_employees
-- (-> appointment_employee_hours), matching apply_recurrence_change, so the
-- two sides cannot deadlock. This is a database function (not a trigger)
-- because a trigger fires only after the assignment row is already locked,
-- which would invert that order.
--
-- Additive: two new functions, nothing else. Both are SECURITY INVOKER,
-- service-role only. Rollback = revert the two routes to their previous
-- code; the functions may stay.
BEGIN;

CREATE OR REPLACE FUNCTION record_job_action(
  p_workspace_id   UUID,
  p_employee_id    UUID,
  p_appointment_id UUID,
  p_action         TEXT,
  p_notes          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_status     TEXT;
  v_assign     appointment_employees%ROWTYPE;
  v_now        TIMESTAMPTZ := now();
  c_iso        CONSTANT TEXT := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
BEGIN
  IF p_workspace_id IS NULL OR p_employee_id IS NULL OR p_appointment_id IS NULL
     OR p_action IS NULL OR p_action NOT IN ('start', 'complete', 'save_notes') THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  -- 1. Parent appointment first (FOR SHARE), status re-read AFTER the lock.
  SELECT status INTO v_status
  FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN
    -- Missing appointment, wrong workspace: indistinguishable on purpose.
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;

  -- 2. This employee's own assignment row.
  SELECT * INTO v_assign
  FROM appointment_employees
  WHERE appointment_id = p_appointment_id AND employee_id = p_employee_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;

  IF v_assign.actual_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_completed');
  END IF;

  IF p_action = 'save_notes' THEN
    IF v_assign.actual_started_at IS NULL THEN
      RETURN jsonb_build_object('outcome', 'not_started');
    END IF;
    UPDATE appointment_employees SET job_notes = p_notes, updated_at = v_now WHERE id = v_assign.id;
    RETURN jsonb_build_object('outcome', 'ok', 'job_notes', p_notes);
  END IF;

  IF p_action = 'start' AND v_assign.actual_started_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'already_started');
  END IF;

  -- Recording the FIRST work on an appointment that is no longer scheduled
  -- (cancelled, or replaced by a recurrence change) is rejected. Finishing
  -- work that was already started is never blocked.
  IF v_assign.actual_started_at IS NULL AND v_status IS DISTINCT FROM 'scheduled' THEN
    RETURN jsonb_build_object('outcome', 'appointment_not_active');
  END IF;

  IF p_action = 'start' THEN
    UPDATE appointment_employees SET actual_started_at = v_now, updated_at = v_now WHERE id = v_assign.id;
    RETURN jsonb_build_object('outcome', 'ok', 'actual_started_at', to_char(v_now AT TIME ZONE 'UTC', c_iso));
  END IF;

  IF v_assign.actual_started_at IS NULL THEN
    UPDATE appointment_employees
    SET actual_started_at = v_now, actual_completed_at = v_now, updated_at = v_now
    WHERE id = v_assign.id;
    RETURN jsonb_build_object('outcome', 'ok',
      'actual_started_at', to_char(v_now AT TIME ZONE 'UTC', c_iso),
      'actual_completed_at', to_char(v_now AT TIME ZONE 'UTC', c_iso));
  END IF;

  UPDATE appointment_employees SET actual_completed_at = v_now, updated_at = v_now WHERE id = v_assign.id;
  RETURN jsonb_build_object('outcome', 'ok', 'actual_completed_at', to_char(v_now AT TIME ZONE 'UTC', c_iso));
END;
$fn$;

REVOKE ALL ON FUNCTION record_job_action(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_job_action(UUID, UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION record_job_action(UUID, UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION record_job_action(UUID, UUID, UUID, TEXT, TEXT) TO service_role;

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

  -- 2. The employee's assignment (locked: a concurrent "complete" must not
  -- race the tracked-time override guard below).
  SELECT * INTO v_assign
  FROM appointment_employees
  WHERE appointment_id = p_appointment_id AND employee_id = p_employee_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_assigned');
  END IF;

  -- Same predicate as lib/payroll.ts isJobTrackingComplete.
  IF v_assign.actual_started_at IS NOT NULL AND v_assign.actual_completed_at IS NOT NULL
     AND v_assign.actual_completed_at - v_assign.actual_started_at >= INTERVAL '60 seconds' THEN
    RETURN jsonb_build_object('outcome', 'tracked_time_exists');
  END IF;

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

REVOKE ALL ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) FROM anon;
REVOKE ALL ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT) TO service_role;

COMMIT;
