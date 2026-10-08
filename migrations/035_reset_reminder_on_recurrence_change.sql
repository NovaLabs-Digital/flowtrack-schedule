-- 035: reset the 24h-reminder dedup flag whenever apply_recurrence_change
-- (migrations/029) moves the anchor appointment's own scheduled_for.
--
-- Problem (SFT reminder reliability investigation, Izabel Rowe/production):
-- appointments.reminder_24h_sent_at is written in exactly one place in this
-- codebase -- app/api/cron/reminders/route.ts, after a successful send -- and
-- is never cleared anywhere. apply_recurrence_change's own anchor UPDATE
-- (migrations/029, the block that rewrites scheduled_for/scheduled_end/
-- service_type/etc. on the SAME row id when an owner edits a recurring
-- appointment's pattern) left this column untouched. Once that anchor row had
-- ever been reminded for an EARLIER scheduled_for, it would never be
-- reminded again for any LATER scheduled_for it was moved to by this
-- function -- a silent, permanent loss of future reminders for that
-- appointment. Newly INSERTed replacement occurrences (the rest of the new
-- series, further down in the same function) are unaffected: a fresh row has
-- no default for this column, so it already starts NULL (reminder-eligible)
-- with no change needed there.
--
-- Fix: the anchor's own UPDATE now also sets reminder_24h_sent_at = NULL,
-- unconditionally, exactly like every other field in that SET list is
-- unconditionally rewritten to the request's new values -- this function
-- already represents a deliberate owner decision to reset this appointment's
-- schedule/pattern, so there is no narrower "only if scheduled_for actually
-- moved" condition worth adding here (the one-row UPDATE is already paid for
-- regardless, and re-arming reminder eligibility on a no-op time value is
-- harmless: at most one appointment is correctly re-considered by the next
-- cron run, never double-sent, since the cron's own dedup check is on this
-- same column).
--
-- Purely a function body change: no table, column, index, or grant is added,
-- dropped, or altered. The function signature is byte-identical to
-- migrations/029's, so its existing grants already carry over across CREATE
-- OR REPLACE -- restated defensively anyway, matching this repo's existing
-- convention for every prior function-replacing migration.
BEGIN;

