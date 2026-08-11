-- 027a: Block 2C-1 -- immutable recurring-series snapshot foundation.
--
-- Adds eight new, additive, nullable columns to recurring_series (the
-- durable snapshot fields a series' owner-approved terms are captured into
-- at the moment it becomes active, plus review_reason for the persisted,
-- closed set of automated-quarantine reasons a later replenishment engine
-- will use) and one new PostgreSQL function, activate_recurring_series --
-- the ONLY way any recurring_series row can ever transition to
-- status='active' going forward. Every one of its validations runs against
-- rows LOCKED inside the same transaction, never a value the caller merely
-- read earlier and passed along -- see the function's own comment below.
--
-- This migration deliberately does NOT:
--   - add the active-row snapshot-completeness CHECK (that ships in a later
--     Migration 027b, only after every application code path that can
--     activate a series has actually been deployed using this RPC -- adding
--     it now would risk rejecting a still-live, not-yet-migrated code
--     path's own activation attempt mid-rollout);
--   - touch, weaken, or replace Migration 026's existing
--     "status <> 'active' OR (template_appointment_id IS NOT NULL AND
--     reviewed_at IS NOT NULL)" CHECK -- it remains exactly as it was;
--   - backfill any value into any new column;
--   - UPDATE, INSERT, or DELETE any existing recurring_series or
--     appointments row (the UPDATE statement inside the new function's
--     BODY is application logic this migration only DEFINES -- it never
--     runs as part of running this migration itself).
--
-- Safely re-runnable (ADD COLUMN IF NOT EXISTS; every CHECK constraint is
-- guarded by an information_schema existence probe; CREATE OR REPLACE
-- FUNCTION is naturally idempotent). Wrapped in an explicit transaction --
-- ALTER TABLE, CREATE FUNCTION, and GRANT/REVOKE are all fully
-- transactional in PostgreSQL, so BEGIN/COMMIT safely covers every
-- statement in this file.
BEGIN;

-- ============================================================================
-- Part 1: new nullable snapshot columns on recurring_series.
-- ============================================================================
--
-- NULL means "never captured" (every legacy-backfill and not-yet-activated
-- review_required row simply has NULL here, identical to its pre-migration
-- appearance). A captured, empty employee set is represented as '{}' (an
-- actual empty array), which is deliberately distinct from NULL -- see
-- activate_recurring_series below, which always writes a real array (never
-- NULL) on success.
ALTER TABLE recurring_series
  ADD COLUMN IF NOT EXISTS snapshot_service_type     TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_price_cents      INTEGER,
  ADD COLUMN IF NOT EXISTS snapshot_duration_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS snapshot_notes            TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_team_color       TEXT,
  ADD COLUMN IF NOT EXISTS snapshot_employee_ids     UUID[],
  ADD COLUMN IF NOT EXISTS snapshot_updated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_reason             TEXT[];

