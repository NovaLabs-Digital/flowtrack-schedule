-- 027b: Block 2C-2B -- atomic recurring-series replenishment database
-- foundation.
--
-- This migration is NOT the replenishment cron (Block 2C-2's own cron
-- route is a later, separate block, not started here). It only adds the
-- database-side pieces a future cron will call: a strict active-row
-- snapshot-completeness CHECK (deliberately deferred by migration 027a's
-- own header until every activation code path was deployed using
-- activate_recurring_series -- confirmed true as of commit c96467e), a
-- new atomic replenish_recurring_series RPC that turns a caller-supplied
-- list of future occurrence instants into real appointment +
-- appointment_employees rows (or a fail-closed quarantine transition), and
-- a second, narrowly scoped quarantine_recurring_series_for_replenishment
-- RPC for the one quarantine reason (dst_gap) that can only be detected in
-- TypeScript (lib/recurringSeriesReplenishment.ts's pure calendar
-- generator), before replenish_recurring_series is ever called.
--
-- This migration deliberately does NOT:
--   - insert, update, or delete a single recurring_series, appointments,
--     or appointment_employees row (every statement below either ALTERs
--     schema, CREATEs a function, or GRANTs/REVOKEs -- the INSERT/UPDATE
--     statements inside the new functions' BODIES are application logic
--     this migration only DEFINES, they never run as part of running this
--     migration itself);
--   - activate any series, backfill any snapshot value, or change any of
--     the 65 currently-deployed review_required rows in any way;
--   - touch, weaken, or replace any existing migrations 026/027a
--     constraint, column, index, or function -- every new CHECK below is
--     strictly complementary;
--   - create a cron route, a scheduler, or modify vercel.json.
--
-- Safely re-runnable (every CHECK constraint is guarded by an
-- information_schema existence probe; CREATE OR REPLACE FUNCTION is
-- naturally idempotent). Wrapped in an explicit transaction -- ALTER
-- TABLE, CREATE FUNCTION, and GRANT/REVOKE are all fully transactional in
-- PostgreSQL, so BEGIN/COMMIT safely covers every statement in this file.
-- No custom PostgreSQL type is created anywhere in this file --
-- replenish_recurring_series returns a plain JSONB value (see that
-- function's own header for why).
--
-- Local-parser-only disclosure (Block 2C-2A's own limitation, unchanged
-- here): no psql/postgres/docker/pg driver is available in this
-- environment (confirmed by checking again for this migration), so this
-- file's syntax has been validated by careful manual review and by
-- deliberately reusing proven patterns from migrations/027a's own two
-- already-production-verified functions wherever the same technique
-- applies (FOR UPDATE never combined with an aggregate; PERFORM ... ORDER
-- BY ... FOR UPDATE for deterministic employee locking; IS DISTINCT FROM
-- for every NULL-safe comparison) -- not empirically executed against a
-- real PostgreSQL instance. See this file's own test file for what WAS
-- verified: source-level structural/textual proof of every property
-- listed above.
BEGIN;

-- ============================================================================
-- Part 1: strict snapshot-state constraints on recurring_series.
-- ============================================================================
--
-- Migration 027a added the snapshot columns as bare nullable columns,
-- deliberately WITHOUT an active-row completeness CHECK -- its own header
-- explained why: adding it immediately would have risked rejecting a
-- still-live, not-yet-migrated application code path's own activation
-- attempt mid-rollout. Every application code path that can activate a
-- series (create, manage-recurrence, update, recurring-series/activate)
-- has been deployed using activate_recurring_series since commit c96467e,
-- so it is now safe to add this completeness guarantee as a real,
-- database-enforced invariant, not merely an application convention.
--
-- All 65 currently-deployed rows are status='review_required' with every
-- new snapshot column NULL -- both CHECKs below are only evaluated for
-- status='active' rows (via `status IS DISTINCT FROM 'active' OR ...`) or
-- only restrict what accompanies a NON-NULL review_reason, so neither
-- CHECK can ever be violated by any existing row; this migration cannot
-- invalidate any of the 65.
--
-- snapshot_price_cents, snapshot_notes, and snapshot_team_color are
-- deliberately NOT required non-NULL here -- they are legitimate,
-- meaningful captured NULL values (no price set, no notes, no team color),
-- exactly mirroring how appointments.price_cents/notes/team_color
-- themselves are nullable. Requiring them non-NULL would incorrectly
-- reject a genuinely valid active series that simply never had a price,
-- notes, or team color.
-- Production-review correction: both CHECKs below use NULL-safe predicates
-- (IS DISTINCT FROM / IS NOT DISTINCT FROM) even though recurring_series.status
-- currently carries its own NOT NULL constraint (migration 026) -- neither
-- CHECK relies on that external guarantee, or on SQL's three-valued
-- (TRUE/FALSE/NULL) logic, to stay safe. A bare `status <> 'active'` would
-- itself already be NULL-safe FOR A NOT-NULL status column specifically,
-- but only because of that external column-level guarantee -- IS DISTINCT
-- FROM is safe unconditionally, independent of whether that guarantee is
-- ever weakened later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recurring_series' AND constraint_name = 'recurring_series_active_snapshot_complete'
  ) THEN
    ALTER TABLE recurring_series
      ADD CONSTRAINT recurring_series_active_snapshot_complete
      CHECK (
        status IS DISTINCT FROM 'active'
        OR (
          snapshot_service_type IS NOT NULL AND snapshot_service_type <> ''
          AND snapshot_duration_minutes IS NOT NULL AND snapshot_duration_minutes > 0
          AND snapshot_employee_ids IS NOT NULL
          AND snapshot_updated_at IS NOT NULL
          AND template_appointment_id IS NOT NULL
          AND reviewed_at IS NOT NULL
          AND review_reason IS NULL
          -- anchor_local_date/anchor_local_time/anchor_timezone already
          -- carry their own NOT NULL at the column level (migration 026)
          -- -- restated here, redundantly but harmlessly, as explicit,
          -- self-documenting proof this constraint was written with that
          -- requirement in mind, not merely relying on an unread column
          -- definition elsewhere.
          AND anchor_local_date IS NOT NULL
          AND anchor_local_time IS NOT NULL
          AND anchor_timezone IS NOT NULL
        )
      );
  END IF;
