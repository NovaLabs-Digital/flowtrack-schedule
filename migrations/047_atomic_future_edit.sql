-- 047: "This & future" edits saved in ONE transaction.
--
-- Until now app/api/appointments/update/route.ts saved a This & future edit
-- as a chain of separate PostgREST calls: put the series on hold, update the
-- edited visit, sync its staff, update each later visit (and its staff), then
-- re-confirm the series. A failure partway through (a database error, a
-- timeout, a lost connection) left a PARTIAL edit: some visits at the new
-- time, the rest at the old one, and the series on hold (reproduced
-- 2026-11-11 in test-db/scheduling_issues.test.ts).
--
-- apply_future_edit applies the whole edit, already planned by the route
-- (business-local moves and the series consistency check need Luxon and
-- stay in TypeScript), inside one transaction:
--
--   1. Lock, in the global order used by every series function (see 029):
--      recurring_series -> clients -> the edited appointment -> the later
--      appointments (scheduled_for order). Staff rows and employees are
--      locked afterwards by sync_appointment_assignments / activation.
--   2. Re-check under those locks that nothing changed since the route read
--      it: the edited visit's series, status and time, and the EXACT set of
--      later scheduled visits with their times. Otherwise 'state_changed',
--      with no write.
--   3. Write: hold the series if it is active, update the edited visit,
--      update every later visit, sync staff where the route found a change,
--      and re-confirm the series when the route's check found the result
--      consistent. Moving a visit clears its reminder flags, as the route
--      always did.
--
-- An expected refusal after writes began (a staff sync that no longer
-- applies) raises RC001 inside a subtransaction, so its writes roll back and
-- the outcome is returned. Any unexpected error aborts the whole call, so
-- PostgREST rolls the transaction back: either everything is saved, or
-- nothing is.
--
-- Additive only (one new function). Rolling back the app does not require
-- dropping it. SECURITY INVOKER, service_role only (same reasoning as
-- 027a/029).