-- Additive-safe CHECKs -- every one permits NULL, so no existing row (all of
-- which have every new column NULL immediately after the ADD COLUMN above)
-- can ever violate any of these. Mirrors the exact same nonnegative-price /
-- hex-color conventions already established for appointments.price_cents
-- (migration 020) and appointments.team_color (migration 022);
-- snapshot_duration_minutes uses "> 0" rather than ">= 0" since a zero- or
-- negative-length appointment is never valid, matching the positive-only
-- meaning duration_minutes already carries everywhere else in this codebase.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recurring_series' AND constraint_name = 'recurring_series_snapshot_price_cents_nonnegative'
  ) THEN
    ALTER TABLE recurring_series
      ADD CONSTRAINT recurring_series_snapshot_price_cents_nonnegative
      CHECK (snapshot_price_cents IS NULL OR snapshot_price_cents >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recurring_series' AND constraint_name = 'recurring_series_snapshot_duration_minutes_positive'
  ) THEN
    ALTER TABLE recurring_series
      ADD CONSTRAINT recurring_series_snapshot_duration_minutes_positive
      CHECK (snapshot_duration_minutes IS NULL OR snapshot_duration_minutes > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recurring_series' AND constraint_name = 'recurring_series_snapshot_team_color_hex_format'
  ) THEN
    ALTER TABLE recurring_series
      ADD CONSTRAINT recurring_series_snapshot_team_color_hex_format
      CHECK (snapshot_team_color IS NULL OR snapshot_team_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- review_reason: NULL, or every array element must belong to the closed set
-- of Block 2C persisted, automated-quarantine reasons currently approved.
-- The 11 evaluateSeriesConsistency ConsistencyBlocker values (service_type_
-- mismatch, price_mismatch, etc.) are deliberately NOT included here -- those
-- remain an ephemeral, request-time rejection reason for a failed
-- Activation/This & Future attempt, returned directly in that one request's
-- own HTTP response, never written to this column. review_reason applies
-- only to review_required rows; activate_recurring_series always clears it
-- to NULL on every successful activation (see below).
--
-- Production-review correction: a bare `review_reason <@ ARRAY[...]` is NOT
-- sufficient on its own. PostgreSQL's array containment operators compare
-- element-by-element, and a NULL element never definitively equals anything
-- (including another NULL) -- so `<@` can evaluate to NULL (unknown) rather
-- than a clean FALSE when the array contains a NULL, and a CHECK constraint
-- only REJECTS a row when its expression evaluates to FALSE; NULL/unknown
-- PASSES. `ARRAY['dst_gap', NULL]` could therefore evade this allowlist
-- entirely.
--
-- The corrected constraint below does NOT use `<@`, and deliberately does
-- NOT use a subquery/unnest() either -- PostgreSQL CHECK constraints cannot
-- contain a subquery AT ALL (a hard, unconditional restriction: "cannot use
-- subquery in check constraint"), so a `NOT EXISTS (SELECT ... FROM
-- unnest(...))`-style guard, however tempting, would fail outright the
-- moment this ALTER TABLE ran -- not silently accept bad data, but refuse
-- to even create the constraint. Instead this uses only cardinality() and
-- array_positions() (both plain, non-subquery array functions), searching
-- for each of the three known, non-NULL literal reasons individually. A
-- search for a specific non-null literal (e.g. 'dst_gap') can never match a
-- NULL array element under any equality semantics -- NULL is never equal to
-- (nor "not distinct from") a real string -- so this sidesteps any question
-- of how array_positions itself treats a NULL *search target*, which is
-- irrelevant here since NULL is never the search target.
--
--   cardinality(review_reason) = the summed count of matches across all
--   three known values  -->  every element is one of the three (a NULL or
--   an unrecognized string would be counted in cardinality() but matched by
--   none of the three array_positions() calls, making the two sides
--   unequal);
--
--   each individual array_positions(...) count is <= 1  -->  no reason
--   repeats.
--
-- cardinality() (unlike array_length()) returns 0, never NULL, for a
-- non-NULL empty array -- so no COALESCE is needed, and '{}' satisfies
-- every condition below vacuously (0 = 0+0+0, and 0 <= 1 three times) --
-- deliberately still permitted; nothing in this design requires
-- review_reason to be non-empty once non-NULL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'recurring_series' AND constraint_name = 'recurring_series_review_reason_closed_set'
  ) THEN
    ALTER TABLE recurring_series
      ADD CONSTRAINT recurring_series_review_reason_closed_set
      CHECK (
        review_reason IS NULL
        OR (
          cardinality(review_reason) = (
            cardinality(array_positions(review_reason, 'dst_gap'))
            + cardinality(array_positions(review_reason, 'employee_no_longer_eligible'))
            + cardinality(array_positions(review_reason, 'missing_snapshot'))
          )
          AND cardinality(array_positions(review_reason, 'dst_gap')) <= 1
          AND cardinality(array_positions(review_reason, 'employee_no_longer_eligible')) <= 1
          AND cardinality(array_positions(review_reason, 'missing_snapshot')) <= 1
        )
      );
  END IF;
END $$;

-- ============================================================================
-- Part 2: activate_recurring_series -- the ONLY function anywhere in this
-- schema that ever sets recurring_series.status = 'active'.
-- ============================================================================
--
-- Replaces the prior application-level pattern (lib/recurringSeries.ts's old
-- finalizeSeriesActive: a plain JS function reading a client row, then
-- issuing a single compare-and-set UPDATE) with a single atomic PostgreSQL
-- transaction. That prior pattern still permitted the template appointment's
-- own fields, its employee assignments, and the client's active/archived
-- state to change in the window between TypeScript reading them and the
-- final UPDATE actually running -- a real, exploitable TOCTOU gap, not a
-- theoretical one. This function closes it by locking every row it depends
-- on (FOR UPDATE) inside ONE transaction, then comparing the ACTUAL locked
-- state against explicit expected-value parameters TypeScript supplies --
-- never a concatenated/joined string "fingerprint" (ambiguous the moment
-- notes contains a delimiter character, an empty string, or NULL) -- before
-- ever writing anything.
--
-- TypeScript still owns evaluateSeriesConsistency (lib/recurringSeries.ts)
-- entirely unchanged -- the multi-occurrence "do all of this series' live
-- appointments agree with each other" comparison is not reimplemented here
-- in SQL, and never will be; this function's only job is to prove that the
-- ONE row TypeScript is about to snapshot from is still exactly what
-- TypeScript already validated, atomically, at the moment of the write.
--
-- Fixed, global lock order (shared with every future RPC this schema ever
-- adds that touches more than one of these tables together, specifically so
-- two concurrent transactions can never deadlock against each other):
--   1. recurring_series
--   2. clients
--   3. the template appointment
--   4. its appointment_employees assignment rows
--   5. the referenced employees rows
--
-- Every early exit returns a plain, closed-set TEXT outcome -- never a raw
-- SQL/database error, never partial state. Because nothing is written until
-- the single final UPDATE (every step before it only takes read locks via
-- FOR UPDATE / SELECT ... FOR UPDATE), a function that returns early always
-- leaves the row exactly as it already was: still review_required, with
-- whatever snapshot/review_reason values it already had, completely
-- untouched.
CREATE OR REPLACE FUNCTION activate_recurring_series(
  p_series_id                 UUID,
  p_workspace_id               UUID,
  p_client_id                  UUID,
  p_template_appointment_id    UUID,
  p_expected_service_type      TEXT,
  p_expected_price_cents       INTEGER,
  p_expected_duration_minutes  INTEGER,
  p_expected_notes             TEXT,
  p_expected_team_color        TEXT,
  p_expected_scheduled_for     TIMESTAMPTZ,
  p_expected_employee_ids      UUID[],
  p_anchor_timezone            TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_series               recurring_series%ROWTYPE;
  v_client_status         TEXT;
  v_client_archived_at    TIMESTAMPTZ;
  v_template              appointments%ROWTYPE;
  v_actual_employee_ids   UUID[];
  v_expected_canonical    UUID[];
  v_expected_distinct_ct  INTEGER;
  v_ineligible_ct         INTEGER;
BEGIN
  -- 0. p_anchor_timezone -- validated FIRST, before acquiring any lock, and
  -- independently of the caller: TypeScript always resolves this via
  -- effectiveTimezone() (lib/timezone.ts), which already never returns
  -- anything outside this exact 7-zone allowlist -- but this function is
  -- the database's own integrity boundary and must not simply trust that.
  -- Matches recurring_series.anchor_timezone's own CHECK constraint
  -- (migration 026) exactly, so a value this function accepts can never
  -- itself violate that column's constraint at write time. Rejecting here,
  -- before any lock, guarantees zero writes and zero lock acquisition for a
  -- malformed timezone -- status, every snapshot_* column,
  -- template_appointment_id, anchor fields, reviewed_at, and review_reason
  -- are all left completely untouched.
  IF p_anchor_timezone IS NULL OR p_anchor_timezone NOT IN (
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'
  ) THEN
    RETURN 'invalid_timezone';
  END IF;

  -- 1. recurring_series -- the row this whole call is about. A missing row
  -- (wrong id/workspace) and a row that isn't currently review_required are
  -- two DIFFERENT outcomes: the first means the caller's own identity
  -- claim doesn't resolve to anything real ("state_changed"); the second
  -- means it resolves to something real that just isn't eligible to
  -- transition anymore ("conflict") -- matching the exact same distinction
  -- the prior JS implementation's compare-and-set already made.
  SELECT * INTO v_series
  FROM recurring_series
  WHERE id = p_series_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'state_changed';
  END IF;

  -- Production-review correction: IS DISTINCT FROM, not a bare `<>` --
  -- recurring_series.status carries a NOT NULL constraint (migration 026),
  -- so this particular gap is not currently reachable, but a bare `<>`
  -- would still evaluate to NULL/unknown (which PL/pgSQL's IF treats as
  -- FALSE) if that constraint were ever weakened -- this function is the
  -- database's own integrity boundary and must not rely on a constraint
  -- defined elsewhere to keep its own comparisons total.
  IF v_series.status IS DISTINCT FROM 'review_required' THEN
    RETURN 'conflict';
  END IF;

  IF v_series.client_id IS DISTINCT FROM p_client_id THEN
    RETURN 'state_changed';
  END IF;

  -- 2. clients -- locked (not merely read) so a concurrent client-archive
  -- transaction is forced to serialize against this one: whichever commits
  -- first is what the other one correctly observes, instead of both racing
  -- against an unlocked read.
  SELECT status, archived_at INTO v_client_status, v_client_archived_at
  FROM clients
  WHERE id = p_client_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'state_changed';
  END IF;

  -- Production-review correction: this must be a strict allowlist (only
  -- status = 'active' with no archived_at proceeds), not a denylist that
  -- only rejected the single known-bad literal value meaning "inactive".
  -- The prior bare equality check against that one literal left two real
  -- gaps: (1) a NULL v_client_status made the whole OR evaluate to
  -- NULL/unknown whenever archived_at was also NULL, and PL/pgSQL's IF
  -- treats NULL exactly like FALSE -- silently proceeding as though the
  -- client were active; (2) any unexpected status value other than that one
  -- known-bad literal (a typo, a future status this function doesn't yet
  -- know about) would also silently pass. IS DISTINCT FROM is NULL-safe and
  -- total (always TRUE or FALSE, never NULL), so this now rejects every
  -- value except the one explicitly allowed one.
  IF v_client_status IS DISTINCT FROM 'active' OR v_client_archived_at IS NOT NULL THEN
    RETURN 'client_not_active';
  END IF;

  -- 3. the template appointment -- identity re-verified on every dimension
  -- (id, workspace, client, series) as its own explicit condition, never
  -- inferred from any one of them alone; must still be a live, current,
  -- future occurrence at the exact moment of activation.
  SELECT * INTO v_template
  FROM appointments
  WHERE id = p_template_appointment_id
    AND workspace_id = p_workspace_id
    AND client_id = p_client_id
    AND series_id = p_series_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'state_changed';
  END IF;

  -- Production-review correction: IS DISTINCT FROM, not a bare `<>` -- a
  -- NULL v_template.status would make `<> 'scheduled'` evaluate to
  -- NULL/unknown, which PL/pgSQL's IF treats as FALSE, silently letting a
  -- template with an unreadable/unexpected status proceed as though it
  -- were a normal scheduled appointment. Any status other than exactly
  -- 'scheduled' -- NULL, 'cancelled', 'completed', or anything else -- is
  -- now rejected.
  IF v_template.status IS DISTINCT FROM 'scheduled' THEN
    RETURN 'state_changed';
  END IF;

  -- Production-review correction: a NULL v_template.scheduled_for would
  -- make a bare `<= now()` evaluate to NULL/unknown (never TRUE), silently
  -- letting a template with no recorded time proceed as though it were a
  -- valid future occurrence -- explicitly rejecting NULL here closes that
  -- gap.
  IF v_template.scheduled_for IS NULL OR v_template.scheduled_for <= now() THEN
    RETURN 'state_changed';
  END IF;

  -- Explicit expected-value comparison against the row just locked -- never
  -- a concatenated string. Every field, INCLUDING scheduled_for, uses IS
  -- DISTINCT FROM (NULL-safe: two NULLs compare equal, a NULL on either
  -- side never silently equals a real value or vanishes into NULL/unknown).
  -- Production-review correction: scheduled_for previously used a bare `<>`
  -- on the (incorrect) assumption it could never legitimately be NULL on
  -- either side. That assumption doesn't hold for p_expected_scheduled_for,
  -- a caller-supplied parameter -- a bare `<>` evaluates to NULL/unknown
  -- (never TRUE) whenever either operand is NULL, which would make this
  -- entire OR chain's scheduled_for term silently inert instead of forcing
  -- state_changed. IS DISTINCT FROM never has this gap.
  IF v_template.service_type IS DISTINCT FROM p_expected_service_type
     OR v_template.price_cents IS DISTINCT FROM p_expected_price_cents
     OR v_template.duration_minutes IS DISTINCT FROM p_expected_duration_minutes
     OR v_template.notes IS DISTINCT FROM p_expected_notes
     OR v_template.team_color IS DISTINCT FROM p_expected_team_color
     OR v_template.scheduled_for IS DISTINCT FROM p_expected_scheduled_for
  THEN
    RETURN 'state_changed';
  END IF;

  -- 4. appointment_employees -- locked FIRST via a plain, non-aggregating
  -- PERFORM (PostgreSQL's row-locking clause cannot be combined with an
  -- aggregate function in the same SELECT -- a hard, unconditional
  -- restriction, not a style preference -- so the lock and the array_agg()
  -- aggregation below MUST be two separate statements, never one), then
  -- canonically sorted (by the employee_id value itself -- the same
  -- ordering rule TypeScript is required to use, see
  -- lib/recurringSeries.ts's canonicalizeEmployeeIds) in a second,
  -- separate, unlocked SELECT that reads the rows this transaction already
  -- holds locked -- so the comparison below is a plain, deterministic array
  -- equality rather than a set-comparison that would need its own separate
  -- logic.
  PERFORM 1
  FROM appointment_employees
  WHERE appointment_id = p_template_appointment_id
  ORDER BY employee_id
  FOR UPDATE;

  SELECT COALESCE(array_agg(employee_id ORDER BY employee_id), ARRAY[]::UUID[])
  INTO v_actual_employee_ids
  FROM appointment_employees
  WHERE appointment_id = p_template_appointment_id;

  -- Production-review correction: p_expected_employee_ids IS NULL is
  -- rejected OUTRIGHT, distinctly from an explicit empty array
  -- ('{}'::uuid[], which remains valid and means "zero employees
  -- expected"). The prior COALESCE(p_expected_employee_ids,
  -- ARRAY[]::UUID[]) silently normalized a caller-supplied NULL into an
  -- empty array before ever comparing it against anything, making a
  -- genuinely missing/omitted parameter indistinguishable from a caller
  -- that deliberately observed and passed an empty set -- exactly the kind
  -- of silent normalization at the API boundary this function must not do.
  IF p_expected_employee_ids IS NULL THEN
    RETURN 'state_changed';
  END IF;

  -- Reject a malformed expected array outright: a caller that correctly
  -- canonicalized its own signature (dedupe never needed, since a real
  -- assignment set has no duplicates by construction) would never produce
  -- one containing a repeated id -- a duplicate here is itself proof the
  -- expected value can't be trusted, regardless of what it would otherwise
  -- compare equal to. cardinality() (unlike array_length()) returns 0,
  -- never NULL, for a non-NULL empty array, so this comparison is correct
  -- for the empty-array case with no COALESCE needed --
  -- p_expected_employee_ids is guaranteed non-NULL past the guard above. A
  -- NULL element within the array (e.g. ARRAY[NULL]::uuid[]) is also
  -- caught here: COUNT(DISTINCT e) ignores NULL values entirely (standard
  -- SQL COUNT semantics), so a NULL element makes the two sides of this
  -- comparison unequal.
  SELECT COUNT(DISTINCT e) INTO v_expected_distinct_ct
  FROM unnest(p_expected_employee_ids) e;

  IF v_expected_distinct_ct IS DISTINCT FROM cardinality(p_expected_employee_ids) THEN
    RETURN 'state_changed';
  END IF;

  SELECT COALESCE(array_agg(e ORDER BY e), ARRAY[]::UUID[])
  INTO v_expected_canonical
  FROM unnest(p_expected_employee_ids) e;

  IF v_actual_employee_ids IS DISTINCT FROM v_expected_canonical THEN
    RETURN 'state_changed';
  END IF;

  -- 5. the referenced employees rows -- every currently-assigned employee
  -- must exist, belong to this exact workspace, and be active, RE-CHECKED
  -- here rather than trusted from whatever TypeScript observed earlier.
  -- Every matching employees row is locked FIRST (regardless of its current
  -- eligibility), so a concurrent deactivation cannot land in the narrow
  -- window between this check and the write below; a nonexistent id simply
  -- locks nothing (there is nothing to lock) and is correctly caught by the
  -- eligibility count that follows. A valid EMPTY employee set (zero
  -- assignments) skips this block entirely and is not an error.
  IF COALESCE(array_length(v_actual_employee_ids, 1), 0) > 0 THEN
    PERFORM 1 FROM employees WHERE id = ANY(v_actual_employee_ids) FOR UPDATE;

    SELECT COUNT(*) INTO v_ineligible_ct
    FROM unnest(v_actual_employee_ids) AS assigned_id
    WHERE NOT EXISTS (
      SELECT 1 FROM employees
      WHERE id = assigned_id AND workspace_id = p_workspace_id AND active = true
    );

    IF v_ineligible_ct > 0 THEN
      RETURN 'employee_not_eligible';
    END IF;
  END IF;

  -- Every check above passed against rows locked in THIS transaction -- the
  -- write is exactly the state just proven, atomically, in the same
  -- statement that re-asserts the CAS precondition (status = 'review_required')
  -- one final time. status, reviewed_at, template_appointment_id, and every
  -- snapshot_* column move together in this one UPDATE -- there is no
  -- window in which an active row can exist with an incomplete snapshot,
  -- and no window in which a snapshot is written without status actually
  -- becoming active.
  -- Anchor fields (business-local date/time/timezone the recurrence pattern
  -- is now confirmed to originate from) are always (re)derived from the
  -- validated template's own scheduled_for, at the workspace's current
  -- effective timezone -- a no-op overwrite when neither has actually
  -- changed, so no caller ever needs a separate "did the time change"
  -- branch. Uses the identical `AT TIME ZONE ... ::date` / `::time`
  -- conversion migration 026's own legacy backfill already relies on, not a
  -- new technique. p_anchor_timezone is a plain trusted input (TypeScript
  -- always resolves it via effectiveTimezone(), which never returns
  -- anything outside this column's own 7-zone CHECK allowlist) -- it is not
  -- part of the locked-row comparison above because there is no "drift" to
  -- detect against; company_settings.timezone is not one of this
  -- function's locked tables.
  UPDATE recurring_series
  SET status = 'active',
      reviewed_at = now(),
      template_appointment_id = p_template_appointment_id,
      snapshot_service_type = p_expected_service_type,
      snapshot_price_cents = p_expected_price_cents,
      snapshot_duration_minutes = p_expected_duration_minutes,
      snapshot_notes = p_expected_notes,
      snapshot_team_color = p_expected_team_color,
      snapshot_employee_ids = v_expected_canonical,
      snapshot_updated_at = now(),
      review_reason = NULL,
      anchor_local_date = (p_expected_scheduled_for AT TIME ZONE p_anchor_timezone)::date,
      anchor_local_time = (p_expected_scheduled_for AT TIME ZONE p_anchor_timezone)::time,
      anchor_timezone = p_anchor_timezone,
      updated_at = now()
  WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'review_required';

  IF NOT FOUND THEN
    -- Someone else changed this row's status in the narrow window between
    -- the lock above and this UPDATE's own re-check (should be structurally
    -- impossible while this transaction still holds the row's own exclusive
    -- lock from step 1, but the WHERE clause re-asserts it anyway as a
    -- final, explicit belt-and-suspenders guard rather than an assumption).
    RETURN 'conflict';
  END IF;

  RETURN 'activated';
END;
$fn$;

-- Deny-all-except-service-role, applied at the function-grant level rather
-- than a row-level RLS policy since this is the first place real,
-- state-transitioning business logic runs inside the database in this
-- codebase (every other table in this schema stays deny-all RLS with zero
-- policies, enforced entirely by application code) -- a deliberate, minimal,
-- reviewed exception, not a drift from that convention. PostgreSQL grants
-- EXECUTE to PUBLIC by default on every newly created function, which is
-- exactly why each of these three REVOKEs is required, not optional.
-- SECURITY INVOKER (never DEFINER): this function is only ever reachable via
-- the service-role connection, which already has full table access -- there
-- is no privilege to escalate to, so DEFINER would only add an unreviewed
-- privilege-escalation surface for no benefit.
REVOKE ALL ON FUNCTION activate_recurring_series(
  UUID, UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, UUID[], TEXT
) FROM PUBLIC;

REVOKE ALL ON FUNCTION activate_recurring_series(
  UUID, UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, UUID[], TEXT
) FROM anon;

REVOKE ALL ON FUNCTION activate_recurring_series(
  UUID, UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, UUID[], TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION activate_recurring_series(
  UUID, UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, UUID[], TEXT
) TO service_role;

-- ============================================================================
-- Part 3: sync_appointment_assignments -- the atomic, race-safe way to
-- replace an existing appointment's employee assignment set.
-- ============================================================================
--
-- Production-review correction (concurrency audit): activate_recurring_series
-- locks the template appointment row (step 3 of its own fixed lock order)
-- before reading/locking its appointment_employees rows -- but a lock on
-- EXISTING appointment_employees rows cannot prevent a brand-new row being
-- INSERTed for that same appointment_id from a completely different,
-- uncoordinated transaction (a "phantom insert"). Until now, the only
-- application-level path that adds/removes an EXISTING appointment's
-- assignments (lib/appointmentEmployees.ts's applyAssignmentSync, called
-- from app/api/appointments/update/route.ts) issued its INSERT/DELETE as
-- plain, independent Supabase-client calls -- never locking the parent
-- appointments row first, so it shared no lock with
-- activate_recurring_series and could not be serialized against it.
--
-- This function closes that gap NARROWLY: it is not a general assignment
-- API, and it does NOT claim PostgreSQL propagates a lock from a parent row
-- to its child rows automatically (it does not, for any relationship,
-- including a foreign key). The safety property here comes entirely from
-- BOTH this function and activate_recurring_series explicitly, deliberately
-- locking the exact SAME parent appointments row (FOR UPDATE) as literally
-- their own first step, in the same relative position in each function's own
-- lock order -- so two concurrent transactions, one calling each function
-- for the same appointment_id, are forced by Postgres's own row-lock
-- mechanics to serialize against EACH OTHER on that shared lock, regardless
-- of which table each one goes on to touch afterward. Whichever transaction
-- acquires the appointments row lock second necessarily blocks until the
-- first commits or rolls back, and then observes that transaction's fully
-- committed result -- never a half-applied intermediate state. This is a
-- narrow, two-function shared-lock agreement, not a general guarantee that
-- would protect a THIRD, hypothetical future writer unless it also locked
-- this exact same row first.
--
-- Every add/remove of an EXISTING appointment's assignments in this
-- codebase that can plausibly race a concurrent activation now goes through
-- this one function (app/api/appointments/update/route.ts, both mode:
-- "single" and mode:"future", including every affected sibling). Brand-new
-- assignment rows created for a brand-new appointment in the SAME request
-- that just created it (app/api/appointments/create/route.ts,
-- app/api/appointments/manage-recurrence/route.ts, via insertAssignments)
-- are deliberately left unchanged -- no other transaction can reference an
-- appointment_id that doesn't exist yet, so there is no concurrent second
-- writer to race. Job Tracking's own UPDATEs to an already-identified,
-- already-EXISTING appointment_employees row (app/api/appointments/job,
-- app/api/appointments/employee-hours) are also unchanged -- they never
-- insert or delete a row, only update one, and any such row already locked
-- by this function's own step 2 already correctly blocks a concurrent
-- UPDATE to it, with no additional change needed.
CREATE OR REPLACE FUNCTION sync_appointment_assignments(
  p_appointment_id                 UUID,
  p_workspace_id                    UUID,
  p_expected_current_employee_ids   UUID[],
  p_desired_employee_ids            UUID[]
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_appointment                  appointments%ROWTYPE;
  v_actual_current_employee_ids  UUID[];
  v_expected_current_canonical   UUID[];
  v_expected_distinct_ct         INTEGER;
  v_desired_canonical            UUID[];
  v_desired_distinct_ct          INTEGER;
  v_ineligible_ct                INTEGER;
BEGIN
  -- 1. Lock the parent appointments row FIRST -- the shared serialization
  -- boundary with activate_recurring_series's own step 3. Scoped by id AND
  -- workspace_id together, never id alone.
  SELECT * INTO v_appointment
  FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'appointment_not_found';
  END IF;

  -- 2. Lock its current appointment_employees rows FIRST via a plain,
  -- non-aggregating PERFORM (PostgreSQL's row-locking clause cannot be
  -- combined with an aggregate function in the same SELECT, so the lock and
  -- the array_agg() aggregation below MUST be two separate statements --
  -- identical split activate_recurring_series's own step 4 uses), then
  -- canonicalize (sort by employee_id) in a second, separate, unlocked
  -- SELECT that reads the
  -- rows this transaction already holds locked -- identical technique and
  -- ordering rule, so the two functions' comparisons are always directly
  -- compatible.
  PERFORM 1
  FROM appointment_employees
  WHERE appointment_id = p_appointment_id
  ORDER BY employee_id
  FOR UPDATE;

  SELECT COALESCE(array_agg(employee_id ORDER BY employee_id), ARRAY[]::UUID[])
  INTO v_actual_current_employee_ids
  FROM appointment_employees
  WHERE appointment_id = p_appointment_id;

  -- Production-review correction: both p_expected_current_employee_ids and
  -- p_desired_employee_ids are rejected OUTRIGHT when NULL, distinctly
  -- from an explicit empty array ('{}'::uuid[], which remains valid --
  -- "zero employees currently assigned" / "unassign everyone"). The prior
  -- COALESCE(..., ARRAY[]::UUID[]) silently normalized a caller-supplied
  -- NULL into an empty array before ever comparing it against anything --
  -- exactly the kind of silent normalization at the API boundary this
  -- function must not do.
  IF p_expected_current_employee_ids IS NULL THEN
    RETURN 'state_changed';
  END IF;

  IF p_desired_employee_ids IS NULL THEN
    RETURN 'state_changed';
  END IF;

  -- 3/4. Canonicalize the caller-supplied expected-current and desired
  -- arrays, rejecting either one outright if it contains a duplicate --
  -- TypeScript's own dedupeEmployeeIds() already guarantees neither array
  -- ever legitimately contains one; a duplicate reaching here is itself
  -- proof the value can't be trusted, mirroring
  -- activate_recurring_series's own identical precedent for a duplicate
  -- expected employee id. cardinality() (unlike array_length()) returns 0,
  -- never NULL, for a non-NULL empty array, so this is correct for the
  -- empty-array case with no COALESCE needed -- both parameters are
  -- guaranteed non-NULL past the guards above. A NULL element within
  -- either array is also caught here: COUNT(DISTINCT e) ignores NULL
  -- values entirely, so a NULL element makes the two sides unequal.
  SELECT COUNT(DISTINCT e) INTO v_expected_distinct_ct
  FROM unnest(p_expected_current_employee_ids) e;

  IF v_expected_distinct_ct IS DISTINCT FROM cardinality(p_expected_current_employee_ids) THEN
    RETURN 'state_changed';
  END IF;

  SELECT COUNT(DISTINCT e) INTO v_desired_distinct_ct
  FROM unnest(p_desired_employee_ids) e;

  IF v_desired_distinct_ct IS DISTINCT FROM cardinality(p_desired_employee_ids) THEN
    RETURN 'state_changed';
  END IF;

  SELECT COALESCE(array_agg(e ORDER BY e), ARRAY[]::UUID[])
  INTO v_expected_current_canonical
  FROM unnest(p_expected_current_employee_ids) e;

  -- 5. Compare the locked, actual current set against what the caller
  -- observed and validated (e.g. via lib/appointmentEmployees.ts's
  -- planAssignmentSync, including its own blocked-removal safety check)
  -- BEFORE this call -- a mismatch means the assignment set genuinely
  -- changed in the window between that observation and this call, and the
  -- caller's already-computed add/remove decision can no longer be trusted.
  IF v_actual_current_employee_ids IS DISTINCT FROM v_expected_current_canonical THEN
    RETURN 'state_changed';
  END IF;

  SELECT COALESCE(array_agg(e ORDER BY e), ARRAY[]::UUID[])
  INTO v_desired_canonical
  FROM unnest(p_desired_employee_ids) e;

  -- 6/7. Lock every DESIRED employee row, in deterministic UUID order
  -- (ORDER BY id) -- required so that two concurrent calls to this same
  -- function, for two different appointments that happen to share some of
  -- the same desired employees, always acquire those employees' row locks
  -- in the same relative order, preventing a lock-order deadlock between
  -- them. Every desired employee must exist, belong to this exact
  -- workspace, and be active -- re-checked fresh here, never trusted from
  -- whatever the caller observed earlier. A valid EMPTY desired set (every
  -- employee being unassigned) skips this block entirely and is not an
  -- error.
  IF COALESCE(array_length(v_desired_canonical, 1), 0) > 0 THEN
    PERFORM 1 FROM employees WHERE id = ANY(v_desired_canonical) ORDER BY id FOR UPDATE;

    SELECT COUNT(*) INTO v_ineligible_ct
    FROM unnest(v_desired_canonical) AS desired_id
    WHERE NOT EXISTS (
      SELECT 1 FROM employees
      WHERE id = desired_id AND workspace_id = p_workspace_id AND active = true
    );

    IF v_ineligible_ct > 0 THEN
      RETURN 'employee_not_eligible';
    END IF;
  END IF;

  -- 8. Replace the assignment set inside this same transaction -- every
  -- check above passed against rows locked in THIS transaction, so this is
  -- exactly the state just proven, atomically. A full replace (delete
  -- everything, then insert the desired set) rather than a computed
  -- add/remove diff -- simpler, and equally safe, since the entire
  -- operation is already atomic; there is no window in which a reader could
  -- observe an empty or partial assignment set.
  DELETE FROM appointment_employees WHERE appointment_id = p_appointment_id;

  IF COALESCE(array_length(v_desired_canonical, 1), 0) > 0 THEN
    INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id)
    SELECT p_appointment_id, e, p_workspace_id
    FROM unnest(v_desired_canonical) e;
  END IF;

  RETURN 'synced';
END;
$fn$;

REVOKE ALL ON FUNCTION sync_appointment_assignments(
  UUID, UUID, UUID[], UUID[]
) FROM PUBLIC;

REVOKE ALL ON FUNCTION sync_appointment_assignments(
  UUID, UUID, UUID[], UUID[]
) FROM anon;

REVOKE ALL ON FUNCTION sync_appointment_assignments(
  UUID, UUID, UUID[], UUID[]
) FROM authenticated;

GRANT EXECUTE ON FUNCTION sync_appointment_assignments(
  UUID, UUID, UUID[], UUID[]
) TO service_role;

COMMIT;