CREATE OR REPLACE FUNCTION apply_recurrence_change(
  p_workspace_id   UUID,
  p_appointment_id UUID,
  p_operation_id   UUID,
  p_request        JSONB,
  p_expected       JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  c_max_occurrences CONSTANT INTEGER := 200;
  c_tz_allowlist    CONSTANT TEXT[] := ARRAY[
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'
  ];

  v_fingerprint   TEXT;
  v_op            recurrence_change_operations%ROWTYPE;

  -- parsed request
  v_freq          TEXT;
  v_weeks         INTEGER;
  v_months        INTEGER;
  v_tz            TEXT;
  v_new_start     TIMESTAMPTZ;
  v_new_end       TIMESTAMPTZ;
  v_service       TEXT;
  v_notes         TEXT;
  v_duration      INTEGER;
  v_price         INTEGER;
  v_color         TEXT;
  v_status        TEXT;
  v_desired_emps  UUID[];
  v_occ           TIMESTAMPTZ[];

  -- parsed expected snapshot
  v_exp_start     TIMESTAMPTZ;
  v_exp_end       TIMESTAMPTZ;
  v_exp_service   TEXT;
  v_exp_notes     TEXT;
  v_exp_duration  INTEGER;
  v_exp_price     INTEGER;
  v_exp_color     TEXT;
  v_exp_status    TEXT;
  v_exp_series    UUID;
  v_exp_freq      TEXT;
  v_exp_emps      UUID[];
  v_exp_tz        TEXT;

  -- discovery / locked state
  v_disc_series   UUID;
  v_client_id     UUID;
  v_appt          appointments%ROWTYPE;
  v_old_series    recurring_series%ROWTYPE;
  v_old_found     BOOLEAN := FALSE;
  v_client_status TEXT;
  v_client_archived_at TIMESTAMPTZ;
  v_company_tz    TEXT;
  v_effective_tz  TEXT;
  v_current_emps  UUID[];
  v_mismatch      TEXT[] := ARRAY[]::TEXT[];
  v_eff_end       TIMESTAMPTZ;
  v_assign_ct     INTEGER;
  v_assign_done_ct INTEGER;
  v_to_add        UUID[];
  v_to_remove     UUID[];
  v_blocked       UUID[];
  v_ineligible_ct INTEGER;
  v_bad_ct        INTEGER;

  -- replacement bookkeeping
  v_cand_ids      UUID[] := ARRAY[]::UUID[];
  v_cancel_ids    UUID[] := ARRAY[]::UUID[];
  v_protected     JSONB := '[]'::JSONB;
  v_protected_ct  INTEGER := 0;
  v_cancelled_ct  INTEGER := 0;
  v_created_ct    INTEGER := 0;
  v_skipped_excl  INTEGER := 0;
  v_exclusions    TIMESTAMPTZ[] := ARRAY[]::TIMESTAMPTZ[];
  v_new_series    UUID := NULL;
  v_old_stopped   BOOLEAN := FALSE;
  v_client_visible_change BOOLEAN;
  v_prev_start    TIMESTAMPTZ;
  v_act           TEXT;
  v_result        JSONB;
BEGIN
  -- 0. Caller-input validation, before any lock or write.
  IF p_workspace_id IS NULL OR p_appointment_id IS NULL OR p_operation_id IS NULL
     OR p_request IS NULL OR p_expected IS NULL
     OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  BEGIN
    v_freq         := p_request->'recurrence'->>'frequency_type';
    v_weeks        := (p_request->'recurrence'->>'repeat_weeks')::INTEGER;
    v_months       := (p_request->'recurrence'->>'repeat_months')::INTEGER;
    v_tz           := p_request->>'timezone';
    v_new_start    := (p_request->'fields'->>'scheduled_for')::TIMESTAMPTZ;
    v_new_end      := (p_request->'fields'->>'scheduled_end')::TIMESTAMPTZ;
    v_service      := p_request->'fields'->>'service_type';
    v_notes        := p_request->'fields'->>'notes';
    v_duration     := (p_request->'fields'->>'duration_minutes')::INTEGER;
    v_price        := (p_request->'fields'->>'price_cents')::INTEGER;
    v_color        := p_request->'fields'->>'team_color';
    v_status       := p_request->'fields'->>'status';
    SELECT COALESCE(array_agg(e::UUID ORDER BY e::UUID), ARRAY[]::UUID[])
      INTO v_desired_emps
      FROM jsonb_array_elements_text(COALESCE(p_request->'employee_ids', '[]'::JSONB)) e;
    SELECT COALESCE(array_agg(o::TIMESTAMPTZ ORDER BY ord), ARRAY[]::TIMESTAMPTZ[])
      INTO v_occ
      FROM jsonb_array_elements_text(COALESCE(p_request->'occurrences', '[]'::JSONB)) WITH ORDINALITY t(o, ord);

    v_exp_start    := (p_expected->>'scheduled_for')::TIMESTAMPTZ;
    v_exp_end      := (p_expected->>'scheduled_end')::TIMESTAMPTZ;
    v_exp_service  := p_expected->>'service_type';
    v_exp_notes    := p_expected->>'notes';
    v_exp_duration := (p_expected->>'duration_minutes')::INTEGER;
    v_exp_price    := (p_expected->>'price_cents')::INTEGER;
    v_exp_color    := p_expected->>'team_color';
    v_exp_status   := p_expected->>'status';
    v_exp_series   := (p_expected->>'series_id')::UUID;
    v_exp_freq     := COALESCE(p_expected->>'frequency_type', 'one_time');
    v_exp_tz       := p_expected->>'timezone';
    SELECT COALESCE(array_agg(e::UUID ORDER BY e::UUID), ARRAY[]::UUID[])
      INTO v_exp_emps
      FROM jsonb_array_elements_text(COALESCE(p_expected->'employee_ids', '[]'::JSONB)) e;
  EXCEPTION WHEN data_exception THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END;

  -- COALESCE(..., TRUE): a NULL anywhere in this chain must reject (fail
  -- closed), never fall through as "not true".
  IF COALESCE(
     v_freq IS NULL OR v_freq NOT IN ('one_time', 'daily', 'weekdays', 'weekly', 'monthly')
     OR v_tz IS NULL OR v_tz <> ALL (c_tz_allowlist)
     OR v_new_start IS NULL
     OR (v_new_end IS NOT NULL AND v_new_end <= v_new_start)
     OR v_service IS NULL OR btrim(v_service) = ''
     OR v_duration IS NULL OR v_duration <= 0
     OR (v_price IS NOT NULL AND v_price < 0)
     OR (v_color IS NOT NULL AND v_color !~ '^#[0-9A-Fa-f]{6}$')
     OR v_status IS DISTINCT FROM 'scheduled'
     OR (v_freq = 'weekly' AND (v_weeks IS NULL OR v_weeks < 1 OR v_weeks > 8))
     OR (v_freq = 'monthly' AND (v_months IS NULL OR v_months < 1 OR v_months > 12))
     OR (SELECT COUNT(DISTINCT e) FROM unnest(v_desired_emps) e) <> cardinality(v_desired_emps)
     OR cardinality(v_occ) > c_max_occurrences
     OR (v_freq = 'one_time' AND cardinality(v_occ) <> 0)
     OR (v_freq <> 'one_time' AND (cardinality(v_occ) < 1 OR v_new_start <= now())),
     TRUE
  ) THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  IF v_freq <> 'one_time' THEN
    -- The generator's output is re-checked here (never trusted): strictly
    -- increasing, after the new anchor, same business-local time of day, and
    -- on the requested cadence.
    SELECT COUNT(*) INTO v_bad_ct
    FROM (
      SELECT occ, lag(occ) OVER (ORDER BY ord) AS prev_occ
      FROM unnest(v_occ) WITH ORDINALITY AS t(occ, ord)
    ) s
    WHERE occ IS NULL
       OR (prev_occ IS NOT NULL AND occ <= prev_occ)
       OR (prev_occ IS NULL AND occ <= v_new_start)
       OR (occ AT TIME ZONE v_tz)::TIME <> (v_new_start AT TIME ZONE v_tz)::TIME
       OR (v_freq = 'weekdays' AND EXTRACT(ISODOW FROM (occ AT TIME ZONE v_tz)) IN (6, 7))
       OR (v_freq = 'weekly'
           AND (((occ AT TIME ZONE v_tz)::DATE - (v_new_start AT TIME ZONE v_tz)::DATE) % (7 * v_weeks)) <> 0)
       OR (v_freq = 'monthly'
           AND ((EXTRACT(YEAR FROM (occ AT TIME ZONE v_tz)) * 12 + EXTRACT(MONTH FROM (occ AT TIME ZONE v_tz)))
              - (EXTRACT(YEAR FROM (v_new_start AT TIME ZONE v_tz)) * 12 + EXTRACT(MONTH FROM (v_new_start AT TIME ZONE v_tz))))
              % v_months <> 0);
    IF v_bad_ct > 0 THEN
      RETURN jsonb_build_object('outcome', 'invalid_input');
    END IF;
  END IF;

  -- 1. Operation identity: bound to workspace + appointment + the entire
  -- normalized request.
  v_fingerprint := encode(
    sha256(convert_to(p_workspace_id::TEXT || '|' || p_appointment_id::TEXT || '|' || p_request::TEXT, 'UTF8')),
    'hex'
  );

  -- 2. Claim the identity BEFORE any business read or write. Two concurrent
  -- calls with the same operation id serialize here; the second one then
  -- sees the first one's committed record (or, if the first was rejected or
  -- rolled back, none).
  PERFORM pg_advisory_xact_lock(hashtext('apply_recurrence_change'), hashtext(p_operation_id::TEXT));

  SELECT * INTO v_op FROM recurrence_change_operations WHERE id = p_operation_id;
  IF FOUND THEN
    IF v_op.workspace_id = p_workspace_id
       AND v_op.appointment_id = p_appointment_id
       AND v_op.request_fingerprint = v_fingerprint THEN
      -- Identical completed operation: replay BEFORE any snapshot check (the
      -- snapshot may be stale precisely because this operation succeeded).
      RETURN v_op.result || jsonb_build_object('replayed', TRUE);
    END IF;
    RETURN jsonb_build_object('outcome', 'operation_id_conflict');
  END IF;

  -- 3. Discovery read (unlocked): only to learn which series row to lock
  -- first. Re-verified under lock below.
  SELECT series_id, client_id INTO v_disc_series, v_client_id
  FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'appointment_not_found');
  END IF;

  -- 4. recurring_series (old series)
  IF v_disc_series IS NOT NULL THEN
    SELECT * INTO v_old_series
    FROM recurring_series
    WHERE id = v_disc_series AND workspace_id = p_workspace_id
    FOR UPDATE;
    v_old_found := FOUND;
  END IF;

  -- 5. clients
  SELECT status, archived_at INTO v_client_status, v_client_archived_at
  FROM clients
  WHERE id = v_client_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'state_changed');
  END IF;
  IF v_freq <> 'one_time' AND (v_client_status IS DISTINCT FROM 'active' OR v_client_archived_at IS NOT NULL) THEN
    RETURN jsonb_build_object('outcome', 'client_not_active');
  END IF;

  -- 6. the anchor appointment
  SELECT * INTO v_appt
  FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'appointment_not_found');
  END IF;
  IF v_appt.series_id IS DISTINCT FROM v_disc_series OR v_appt.client_id IS DISTINCT FROM v_client_id THEN
    RETURN jsonb_build_object('outcome', 'state_changed');
  END IF;

  -- 7. the anchor's assignments
  PERFORM 1 FROM appointment_employees WHERE appointment_id = p_appointment_id ORDER BY employee_id FOR UPDATE;
  SELECT COALESCE(array_agg(employee_id ORDER BY employee_id), ARRAY[]::UUID[]),
         COUNT(*),
         COUNT(*) FILTER (WHERE actual_started_at IS NOT NULL AND actual_completed_at IS NOT NULL
                            AND actual_completed_at - actual_started_at >= INTERVAL '60 seconds')
    INTO v_current_emps, v_assign_ct, v_assign_done_ct
  FROM appointment_employees
  WHERE appointment_id = p_appointment_id;

  -- 8. Historical anchor: never changeable (same rule as the other routes).
  v_eff_end := COALESCE(v_appt.scheduled_end, v_appt.scheduled_for + make_interval(mins => COALESCE(v_appt.duration_minutes, 0)));
  IF v_appt.status IS DISTINCT FROM 'scheduled'
     OR v_eff_end < now()
     OR (v_assign_ct > 0 AND v_assign_done_ct = v_assign_ct) THEN
    RETURN jsonb_build_object('outcome', 'appointment_is_historical');
  END IF;

  -- 9. Expected snapshot vs the LOCKED row -- reject stale input before any write.
  IF v_exp_start IS DISTINCT FROM v_appt.scheduled_for THEN v_mismatch := array_append(v_mismatch, 'scheduled_for'); END IF;
  IF v_exp_end IS DISTINCT FROM v_appt.scheduled_end THEN v_mismatch := array_append(v_mismatch, 'scheduled_end'); END IF;
  IF v_exp_service IS DISTINCT FROM v_appt.service_type THEN v_mismatch := array_append(v_mismatch, 'service_type'); END IF;
  IF COALESCE(v_exp_notes, '') IS DISTINCT FROM COALESCE(v_appt.notes, '') THEN v_mismatch := array_append(v_mismatch, 'notes'); END IF;
  IF v_exp_duration IS DISTINCT FROM v_appt.duration_minutes THEN v_mismatch := array_append(v_mismatch, 'duration_minutes'); END IF;
  IF v_exp_price IS DISTINCT FROM v_appt.price_cents THEN v_mismatch := array_append(v_mismatch, 'price_cents'); END IF;
  IF v_exp_color IS DISTINCT FROM v_appt.team_color THEN v_mismatch := array_append(v_mismatch, 'team_color'); END IF;
  IF v_exp_status IS DISTINCT FROM v_appt.status THEN v_mismatch := array_append(v_mismatch, 'status'); END IF;
  IF v_exp_series IS DISTINCT FROM v_appt.series_id THEN v_mismatch := array_append(v_mismatch, 'series_id'); END IF;
  IF v_exp_freq IS DISTINCT FROM COALESCE(v_appt.frequency_type, 'one_time') THEN v_mismatch := array_append(v_mismatch, 'frequency_type'); END IF;
  IF v_exp_emps IS DISTINCT FROM v_current_emps THEN v_mismatch := array_append(v_mismatch, 'employee_ids'); END IF;

  IF v_freq <> 'one_time' THEN
    SELECT timezone INTO v_company_tz FROM company_settings WHERE workspace_id = p_workspace_id;
    v_effective_tz := CASE WHEN v_company_tz = ANY (c_tz_allowlist) THEN v_company_tz ELSE 'America/New_York' END;
    IF v_effective_tz IS DISTINCT FROM v_tz OR v_exp_tz IS DISTINCT FROM v_tz THEN
      v_mismatch := array_append(v_mismatch, 'timezone');
    END IF;
  END IF;

  IF cardinality(v_mismatch) > 0 THEN
    RETURN jsonb_build_object('outcome', 'stale_snapshot', 'mismatched', to_jsonb(v_mismatch));
  END IF;

  -- 10. Trusted boundary: the anchor's ORIGINAL position, from the locked row.
  v_prev_start := v_appt.scheduled_for;

  -- 11. Employee changes (validated now, applied later). Removing an
  -- assignment that already has recorded work is never allowed here.
  v_to_add    := ARRAY(SELECT e FROM unnest(v_desired_emps) e WHERE e <> ALL (v_current_emps));
  v_to_remove := ARRAY(SELECT e FROM unnest(v_current_emps) e WHERE e <> ALL (v_desired_emps));

  IF cardinality(v_to_remove) > 0 THEN
    v_blocked := ARRAY(
      SELECT ae.employee_id
      FROM appointment_employees ae
      WHERE ae.appointment_id = p_appointment_id
        AND ae.employee_id = ANY (v_to_remove)
        AND (ae.actual_started_at IS NOT NULL OR ae.actual_completed_at IS NOT NULL OR ae.job_notes IS NOT NULL
             OR EXISTS (SELECT 1 FROM appointment_employee_hours h
                        WHERE h.appointment_id = ae.appointment_id AND h.employee_id = ae.employee_id))
    );
    IF cardinality(v_blocked) > 0 THEN
      RETURN jsonb_build_object('outcome', 'assignment_removal_blocked', 'blocked_employee_ids', to_jsonb(v_blocked));
    END IF;
  END IF;

  -- 12. Sibling replacement candidates: everything still scheduled in the old
  -- series AFTER the anchor's original position. Locked (5) and their
  -- assignments locked (6) BEFORE recorded work is evaluated, in a separate
  -- statement (READ COMMITTED takes a fresh snapshot per statement, so work
  -- committed by a writer that held the appointment first is visible here).
  IF v_disc_series IS NOT NULL THEN
    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[]) INTO v_cand_ids
    FROM (
      SELECT id FROM appointments
      WHERE series_id = v_disc_series
        AND workspace_id = p_workspace_id
        AND status = 'scheduled'
        AND is_demo = v_appt.is_demo
        AND id <> p_appointment_id
        AND scheduled_for > v_prev_start
      ORDER BY scheduled_for, id
      FOR UPDATE
    ) locked;

    IF cardinality(v_cand_ids) > 0 THEN
      PERFORM 1 FROM appointment_employees
      WHERE appointment_id = ANY (v_cand_ids)
      ORDER BY appointment_id, employee_id
      FOR UPDATE;

      SELECT COALESCE(array_agg(c.id ORDER BY c.scheduled_for, c.id) FILTER (WHERE NOT c.is_protected), ARRAY[]::UUID[]),
             COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'scheduled_for', c.scheduled_for) ORDER BY c.scheduled_for, c.id)
                      FILTER (WHERE c.is_protected), '[]'::JSONB),
             COUNT(*) FILTER (WHERE c.is_protected)
        INTO v_cancel_ids, v_protected, v_protected_ct
      FROM (
        SELECT a.id, a.scheduled_for,
               (EXISTS (SELECT 1 FROM appointment_employees ae
                        WHERE ae.appointment_id = a.id
                          AND (ae.actual_started_at IS NOT NULL OR ae.actual_completed_at IS NOT NULL OR ae.job_notes IS NOT NULL))
                OR EXISTS (SELECT 1 FROM appointment_employee_hours h WHERE h.appointment_id = a.id)
                OR COALESCE(a.scheduled_end, a.scheduled_for + make_interval(mins => COALESCE(a.duration_minutes, 0))) < now()
               ) AS is_protected
        FROM appointments a
        WHERE a.id = ANY (v_cand_ids)
      ) c;
    END IF;
  END IF;

  -- 13. Employees, LAST in the lock order (see the header). This must come after
  -- the sibling locks: a manual-hours insert holds its appointment and then
  -- takes a key-share lock on the employee row through its foreign key, so
  -- locking employees before appointments here deadlocked against it
  -- (found by the randomized concurrency test in test-db/). Still before the
  -- first write, so an ineligible employee rejects with nothing to roll back.
  IF cardinality(CASE WHEN v_freq = 'one_time' THEN v_to_add ELSE v_desired_emps END) > 0 THEN
    PERFORM 1 FROM employees
    WHERE id = ANY (CASE WHEN v_freq = 'one_time' THEN v_to_add ELSE v_desired_emps END)
    ORDER BY id FOR UPDATE;
    SELECT COUNT(*) INTO v_ineligible_ct
    FROM unnest(CASE WHEN v_freq = 'one_time' THEN v_to_add ELSE v_desired_emps END) AS want
    WHERE NOT EXISTS (
      SELECT 1 FROM employees WHERE id = want AND workspace_id = p_workspace_id AND active = TRUE
    );
    IF v_ineligible_ct > 0 THEN
      RETURN jsonb_build_object('outcome', 'employee_not_eligible');
    END IF;
  END IF;


  v_client_visible_change :=
       v_new_start IS DISTINCT FROM v_appt.scheduled_for
    OR v_new_end IS DISTINCT FROM v_appt.scheduled_end
    OR v_service IS DISTINCT FROM v_appt.service_type
    OR v_desired_emps IS DISTINCT FROM v_current_emps;

  -- 14. Writes. Every validation is behind us; any RC001 raised below rolls
  -- back exactly these writes.
  BEGIN
    IF cardinality(v_cancel_ids) > 0 THEN
      UPDATE appointments SET status = 'cancelled'
      WHERE id = ANY (v_cancel_ids) AND workspace_id = p_workspace_id;
      GET DIAGNOSTICS v_cancelled_ct = ROW_COUNT;
    END IF;

    IF v_old_found AND v_old_series.status = 'active' THEN
      UPDATE recurring_series
      SET status = 'stopped', stopped_at = now(), review_reason = NULL, updated_at = now()
      WHERE id = v_old_series.id AND workspace_id = p_workspace_id AND status = 'active';
      v_old_stopped := FOUND;
    END IF;

    IF v_freq <> 'one_time' THEN
      v_new_series := gen_random_uuid();
    END IF;

    -- migrations/035: reminder_24h_sent_at is reset to NULL here too -- see
    -- this migration's own header comment. Every other field in this SET
    -- list was already unconditionally rewritten to the request's new
    -- values; this column now is too, so an appointment moved to a new
    -- scheduled_for by this function is never silently excluded from a
    -- future 24h reminder just because it (or an earlier occurrence sharing
    -- this same row id) was already reminded once before.
    UPDATE appointments
    SET scheduled_for  = v_new_start,
        scheduled_end  = v_new_end,
        service_type   = v_service,
        notes          = v_notes,
        duration_minutes = v_duration,
        price_cents    = v_price,
        team_color     = v_color,
        status         = 'scheduled',
        employee_id    = CASE WHEN cardinality(v_desired_emps) = 1 THEN v_desired_emps[1] ELSE NULL END,
        frequency_type = v_freq,
        repeat_weeks   = CASE WHEN v_freq = 'weekly' THEN v_weeks ELSE 1 END,
        repeat_months  = CASE WHEN v_freq = 'monthly' THEN v_months ELSE NULL END,
        series_id      = v_new_series,
        reminder_24h_sent_at = NULL
    WHERE id = p_appointment_id AND workspace_id = p_workspace_id;

    -- Assignment DIFF (never a delete-and-reinsert: recorded work on a kept
    -- assignment must survive).
    IF cardinality(v_to_remove) > 0 THEN
      DELETE FROM appointment_employees
      WHERE appointment_id = p_appointment_id AND employee_id = ANY (v_to_remove);
    END IF;
    IF cardinality(v_to_add) > 0 THEN
      INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id)
      SELECT p_appointment_id, e, p_workspace_id FROM unnest(v_to_add) e;
    END IF;

    IF v_freq <> 'one_time' THEN
      -- Durable exclusions: the old series' own exclusions plus every instant
      -- still occupied by a live (non-cancelled) occurrence of the old series.
      v_exclusions := ARRAY(
        SELECT DISTINCT x FROM (
          SELECT unnest(CASE WHEN v_old_found THEN v_old_series.excluded_occurrences ELSE ARRAY[]::TIMESTAMPTZ[] END) AS x
          UNION ALL
          SELECT a.scheduled_for
          FROM appointments a
          WHERE v_disc_series IS NOT NULL
            AND a.series_id = v_disc_series
            AND a.workspace_id = p_workspace_id
            AND a.id <> p_appointment_id
            AND a.status <> 'cancelled'
        ) u
        WHERE x IS NOT NULL
        ORDER BY x
      );

      INSERT INTO recurring_series (
        id, workspace_id, status, client_id, is_demo, template_appointment_id,
        frequency_type, repeat_weeks, repeat_months,
        anchor_local_date, anchor_local_time, anchor_timezone, source,
        reviewed_at, excluded_occurrences, superseded_series_id
      ) VALUES (
        v_new_series, p_workspace_id, 'review_required', v_client_id, v_appt.is_demo, p_appointment_id,
        v_freq,
        CASE WHEN v_freq = 'weekly' THEN v_weeks ELSE NULL END,
        CASE WHEN v_freq = 'monthly' THEN v_months ELSE NULL END,
        (v_new_start AT TIME ZONE v_tz)::DATE, (v_new_start AT TIME ZONE v_tz)::TIME, v_tz, 'owner_created',
        NULL, v_exclusions,
        CASE WHEN v_old_found THEN v_old_series.id ELSE NULL END
      );

      WITH inserted_appts AS (
        INSERT INTO appointments (
          client_id, service_type, scheduled_for, scheduled_end, notes, cancel_token,
          status, is_demo, workspace_id, duration_minutes, series_id, frequency_type,
          repeat_weeks, repeat_months, employee_id, price_cents, team_color
        )
        SELECT
          v_client_id, v_service, occ,
          CASE WHEN v_new_end IS NULL THEN NULL ELSE occ + (v_new_end - v_new_start) END,
          v_notes,
          replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', ''),
          'scheduled', v_appt.is_demo, p_workspace_id, v_duration, v_new_series, v_freq,
          CASE WHEN v_freq = 'weekly' THEN v_weeks ELSE 1 END,
          CASE WHEN v_freq = 'monthly' THEN v_months ELSE NULL END,
          CASE WHEN cardinality(v_desired_emps) = 1 THEN v_desired_emps[1] ELSE NULL END,
          v_price, v_color
        FROM unnest(v_occ) occ
        WHERE occ <> ALL (v_exclusions)
        ON CONFLICT (series_id, scheduled_for) WHERE series_id IS NOT NULL DO NOTHING
        RETURNING id
      ),
      inserted_assignments AS (
        INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id)
        SELECT ia.id, e, p_workspace_id
        FROM inserted_appts ia CROSS JOIN unnest(v_desired_emps) e
        RETURNING 1
      )
      SELECT (SELECT COUNT(*)::INTEGER FROM inserted_appts),
             (SELECT COUNT(*)::INTEGER FROM inserted_assignments)
      INTO v_created_ct, v_bad_ct;

      v_skipped_excl := cardinality(v_occ) - v_created_ct;

      v_act := activate_recurring_series(
        v_new_series, p_workspace_id, v_client_id, p_appointment_id,
        v_service, v_price, v_duration, v_notes, v_color, v_new_start,
        v_desired_emps, v_tz
      );
      IF v_act IS DISTINCT FROM 'activated' THEN
        RAISE EXCEPTION 'activation_failed' USING ERRCODE = 'RC001', DETAIL = COALESCE(v_act, 'null');
      END IF;
    END IF;

    v_result := jsonb_build_object(
      'outcome', 'applied',
      'operation_id', p_operation_id,
      'appointment_id', p_appointment_id,
      'previous_scheduled_for', v_prev_start,
      'previous_series_id', v_disc_series,
      'new_series_id', v_new_series,
      'old_series_stopped', v_old_stopped,
      'cancelled_count', v_cancelled_ct,
      'protected_count', v_protected_ct,
      'protected', v_protected,
      'created_count', v_created_ct,
      'skipped_for_exclusion_count', v_skipped_excl,
      'client_visible_change', v_client_visible_change
    );

    INSERT INTO recurrence_change_operations (id, workspace_id, appointment_id, request_fingerprint, result)
    VALUES (p_operation_id, p_workspace_id, p_appointment_id, v_fingerprint, v_result);

    RETURN v_result;
  EXCEPTION WHEN SQLSTATE 'RC001' THEN
    -- The subtransaction's writes are already rolled back at this point.
    RETURN jsonb_build_object('outcome', 'rolled_back', 'reason', SQLERRM);
  END;
END;
$fn$;

REVOKE ALL ON FUNCTION apply_recurrence_change(UUID, UUID, UUID, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_recurrence_change(UUID, UUID, UUID, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION apply_recurrence_change(UUID, UUID, UUID, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION apply_recurrence_change(UUID, UUID, UUID, JSONB, JSONB) TO service_role;

COMMIT;
