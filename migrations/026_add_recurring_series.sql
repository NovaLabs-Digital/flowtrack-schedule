-- 026: Automatic Recurring-Series Replenishment, Block 2B -- adds one new,
-- additive table (recurring_series) and one new unique index on the
-- existing appointments table. No existing column is added, dropped, or
-- altered. No existing appointment row is deleted, cancelled, or rewritten
-- -- this migration only creates registry/metadata rows describing existing
-- series; it never touches appointments.scheduled_for or any other
-- appointment field. Safely re-runnable (CREATE TABLE/INDEX use IF NOT
-- EXISTS; the backfill INSERT is idempotent, guarded by a NOT EXISTS check
-- against recurring_series.id). Wrapped in an explicit transaction so the
-- all-or-nothing behavior is guaranteed rather than relying on the SQL
-- client's own implicit multi-statement transaction handling.
--
-- Production preflight correction (post-review): PostgreSQL has no built-in
-- MIN(uuid) aggregate -- workspace_id/client_id are aggregated via
-- MIN(...::text)::uuid instead. The legacy appointments table also defaults
-- BOTH repeat_weeks and repeat_months to 1 regardless of frequency_type (a
-- historical artifact confirmed symmetrically in both directions by
-- production preflight evidence), so the backfill normalizes each column's
-- irrelevant-to-its-own-frequency value of exactly 1 to NULL before
-- shape/validity checks: repeat_weeks when frequency_type <> 'weekly',
-- repeat_months when frequency_type <> 'monthly'. The interval column that
-- actually belongs to a series' own frequency_type is never normalized --
-- it is read and validated literally, including a genuine value of 1. Any
-- other non-null value on the irrelevant column, or any value other than
-- exactly 1, is left untouched and still correctly excluded as a genuine
-- anomaly. The recurring_series table's own CHECK constraints remain
-- unchanged and strict; only the legacy backfill's read of the old table is
-- normalized.
BEGIN;