CREATE OR REPLACE FUNCTION apply_future_edit(
  p_workspace_id            UUID,
  p_appointment_id          UUID,
  p_expected_scheduled_for  TIMESTAMPTZ,
  p_anchor                  JSONB,   -- fields to set on the edited visit; a key's presence means "set"
  p_siblings                JSONB,   -- [{id, expected_scheduled_for, expected_scheduled_end, scheduled_for?, scheduled_end?}]
  p_sibling_fields          JSONB,   -- fields copied onto every later visit; presence means "set"
  p_assignments             JSONB,   -- [{appointment_id, expected: uuid[], desired: uuid[]}], only where staff change
  p_activation              JSONB    -- NULL = leave a held series on hold; else the planned template snapshot
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_series_id     UUID;
  v_client_id     UUID;
  v_series        recurring_series%ROWTYPE;
  v_anchor        appointments%ROWTYPE;
  v_was_active    BOOLEAN := false;
  v_live_ct       INTEGER;
  v_match_ct      INTEGER;
  v_planned_ct    INTEGER;
  v_updated_ct    INTEGER;
  v_new_start     TIMESTAMPTZ;
  v_item          JSONB;
  v_sync          TEXT;
  v_act           TEXT;
  v_warning       BOOLEAN := false;
BEGIN
  IF p_workspace_id IS NULL OR p_appointment_id IS NULL OR p_expected_scheduled_for IS NULL
     OR p_anchor IS NULL OR jsonb_typeof(p_anchor) <> 'object'
     OR p_siblings IS NULL OR jsonb_typeof(p_siblings) <> 'array'
     OR p_sibling_fields IS NULL OR jsonb_typeof(p_sibling_fields) <> 'object'
     OR p_assignments IS NULL OR jsonb_typeof(p_assignments) <> 'array'
     OR (p_activation IS NOT NULL AND jsonb_typeof(p_activation) <> 'object') THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  -- Unlocked discovery of the series and client, re-checked under lock.
  SELECT series_id, client_id INTO v_series_id, v_client_id
  FROM appointments WHERE id = p_appointment_id AND workspace_id = p_workspace_id;
  IF NOT FOUND OR v_series_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'state_changed');
  END IF;

  -- 1. Locks, in the global order.
  SELECT * INTO v_series FROM recurring_series
  WHERE id = v_series_id AND workspace_id = p_workspace_id
  FOR UPDATE;
  -- A series_id with no registry row (legacy) is still edited; there is just
  -- nothing to hold or re-confirm.

  PERFORM 1 FROM clients WHERE id = v_client_id AND workspace_id = p_workspace_id FOR UPDATE;

  SELECT * INTO v_anchor FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  -- 2. Re-check under lock.
  IF NOT FOUND
     OR v_anchor.series_id IS DISTINCT FROM v_series_id
     OR v_anchor.client_id IS DISTINCT FROM v_client_id
     OR v_anchor.status IS DISTINCT FROM 'scheduled'
     OR v_anchor.scheduled_for IS DISTINCT FROM p_expected_scheduled_for THEN
    RETURN jsonb_build_object('outcome', 'state_changed');
  END IF;

  -- Later scheduled visits, locked in time order; they must be exactly the
  -- ones the route planned, still at the times it read.
  WITH live AS (
    SELECT id, scheduled_for, scheduled_end FROM appointments
    WHERE series_id = v_series_id AND workspace_id = p_workspace_id
      AND status = 'scheduled' AND id <> p_appointment_id
      AND scheduled_for > p_expected_scheduled_for
    ORDER BY scheduled_for, id
    FOR UPDATE
  ),
  planned AS (
    SELECT (e->>'id')::uuid AS id,
           (e->>'expected_scheduled_for')::timestamptz AS exp_start,
           NULLIF(e->>'expected_scheduled_end', '')::timestamptz AS exp_end
    FROM jsonb_array_elements(p_siblings) e
  )
  SELECT (SELECT count(*) FROM live),
         (SELECT count(*) FROM live l JOIN planned p ON p.id = l.id
            AND p.exp_start = l.scheduled_for AND p.exp_end IS NOT DISTINCT FROM l.scheduled_end),
         (SELECT count(DISTINCT id) FROM planned)
  INTO v_live_ct, v_match_ct, v_planned_ct;

  IF v_live_ct <> v_planned_ct OR v_match_ct <> v_planned_ct OR v_planned_ct <> jsonb_array_length(p_siblings) THEN
    RETURN jsonb_build_object('outcome', 'state_changed');
  END IF;

  -- 3. Writes.
  BEGIN
    IF v_series.id IS NOT NULL AND v_series.status = 'active' THEN
      UPDATE recurring_series SET status = 'review_required', updated_at = now()
      WHERE id = v_series.id AND workspace_id = p_workspace_id;
      v_was_active := true;
    END IF;

    v_new_start := CASE WHEN p_anchor ? 'scheduled_for' THEN (p_anchor->>'scheduled_for')::timestamptz ELSE v_anchor.scheduled_for END;

    UPDATE appointments a SET
      service_type     = CASE WHEN p_anchor ? 'service_type'     THEN p_anchor->>'service_type' ELSE a.service_type END,
      scheduled_for    = v_new_start,
      scheduled_end    = CASE WHEN p_anchor ? 'scheduled_end'    THEN (p_anchor->>'scheduled_end')::timestamptz ELSE a.scheduled_end END,
      notes            = CASE WHEN p_anchor ? 'notes'            THEN p_anchor->>'notes' ELSE a.notes END,
      status           = CASE WHEN p_anchor ? 'status'           THEN p_anchor->>'status' ELSE a.status END,
      duration_minutes = CASE WHEN p_anchor ? 'duration_minutes' THEN (p_anchor->>'duration_minutes')::integer ELSE a.duration_minutes END,
      price_cents      = CASE WHEN p_anchor ? 'price_cents'      THEN (p_anchor->>'price_cents')::integer ELSE a.price_cents END,
      team_color       = CASE WHEN p_anchor ? 'team_color'       THEN p_anchor->>'team_color' ELSE a.team_color END,
      employee_id      = CASE WHEN p_anchor ? 'employee_id'      THEN (p_anchor->>'employee_id')::uuid ELSE a.employee_id END,
      reminder_24h_sent_at     = CASE WHEN v_new_start IS DISTINCT FROM v_anchor.scheduled_for THEN NULL ELSE a.reminder_24h_sent_at END,
      reminder_24h_claimed_at  = CASE WHEN v_new_start IS DISTINCT FROM v_anchor.scheduled_for THEN NULL ELSE a.reminder_24h_claimed_at END,
      reminder_24h_claim_token = CASE WHEN v_new_start IS DISTINCT FROM v_anchor.scheduled_for THEN NULL ELSE a.reminder_24h_claim_token END
    WHERE a.id = p_appointment_id AND a.workspace_id = p_workspace_id;

    UPDATE appointments a SET
      scheduled_for    = COALESCE(s.new_start, a.scheduled_for),
      scheduled_end    = CASE WHEN s.has_end THEN s.new_end ELSE a.scheduled_end END,
      service_type     = CASE WHEN p_sibling_fields ? 'service_type'     THEN p_sibling_fields->>'service_type' ELSE a.service_type END,
      notes            = CASE WHEN p_sibling_fields ? 'notes'            THEN p_sibling_fields->>'notes' ELSE a.notes END,
      duration_minutes = CASE WHEN p_sibling_fields ? 'duration_minutes' THEN (p_sibling_fields->>'duration_minutes')::integer ELSE a.duration_minutes END,
      price_cents      = CASE WHEN p_sibling_fields ? 'price_cents'      THEN (p_sibling_fields->>'price_cents')::integer ELSE a.price_cents END,
      team_color       = CASE WHEN p_sibling_fields ? 'team_color'       THEN p_sibling_fields->>'team_color' ELSE a.team_color END,
      employee_id      = CASE WHEN p_sibling_fields ? 'employee_id'      THEN (p_sibling_fields->>'employee_id')::uuid ELSE a.employee_id END,
      reminder_24h_sent_at     = CASE WHEN s.new_start IS DISTINCT FROM NULL AND s.new_start IS DISTINCT FROM a.scheduled_for THEN NULL ELSE a.reminder_24h_sent_at END,
      reminder_24h_claimed_at  = CASE WHEN s.new_start IS DISTINCT FROM NULL AND s.new_start IS DISTINCT FROM a.scheduled_for THEN NULL ELSE a.reminder_24h_claimed_at END,
      reminder_24h_claim_token = CASE WHEN s.new_start IS DISTINCT FROM NULL AND s.new_start IS DISTINCT FROM a.scheduled_for THEN NULL ELSE a.reminder_24h_claim_token END
    FROM (
      SELECT (e->>'id')::uuid AS id,
             (e->>'scheduled_for')::timestamptz AS new_start,
             e ? 'scheduled_end' AS has_end,
             (e->>'scheduled_end')::timestamptz AS new_end
      FROM jsonb_array_elements(p_siblings) e
    ) s
    WHERE a.id = s.id AND a.workspace_id = p_workspace_id;
    GET DIAGNOSTICS v_updated_ct = ROW_COUNT;
    IF v_updated_ct <> v_planned_ct THEN
      RAISE EXCEPTION 'state_changed' USING ERRCODE = 'RC001';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_assignments) LOOP
      IF NOT EXISTS (
        SELECT 1 WHERE (v_item->>'appointment_id')::uuid = p_appointment_id
        UNION ALL
        SELECT 1 FROM jsonb_array_elements(p_siblings) e WHERE (e->>'id')::uuid = (v_item->>'appointment_id')::uuid
      ) THEN
        RAISE EXCEPTION 'state_changed' USING ERRCODE = 'RC001';
      END IF;
      v_sync := sync_appointment_assignments(
        (v_item->>'appointment_id')::uuid,
        p_workspace_id,
        ARRAY(SELECT jsonb_array_elements_text(v_item->'expected'))::uuid[],
        ARRAY(SELECT jsonb_array_elements_text(v_item->'desired'))::uuid[]
      );
      IF v_sync IS DISTINCT FROM 'synced' THEN
        RAISE EXCEPTION '%', COALESCE(v_sync, 'state_changed') USING ERRCODE = 'RC001';
      END IF;
    END LOOP;

    IF v_was_active THEN
      IF p_activation IS NULL THEN
        v_warning := true;
      ELSE
        v_act := activate_recurring_series(
          v_series.id, p_workspace_id, v_client_id, p_appointment_id,
          p_activation->>'service_type',
          (p_activation->>'price_cents')::integer,
          (p_activation->>'duration_minutes')::integer,
          p_activation->>'notes',
          p_activation->>'team_color',
          (p_activation->>'scheduled_for')::timestamptz,
          ARRAY(SELECT jsonb_array_elements_text(p_activation->'employee_ids'))::uuid[],
          p_activation->>'timezone'
        );
        -- Not confirmed (e.g. a cleaner who has left is still on the
        -- template): the visits are saved and the series stays on hold for
        -- the owner to review -- the same result the route always gave.
        IF v_act IS DISTINCT FROM 'activated' THEN
          v_warning := true;
        END IF;
      END IF;
    END IF;

    RETURN jsonb_build_object('outcome', 'applied', 'updated_later_count', v_updated_ct, 'review_warning', v_warning);
  EXCEPTION WHEN SQLSTATE 'RC001' THEN
    -- The subtransaction's writes are already rolled back here.
    RETURN jsonb_build_object('outcome', SQLERRM);
  END;
END;
$fn$;

REVOKE ALL ON FUNCTION apply_future_edit(UUID, UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_future_edit(UUID, UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION apply_future_edit(UUID, UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION apply_future_edit(UUID, UUID, TIMESTAMPTZ, JSONB, JSONB, JSONB, JSONB, JSONB) TO service_role;