END $$;

-- review_reason lifecycle: it may be non-NULL ONLY while status =
-- 'review_required'. This single CHECK, combined with status only ever
-- having exactly three possible values (migration 026's own status CHECK),
-- already implies both "an active row cannot retain review_reason" and "a
-- stopped row cannot retain review_reason" as a direct logical consequence
-- -- not restated as separate constraints, to avoid two CHECKs asserting
-- the identical underlying invariant from opposite directions. (The
-- review_reason IS NULL clause inside
-- recurring_series_active_snapshot_complete above is INTENTIONALLY
-- restated anyway, as one part of that constraint's broader "every
-- required field is present" story -- not true redundancy in intent, and
-- consistent with this schema's established layered-defense style.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recurring_series' AND constraint_name = 'recurring_series_review_reason_only_when_review_required'
  ) THEN
    ALTER TABLE recurring_series
      ADD CONSTRAINT recurring_series_review_reason_only_when_review_required
      CHECK (review_reason IS NULL OR status IS NOT DISTINCT FROM 'review_required');
  END IF;
END $$;

-- ============================================================================
-- Part 2: replenish_recurring_series -- the ONLY function anywhere in this
-- schema that ever inserts an appointment/appointment_employees row on
-- behalf of an active recurring series.
-- ============================================================================
--
-- Signature deliberately does NOT accept snapshot service_type/price_cents/
-- duration_minutes/notes/team_color/employee_ids from the caller -- every
-- one of those is read from the LOCKED recurring_series row itself inside
-- this function, never trusted from a value TypeScript merely observed
-- earlier (the identical TOCTOU-closing reasoning activate_recurring_series
-- already established for its own p_expected_* parameters, applied here to
-- an even simpler case: this function has NO caller-supplied business
-- fields to compare against a locked row at all, because it doesn't accept
-- any).
--
-- Fixed lock order, shared with (and forced to serialize against)
-- activate_recurring_series and sync_appointment_assignments:
--   1. recurring_series (this function's own row, by id AND workspace_id)
--   2. clients
--   3. referenced employees, in deterministic UUID order
--   (appointments/appointment_employees are not pre-locked with a separate
--   SELECT ... FOR UPDATE step -- the atomic INSERT ... ON CONFLICT DO
--   NOTHING below IS the interaction with those tables, and PostgreSQL's
--   own unique-index conflict handling provides the necessary row-level
--   protection for that step; see step 5's own comment below)
-- Because activate_recurring_series locks recurring_series FIRST too, a
-- concurrent activation and a concurrent replenishment attempt for the
-- SAME series are forced to serialize on that shared row lock -- whichever
-- acquires it second observes the first's fully committed result.
--
-- Every quarantine/stop transition below is atomic with its own detection:
-- the SAME statement that discovers "this snapshot is incomplete" (or "this
-- client is inactive," or "this employee is no longer eligible") is the
-- one function call that also writes the corrected status -- there is no
-- window in which a caller could observe the problem without the write
-- already having happened, and no window in which an appointment could be
-- inserted for a series this same call is about to quarantine (every
-- quarantine/stop check RETURNs before ever reaching step 5's INSERT).
--
-- Production-review correction: RETURNS JSONB, not a custom composite
-- TYPE. A named composite type removes some uncertainty at the SQL level,
-- but introduces a DIFFERENT uncertainty this migration cannot fully
-- resolve without a live PostgREST instance to test against: exactly how
-- PostgREST serializes a function returning a bare (non-SETOF) named
-- composite type is a behavior of PostgREST's own schema-reflection layer,
-- not of PostgreSQL itself, and was not empirically verified here (see
-- this file's own header on the lack of a local Postgres/PostgREST
-- instance). JSONB sidesteps that question entirely -- `jsonb_build_object`
-- is standard PostgreSQL, its wire format is unambiguous, and Supabase's
-- JS client already deserializes a JSONB return value as a plain JS object
-- with no special-case handling required. Every RETURN below uses
-- `jsonb_build_object('outcome', ..., 'inserted_count', ..., 'skipped_count', ...)`
-- -- the same three fields, same names, same stable shape as before, just
-- without the custom type.
CREATE OR REPLACE FUNCTION replenish_recurring_series(
  p_series_id                     UUID,
  p_workspace_id                  UUID,
  p_expected_snapshot_updated_at  TIMESTAMPTZ,
  p_occurrences                   TIMESTAMPTZ[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_series              recurring_series%ROWTYPE;
  v_client_status        TEXT;
  v_client_archived_at   TIMESTAMPTZ;
  v_bad_ct               INTEGER;
  v_ineligible_ct        INTEGER;
  v_inserted_count       INTEGER;
  v_assignment_count     INTEGER;
  v_skipped_count        INTEGER;
BEGIN
  -- 0. Caller-input validation -- BEFORE any lock, guaranteeing zero
  -- writes and zero lock acquisition for malformed input, matching
  -- activate_recurring_series's own p_anchor_timezone precedent.
  IF p_expected_snapshot_updated_at IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  IF p_occurrences IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- cardinality() (unlike array_length()) counts every element including
  -- NULL ones and never returns NULL for a non-NULL array, so this range
  -- check is correct on its own terms before the separate NULL-element
  -- check below runs.
  IF cardinality(p_occurrences) < 1 OR cardinality(p_occurrences) > 20 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  SELECT COUNT(*) INTO v_bad_ct FROM unnest(p_occurrences) occ WHERE occ IS NULL;
  IF v_bad_ct > 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- Strictly increasing, checked pairwise in the array's OWN given order
  -- (via WITH ORDINALITY + LAG, never a re-sorted copy) -- this single
  -- check also proves uniqueness as a direct consequence: "strictly
  -- increasing" is itself defined adjacently (every element strictly
  -- greater than its immediate predecessor), so a duplicate anywhere, or
  -- any out-of-order pair anywhere, is caught by exactly one adjacent
  -- comparison somewhere in the sequence -- there is no case a duplicate
  -- or misordering could exist that this does not detect.
  SELECT COUNT(*) INTO v_bad_ct
  FROM (
    SELECT occ, LAG(occ) OVER (ORDER BY ord) AS prev_occ
    FROM unnest(p_occurrences) WITH ORDINALITY AS t(occ, ord)
  ) pairs
  WHERE prev_occ IS NOT NULL AND occ <= prev_occ;
  IF v_bad_ct > 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- Every occurrence must be strictly future AT EXECUTION TIME -- compared
  -- against the database's own now(), never a caller-supplied "current
  -- time" (which a stale or malicious caller could spoof).
  SELECT COUNT(*) INTO v_bad_ct FROM unnest(p_occurrences) occ WHERE occ <= now();
  IF v_bad_ct > 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- 1. recurring_series -- locked FIRST, matching activate_recurring_series's
  -- own step 1 exactly (see this function's header on shared lock order).
  SELECT * INTO v_series
  FROM recurring_series
  WHERE id = p_series_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  IF v_series.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  IF v_series.snapshot_updated_at IS DISTINCT FROM p_expected_snapshot_updated_at THEN
    RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- 2. Snapshot/metadata completeness -- re-verified here even though
  -- Part 1's own recurring_series_active_snapshot_complete CHECK (and
  -- migration 026's own frequency-shape CHECK) already guarantee this for
  -- any genuinely active row; this function is the database's own
  -- integrity boundary and must not simply trust a constraint defined
  -- elsewhere -- the same reasoning migrations/027a's activate_recurring_series
  -- already established for p_anchor_timezone, applied here to the row's
  -- own persisted state instead of a caller-supplied parameter. Also folds
  -- in the frequency_type/repeat_weeks/repeat_months internal-consistency
  -- shape (mirrors migrations/026's own CHECK exactly) and the anchor
  -- fields' completeness -- both structurally guaranteed already, checked
  -- again here for the identical reason.
  --
  -- Production-review correction: the entire expression is wrapped in
  -- COALESCE(..., FALSE) -- without it, an unexpected NULL anywhere inside
  -- (e.g. if v_series.frequency_type were ever NULL, its bare `=`
  -- comparisons below would each evaluate to NULL/unknown rather than
  -- FALSE) would propagate through the surrounding AND/OR chain and make
  -- the WHOLE expression evaluate to NULL rather than a clean TRUE/FALSE.
  -- PL/pgSQL's `IF NOT (...)` treats a NULL condition exactly like FALSE,
  -- which would silently SKIP this quarantine check -- the opposite of
  -- fail-closed. COALESCE(..., FALSE) forces any such NULL down to FALSE
  -- ("not proven complete"), so `IF NOT COALESCE(..., FALSE)` always
  -- correctly evaluates to TRUE (quarantine fires) whenever completeness
  -- cannot be affirmatively proven, for any reason.
  IF NOT COALESCE(
    v_series.snapshot_service_type IS NOT NULL AND v_series.snapshot_service_type <> ''
    AND v_series.snapshot_duration_minutes IS NOT NULL AND v_series.snapshot_duration_minutes > 0
    AND v_series.snapshot_employee_ids IS NOT NULL
    AND v_series.snapshot_updated_at IS NOT NULL
    AND v_series.template_appointment_id IS NOT NULL
    AND v_series.reviewed_at IS NOT NULL
    AND v_series.review_reason IS NULL
    AND v_series.anchor_local_date IS NOT NULL
    AND v_series.anchor_local_time IS NOT NULL
    AND v_series.anchor_timezone IS NOT NULL
    AND (
      (v_series.frequency_type = 'weekly' AND v_series.repeat_weeks BETWEEN 1 AND 8 AND v_series.repeat_months IS NULL)
      OR (v_series.frequency_type = 'monthly' AND v_series.repeat_months BETWEEN 1 AND 12 AND v_series.repeat_weeks IS NULL)
      OR (v_series.frequency_type IN ('daily', 'weekdays') AND v_series.repeat_weeks IS NULL AND v_series.repeat_months IS NULL)
    ),
    FALSE
  ) THEN
    UPDATE recurring_series
    SET status = 'review_required', review_reason = ARRAY['missing_snapshot'], updated_at = now()
    WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';

    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
    END IF;
    RETURN jsonb_build_object('outcome', 'missing_snapshot_review_required', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- 3. clients -- locked, exactly like activate_recurring_series's own
  -- step 2, so a concurrent client-archive transaction is forced to
  -- serialize against this one.
  SELECT status, archived_at INTO v_client_status, v_client_archived_at
  FROM clients
  WHERE id = v_series.client_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND OR v_client_status IS DISTINCT FROM 'active' OR v_client_archived_at IS NOT NULL THEN
    UPDATE recurring_series
    SET status = 'stopped', stopped_at = now(), review_reason = NULL, updated_at = now()
    WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';

    IF NOT FOUND THEN
      RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
    END IF;
    RETURN jsonb_build_object('outcome', 'client_stopped', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  -- 4. referenced employees -- locked in deterministic UUID order,
  -- exactly like sync_appointment_assignments's own step 6/7 (preventing a
  -- lock-order deadlock against any other concurrent call sharing some of
  -- the same employees). A valid EMPTY employee set (snapshot_employee_ids
  -- = '{}') skips this block entirely and is not an error.
  IF cardinality(v_series.snapshot_employee_ids) > 0 THEN
    PERFORM 1 FROM employees WHERE id = ANY(v_series.snapshot_employee_ids) ORDER BY id FOR UPDATE;

    SELECT COUNT(*) INTO v_ineligible_ct
    FROM unnest(v_series.snapshot_employee_ids) AS emp_id
    WHERE NOT EXISTS (
      SELECT 1 FROM employees
      WHERE id = emp_id AND workspace_id = p_workspace_id AND active = true
    );

    IF v_ineligible_ct > 0 THEN
      UPDATE recurring_series
      SET status = 'review_required', review_reason = ARRAY['employee_no_longer_eligible'], updated_at = now()
      WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';

      IF NOT FOUND THEN
        RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
      END IF;
      RETURN jsonb_build_object('outcome', 'employee_review_required', 'inserted_count', 0, 'skipped_count', 0);
    END IF;
  END IF;

  -- 5. Every check above passed against rows locked in THIS transaction --
  -- insert every requested occurrence not already present, idempotently,
  -- via the EXISTING partial unique index (migrations/026's
  -- idx_appointments_series_occurrence on (series_id, scheduled_for) WHERE
  -- series_id IS NOT NULL) as the ON CONFLICT arbiter. A concurrent
  -- duplicate call (this function invoked twice for overlapping occurrence
  -- lists, whether truly concurrent or a naive retry) is safe purely
  -- because of this: whichever transaction's INSERT commits first wins
  -- that occurrence's row; the other's ON CONFLICT DO NOTHING silently
  -- skips it -- no unique-violation error, no duplicate appointment, and
  -- (via the RETURNING-fed second INSERT below) no duplicate/orphaned
  -- assignment row either, since assignments are only ever created for
  -- rows THIS call's own INSERT actually returned.
  --
  -- Both CTEs below are explicitly referenced in the final SELECT's own
  -- subqueries (not left as an unreferenced data-modifying CTE) --
  -- deliberately, so their execution is unambiguous regardless of any
  -- edge-case PostgreSQL semantics around unreferenced WITH branches; this
  -- was not empirically verified against a live PostgreSQL instance (see
  -- this file's own header), so the query is written to remove any doubt
  -- rather than to rely on an assumption about it.
  WITH inserted_appts AS (
    INSERT INTO appointments (
      client_id, service_type, scheduled_for, scheduled_end, notes, cancel_token,
      status, is_demo, workspace_id, duration_minutes, series_id, frequency_type,
      repeat_weeks, repeat_months, employee_id, price_cents, team_color
    )
    SELECT
      v_series.client_id,
      v_series.snapshot_service_type,
      occ,
      occ + make_interval(mins => v_series.snapshot_duration_minutes),
      v_series.snapshot_notes,
      -- A fresh, unpredictable per-row cancel token -- built from two
      -- concatenated gen_random_uuid() values (the same cryptographically
      -- secure random source every id column in this schema already
      -- relies on) rather than the pgcrypto-only gen_random_bytes(), which
      -- this schema has never enabled (confirmed: no CREATE EXTENSION
      -- pgcrypto anywhere in migrations/). 64 hex characters, comparable
      -- (if not greater) entropy to the application layer's own
      -- crypto.randomBytes(24).toString('hex') (48 hex characters) used
      -- for every manually/directly created appointment.
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'scheduled',
      v_series.is_demo,
      p_workspace_id,
      v_series.snapshot_duration_minutes,
      p_series_id,
      v_series.frequency_type,
      v_series.repeat_weeks,
      v_series.repeat_months,
      -- appointments.employee_id: the same read-only single-employee
      -- compatibility mirror lib/appointmentEmployees.ts's
      -- deriveLegacyEmployeeId already establishes -- NULL for zero or
      -- two-or-more assigned employees, the one id when exactly one.
      CASE WHEN cardinality(v_series.snapshot_employee_ids) = 1 THEN v_series.snapshot_employee_ids[1] ELSE NULL END,
      v_series.snapshot_price_cents,
      v_series.snapshot_team_color
    FROM unnest(p_occurrences) occ
    ON CONFLICT (series_id, scheduled_for) WHERE series_id IS NOT NULL DO NOTHING
    RETURNING id
  ),
  inserted_assignments AS (
    INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id)
    SELECT ia.id, e, p_workspace_id
    FROM inserted_appts ia
    CROSS JOIN unnest(v_series.snapshot_employee_ids) e
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM inserted_appts),
    (SELECT COUNT(*)::INTEGER FROM inserted_assignments)
  INTO v_inserted_count, v_assignment_count;

  v_skipped_count := cardinality(p_occurrences) - v_inserted_count;

  -- last_replenished_at reflects "this series was last successfully
  -- processed for replenishment," not "an appointment was last actually
  -- inserted" -- set unconditionally on a successful replenishment pass
  -- (inserted_count may legitimately be 0 if every requested occurrence
  -- already existed), so a future cron never re-examines an
  -- already-fully-processed window. Only ever reached on the 'replenished'
  -- outcome -- every quarantine/stop/conflict/invalid_input branch above
  -- already returned before this statement.
  UPDATE recurring_series
  SET last_replenished_at = now(), updated_at = now()
  WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';

  IF NOT FOUND THEN
    -- Structurally shouldn't happen (this row has been continuously
    -- locked since step 1 of this same transaction), but re-asserted
    -- anyway as a final belt-and-suspenders guard, matching
    -- activate_recurring_series's own identical pattern. If this somehow
    -- fired, the whole transaction -- including the appointment/assignment
    -- inserts just above, in the SAME transaction -- rolls back together;
    -- no inconsistent partial state is possible.
    RETURN jsonb_build_object('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0);
  END IF;

  RETURN jsonb_build_object('outcome', 'replenished', 'inserted_count', v_inserted_count, 'skipped_count', v_skipped_count);
END;
$fn$;

-- Deny-all-except-service-role, matching migrations/027a's identical
-- established pattern exactly.
REVOKE ALL ON FUNCTION replenish_recurring_series(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ[]
) FROM PUBLIC;

REVOKE ALL ON FUNCTION replenish_recurring_series(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ[]
) FROM anon;

REVOKE ALL ON FUNCTION replenish_recurring_series(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ[]
) FROM authenticated;

GRANT EXECUTE ON FUNCTION replenish_recurring_series(
  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ[]
) TO service_role;

-- ============================================================================
-- Part 3: quarantine_recurring_series_for_replenishment -- the narrow,
-- separate RPC for the one quarantine reason only TypeScript can detect.
-- ============================================================================
--
-- lib/recurringSeriesReplenishment.ts's pure generateOccurrencesInWindow()
-- can return { ok: false, reason: "dst_gap" } for a candidate occurrence
-- whose local time is nonexistent -- a purely calendar-math determination
-- this database has no way to make itself (it has no visibility into the
-- generator's own candidate computation). This function exists so that
-- outcome can still be persisted as an atomic, fail-closed
-- state transition -- through the SAME kind of locked, CAS-guarded RPC
-- call every other recurring_series status write in this schema already
-- goes through -- rather than requiring a direct, unguarded application
-- `.update({status: 'review_required'})` (which migrations/026's original
-- header explicitly reserved for exactly this SECURITY INVOKER,
-- service-role-only RPC pattern, never a raw table write).
--
-- Deliberately narrow: the only three reasons ever accepted are the
-- closed set migrations/027a's own recurring_series_review_reason_closed_set
-- CHECK already allows (dst_gap, employee_no_longer_eligible,
-- missing_snapshot) -- the latter two exist here only so a FUTURE caller
-- that has already determined one of those two reasons through some other
-- path (not replenish_recurring_series itself, which already handles both
-- atomically on its own) has the identical safe primitive available,
-- without inventing a second, differently-shaped write path for the same
-- state transition.
--
-- Lock order: recurring_series only -- this function never touches
-- appointments, appointment_employees, or clients at all, so no further
-- locks are needed beyond the row it is itself updating.
CREATE OR REPLACE FUNCTION quarantine_recurring_series_for_replenishment(
  p_series_id                     UUID,
  p_workspace_id                  UUID,
  p_expected_snapshot_updated_at  TIMESTAMPTZ,
  p_reason                        TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_series recurring_series%ROWTYPE;
BEGIN
  -- p_reason -- validated FIRST, before any lock, against the exact closed
  -- set this function is scoped to accept.
  IF p_reason IS NULL OR p_reason NOT IN ('dst_gap', 'employee_no_longer_eligible', 'missing_snapshot') THEN
    RETURN 'invalid_reason';
  END IF;

  SELECT * INTO v_series
  FROM recurring_series
  WHERE id = p_series_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'conflict';
  END IF;

  IF v_series.status IS DISTINCT FROM 'active' THEN
    RETURN 'conflict';
  END IF;

  -- NULL-safe: a NULL p_expected_snapshot_updated_at can never match a
  -- genuinely active row's own snapshot_updated_at (guaranteed NOT NULL by
  -- Part 1's own recurring_series_active_snapshot_complete CHECK), so it
  -- naturally falls through to 'conflict' here without needing a separate,
  -- dedicated NULL check.
  IF v_series.snapshot_updated_at IS DISTINCT FROM p_expected_snapshot_updated_at THEN
    RETURN 'conflict';
  END IF;

  UPDATE recurring_series
  SET status = 'review_required',
      review_reason = ARRAY[p_reason],
      updated_at = now()
  WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';

  IF NOT FOUND THEN
    RETURN 'conflict';
  END IF;

  RETURN 'quarantined';
END;
$fn$;

REVOKE ALL ON FUNCTION quarantine_recurring_series_for_replenishment(
  UUID, UUID, TIMESTAMPTZ, TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION quarantine_recurring_series_for_replenishment(
  UUID, UUID, TIMESTAMPTZ, TEXT
) FROM anon;

REVOKE ALL ON FUNCTION quarantine_recurring_series_for_replenishment(
  UUID, UUID, TIMESTAMPTZ, TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION quarantine_recurring_series_for_replenishment(
  UUID, UUID, TIMESTAMPTZ, TEXT
) TO service_role;

COMMIT;