-- ============================================================================
-- Part 1: the recurring_series table.
-- ============================================================================
--
-- recurring_series.id deliberately reuses the SAME uuid value space as the
-- existing appointments.series_id column -- a legacy row is backfilled with
-- id = that series' existing series_id value; a series created going
-- forward has its recurring_series.id generated first and that same value
-- used as the new appointments.series_id. This is why NO column is added to
-- appointments by this migration: the join is always
-- `appointments.series_id = recurring_series.id`. No FOREIGN KEY is added
-- from appointments.series_id to recurring_series.id in this migration --
-- that would require a guarantee that every historical series_id has a
-- matching row, which the "structurally valid only" backfill below does not
-- promise (a series failing its structural-validity check is intentionally
-- left with NO registry row rather than a guessed one). Adding that FK is a
-- deliberate, separate, later decision once full backfill coverage (or an
-- accepted exception list) is confirmed.
CREATE TABLE IF NOT EXISTS recurring_series (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,

  -- Lifecycle status. Defaults to the safest value -- 'review_required' --
  -- so a bare INSERT can never accidentally create a row eligible for
  -- future automatic replenishment (not implemented by this migration or
  -- this phase at all; only the registry and manual owner review/activation
  -- exist so far).
  status                   TEXT NOT NULL DEFAULT 'review_required'
                             CHECK (status IN ('active', 'stopped', 'review_required')),

  -- A series is definitionally tied to one client (confirmed as a real
  -- invariant by Block 2A's production audit: zero series currently mix
  -- client_id). RESTRICT matches this repo's established FK convention for
  -- a row that must never be silently orphaned by a hard delete elsewhere
  -- (see appointment_employees.employee_id, migration 021).
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

  -- No DEFAULT -- every insert (backfill or route) must state this
  -- explicitly from its source appointment, so a demo series can never be
  -- silently misclassified as real by omission.
  is_demo                  BOOLEAN NOT NULL,

  -- The CONFIRMED, currently-trusted source of field values for eventual
  -- replenishment -- distinct from a purely historical "first appointment"
  -- pointer (which this table deliberately does not keep; it's one cheap
  -- MIN(scheduled_for) query away if ever wanted for display). NULL for
  -- every legacy series until an owner explicitly reviews and activates it
  -- (see the CHECK constraint below, which makes this pairing a database-
  -- enforced invariant, not just an application convention). Set
  -- immediately for a series created going forward, to the appointment that
  -- was just explicitly created/edited.
  template_appointment_id  UUID REFERENCES appointments(id) ON DELETE SET NULL,

  -- The recurrence rule. 'one_time' is excluded -- a recurring_series row
  -- only ever represents an actual recurrence.
  frequency_type           TEXT NOT NULL
                             CHECK (frequency_type IN ('daily', 'weekdays', 'weekly', 'monthly')),
  repeat_weeks             INTEGER,
  repeat_months            INTEGER,
  CHECK (
    (frequency_type = 'weekly'  AND repeat_weeks  BETWEEN 1 AND 8  AND repeat_months IS NULL)
    OR (frequency_type = 'monthly' AND repeat_months BETWEEN 1 AND 12 AND repeat_weeks IS NULL)
    OR (frequency_type IN ('daily', 'weekdays') AND repeat_weeks IS NULL AND repeat_months IS NULL)
  ),

  -- The original/confirmed business-local wall-clock date, time, and
  -- resolved timezone this recurrence pattern is anchored to -- stored
  -- explicitly rather than re-derived from template_appointment_id each
  -- time, so the pattern survives independently of which specific
  -- appointment row still exists. anchor_timezone is used only for drift
  -- detection (has the workspace's saved timezone changed since this
  -- series was last confirmed) -- it is never used to compute new
  -- occurrences; that always re-resolves the workspace's CURRENT effective
  -- timezone, exactly like every other Phase 5 consumer.
  anchor_local_date        DATE NOT NULL,
  anchor_local_time        TIME NOT NULL,
  anchor_timezone          TEXT NOT NULL
                             CHECK (anchor_timezone IN (
                               'America/New_York', 'America/Chicago', 'America/Denver',
                               'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
                               'Pacific/Honolulu'
                             )),

  -- Distinguishes rows created by this migration's one-time backfill from
  -- rows created going forward by real owner actions (create, Manage
  -- Recurrence) -- legacy series must never be guessed active; new series
  -- created after this feature ships may be, because creation is explicit
  -- owner intent.
  source                   TEXT NOT NULL CHECK (source IN ('legacy_backfill', 'owner_created')),

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Not auto-bumped by a trigger -- matches this repo's own documented
  -- convention on appointment_employees.updated_at (migration 021): no
  -- trigger, no code path refreshes it automatically. Any future route that
  -- mutates a row sets it explicitly.
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at               TIMESTAMPTZ,
  reviewed_at              TIMESTAMPTZ,
  last_replenished_at      TIMESTAMPTZ,

  -- Makes "owner activation must set template_appointment_id, reviewed_at,
  -- and status active together" a database-enforced invariant, not just an
  -- application convention.
  CHECK (status <> 'active' OR (template_appointment_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'stopped' OR stopped_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_recurring_series_workspace_id ON recurring_series (workspace_id);
-- The eventual replenishment cron's hot-path query (not implemented by this
-- migration or this phase).
CREATE INDEX IF NOT EXISTS idx_recurring_series_active ON recurring_series (workspace_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recurring_series_client_id ON recurring_series (client_id);

-- Deny-all-except-service-role, matching this repo's established pattern
-- (migration 014's original ten tables; migration 021's appointment_employees
-- following it verbatim for a newer table). No policy, no GRANT/REVOKE.
ALTER TABLE recurring_series ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Part 2: occurrence-identity uniqueness on the EXISTING appointments table.
-- ============================================================================
--
-- Unconditional across every status -- a cancelled occurrence continues to
-- occupy its (series_id, scheduled_for) identity, which is exactly what
-- prevents both a concurrent-duplicate insert AND the resurrection of a
-- deliberately cancelled occurrence by a retry or later replenishment
-- attempt. Block 2A's read-only audit confirmed zero existing violations
-- (all_status_duplicate_group_count = 0) immediately before this migration
-- was written -- this statement will fail loudly (not silently corrupt
-- anything) if that has changed by the time this migration actually runs,
-- which is the correct, safe failure mode.
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_series_occurrence
  ON appointments (series_id, scheduled_for)
  WHERE series_id IS NOT NULL;

-- ============================================================================
-- Part 3: one-time legacy backfill.
-- ============================================================================
--
-- One recurring_series row per distinct EXISTING appointments.series_id --
-- structurally valid series only (single workspace, single client, single
-- is_demo, single frequency_type, single repeat_weeks/repeat_months, and
-- that interval within the bounds the CHECK constraint above requires). A
-- series failing this shape gets NO row here at all -- never a guessed
-- classification -- and is left for manual reconciliation.
--
-- normalized_appts: the legacy appointments table historically stored a
-- default value of 1 in BOTH repeat_weeks and repeat_months even when the
-- column was meaningless for a given row's frequency_type (e.g. a weekly
-- series with a leftover repeat_months = 1, or a daily/weekdays/monthly
-- series with a leftover repeat_weeks = 1) -- confirmed in production by a
-- real weekly/repeat_weeks=4/repeat_months=1 series that would otherwise
-- have been wrongly excluded. Each column's irrelevant-to-its-own-frequency
-- value of exactly 1 is normalized to NULL here, before any shape/validity
-- check: repeat_weeks when frequency_type <> 'weekly', repeat_months when
-- frequency_type <> 'monthly'. Any other non-null value on the irrelevant
-- column, or any value other than exactly 1, is left untouched -- still
-- correctly treated as a genuine anomaly and excluded below. The interval
-- column that actually belongs to a series' own frequency_type is NEVER
-- normalized -- it is read and validated literally, including a genuine
-- value of 1 (e.g. weekly's own repeat_weeks, monthly's own repeat_months).
--
-- Every backfilled row: status = 'review_required' (never guessed active or
-- stopped -- including the 2 demo series: automatic replenishment discovery
-- will always exclude is_demo = true regardless of status, so guessing a
-- classification for them would have no operational benefit and is not
-- attempted), template_appointment_id = NULL (an owner must explicitly
-- choose/confirm one during review -- see lib/recurringSeries.ts), source =
-- 'legacy_backfill'. No appointments row is read for anything other than
-- SELECT here; none is inserted, updated, or deleted.
--
-- The anchor (anchor_local_date/anchor_local_time/anchor_timezone) is
-- derived once from each series' single EARLIEST appointment across its
-- entire history (any status, any date -- not just currently-live rows),
-- converted through the workspace's current effective timezone at backfill
-- time -- a one-time, defensible derivation from what the data already
-- shows, not a guess about business intent. This anchor is purely
-- descriptive metadata until an owner explicitly reviews and activates the
-- series (see Part 1's CHECK constraint) -- it has no effect on any
-- existing appointment and drives no automatic write.
WITH tz_allowlist(tz) AS (
  VALUES ('America/New_York'), ('America/Chicago'), ('America/Denver'),
         ('America/Phoenix'), ('America/Los_Angeles'), ('America/Anchorage'),
         ('Pacific/Honolulu')
),
workspace_tz AS (
  SELECT w.id AS workspace_id,
         COALESCE(
           (SELECT cs.timezone FROM company_settings cs
            WHERE cs.workspace_id = w.id AND cs.timezone IN (SELECT tz FROM tz_allowlist)),
           'America/New_York'
         ) AS effective_timezone
  FROM workspaces w
),
normalized_appts AS (
  SELECT
    series_id, workspace_id, client_id, is_demo, frequency_type,
    CASE WHEN frequency_type <> 'weekly' AND repeat_weeks = 1 THEN NULL ELSE repeat_weeks END AS repeat_weeks,
    CASE WHEN frequency_type <> 'monthly' AND repeat_months = 1 THEN NULL ELSE repeat_months END AS repeat_months
  FROM appointments
  WHERE series_id IS NOT NULL
),
series_shape AS (
  SELECT series_id,
         MIN(workspace_id::text)::uuid AS workspace_id,
         MIN(client_id::text)::uuid AS client_id,
         BOOL_OR(is_demo) AS is_demo,
         MIN(frequency_type) AS frequency_type,
         MIN(repeat_weeks) AS repeat_weeks,
         MIN(repeat_months) AS repeat_months
  FROM normalized_appts
  GROUP BY series_id
  HAVING COUNT(DISTINCT workspace_id) = 1
     AND COUNT(DISTINCT client_id) = 1
     AND COUNT(DISTINCT is_demo) = 1
     AND COUNT(DISTINCT frequency_type) = 1
     AND COUNT(DISTINCT COALESCE(repeat_weeks, -1)) = 1
     AND COUNT(DISTINCT COALESCE(repeat_months, -1)) = 1
),
valid_series AS (
  SELECT ss.* FROM series_shape ss
  WHERE (ss.frequency_type = 'weekly'  AND ss.repeat_weeks  BETWEEN 1 AND 8  AND ss.repeat_months IS NULL)
     OR (ss.frequency_type = 'monthly' AND ss.repeat_months BETWEEN 1 AND 12 AND ss.repeat_weeks IS NULL)
     OR (ss.frequency_type IN ('daily', 'weekdays') AND ss.repeat_weeks IS NULL AND ss.repeat_months IS NULL)
),
earliest_appt AS (
  SELECT DISTINCT ON (a.series_id) a.series_id, a.workspace_id, a.scheduled_for
  FROM appointments a
  JOIN valid_series vs ON vs.series_id = a.series_id
  ORDER BY a.series_id, a.scheduled_for ASC
)
INSERT INTO recurring_series (
  id, workspace_id, status, client_id, is_demo, template_appointment_id,
  frequency_type, repeat_weeks, repeat_months,
  anchor_local_date, anchor_local_time, anchor_timezone, source
)
SELECT
  vs.series_id,
  vs.workspace_id,
  'review_required',
  vs.client_id,
  vs.is_demo,
  NULL,
  vs.frequency_type,
  vs.repeat_weeks,
  vs.repeat_months,
  (ea.scheduled_for AT TIME ZONE wt.effective_timezone)::date,
  (ea.scheduled_for AT TIME ZONE wt.effective_timezone)::time,
  wt.effective_timezone,
  'legacy_backfill'
FROM valid_series vs
JOIN earliest_appt ea ON ea.series_id = vs.series_id
JOIN workspace_tz wt ON wt.workspace_id = vs.workspace_id
WHERE NOT EXISTS (SELECT 1 FROM recurring_series rs WHERE rs.id = vs.series_id);

COMMIT;
