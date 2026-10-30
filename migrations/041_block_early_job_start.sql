-- Employees may record the FIRST work on an appointment (Start, or a
-- Complete that would create the missing start) only on its scheduled
-- business day, judged by the workspace timezone and the database clock.
-- Past and future days are rejected. Finishing work that was already
-- started is never limited (e.g. a forgotten clock-out closed after
-- midnight); owners keep correcting missed or wrong time through
-- save_employee_hours (migration 031), which this does not touch.
--
-- Replaces record_job_action from migration 030; the only change is the
-- scheduled-day check below. No existing work records are changed.
-- Apply separately after review.
--
-- PREREQUISITE (read-only, before applying): confirm production's current
-- function is still exactly migration 030's, so nothing else is overwritten:
--
--   SELECT pg_get_functiondef(
--     'public.record_job_action(uuid,uuid,uuid,text,text)'::regprocedure);
--
-- Compare the body between the $function$ markers with the body between
-- $fn$ ... $fn$ in migrations/030_add_work_recording_locking_protocol.sql.
-- Do not apply if they differ.
--
-- Deploy the application code (which already understands the new
-- outcomes) BEFORE applying this migration.
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
  v_scheduled  TIMESTAMPTZ;
  v_timezone   TEXT;
  v_today      DATE;
  v_day        DATE;
  v_assign     appointment_employees%ROWTYPE;
  v_now        TIMESTAMPTZ := now();
  c_iso        CONSTANT TEXT := 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';
BEGIN
  IF p_workspace_id IS NULL OR p_employee_id IS NULL OR p_appointment_id IS NULL
     OR p_action IS NULL OR p_action NOT IN ('start', 'complete', 'save_notes') THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  -- 1. Parent appointment first (FOR SHARE), status re-read AFTER the lock.
  SELECT status, scheduled_for INTO v_status, v_scheduled
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

  -- First work only on the scheduled business day (checked against the
  -- locked appointment, the workspace timezone, and the server clock).
  -- Complete-without-start would create a start timestamp, so it is held
  -- to the same rule.
  IF v_assign.actual_started_at IS NULL THEN
    SELECT timezone INTO v_timezone FROM company_settings WHERE workspace_id = p_workspace_id;
    -- Identical to lib/timezone.ts effectiveTimezone: trim the stored value
    -- and use it only if it is one of the app's supported zones
    -- (TIMEZONE_OPTIONS); anything else -- unset, blank, unrecognised, or a
    -- valid IANA zone the app does not support -- uses America/New_York.
    -- Keep this list in sync with TIMEZONE_OPTIONS (enforced by
    -- migrations/041_block_early_job_start.test.ts).
    v_timezone := regexp_replace(v_timezone, '^[[:space:]]+|[[:space:]]+$', '', 'g');
    IF v_timezone IS NULL OR v_timezone NOT IN (
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
      'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'
    ) THEN
      v_timezone := 'America/New_York';
    END IF;
    v_today := (v_now AT TIME ZONE v_timezone)::date;
    v_day := (v_scheduled AT TIME ZONE v_timezone)::date;
    IF v_day > v_today THEN
      RETURN jsonb_build_object('outcome', 'appointment_not_due');
    ELSIF v_day < v_today THEN
      RETURN jsonb_build_object('outcome', 'appointment_day_passed');
    END IF;
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

COMMIT;
