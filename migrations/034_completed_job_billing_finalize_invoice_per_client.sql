-- 034 (PHASE 2 of 2 -- finalizes migration 033/PHASE 1): Billing / Completed
-- Jobs -- activates the same-client-repeated-invoice capability by (1)
-- enforcing completed_job_billing.client_id NOT NULL, now that the only code
-- writing this table (the application deployed after migration 033) always
-- supplies it, and (2) replacing the old per-workspace UNIQUE partial index
-- on (workspace_id, invoice_number) with a non-unique index of the identical
-- shape, so the same-client repeat that upsert_completed_job_billing already
-- allows is no longer blocked underneath it by the database.
--
-- DO NOT APPLY THIS MIGRATION UNTIL BOTH OF THE FOLLOWING ARE TRUE:
--   1. Migration 033 has been applied to production and verified (client_id
--      column + upsert_completed_job_billing function both exist).
--   2. The new application code -- the route that writes this table only
--      via upsert_completed_job_billing, always supplying client_id -- has
--      already been deployed to production and verified healthy (can
--      create a new billing row, can edit an existing one, cross-client
--      reuse is rejected).
-- See migration 033's own header for the full six-step PRODUCTION EXECUTION
-- ORDER (steps 1-4 happen before this file; this file is step 5; step 6 is
-- this file's own post-verification, repeated below).
--
-- Why it is unsafe to apply this BEFORE that application code is live:
-- the CURRENTLY DEPLOYED (pre-this-feature) route writes completed_job_
-- billing with a raw upsert that never sets client_id at all. If this
-- file's SET NOT NULL ran while that old code were still the only thing
-- writing this table, the very next time it created a BRAND NEW billing row
-- (first invoice entry for a newly completed job), the INSERT would omit
-- client_id and be rejected outright -- a real availability gap, not a
-- hypothetical one. That is the entire reason this was split into two
-- migrations instead of one (see migration 033's own header for the full
-- rationale) -- this file must only run once that old code is no longer the
-- thing writing this table.
--
-- What this file does:
--   1. Re-runs the client_id backfill (idempotent, harmless if migration
--      033 already filled every row -- guards against the narrow case where
--      OLD code, still live during the gap between migration 033 and the
--      application deploy, created a new row without client_id).
--   2. Explicitly verifies zero remaining NULL client_id rows, raising a
--      clear, named exception if that is ever not true -- a deliberate,
--      named failure here is easier to diagnose during a live migration
--      than a bare "column contains null values" error from the ALTER
--      itself, and guarantees this migration never silently proceeds to
--      SET NOT NULL against unproven data.
--   3. ALTER COLUMN client_id SET NOT NULL.
--   4. Drops the old UNIQUE partial index on (workspace_id, invoice_number)
--      and replaces it, under the exact same name, with a plain
--      (non-unique) partial index of the identical shape -- same two
--      columns, same `WHERE invoice_number IS NOT NULL` clause -- so
--      upsert_completed_job_billing's own same-invoice lookups stay
--      index-backed and cheap, without forbidding the legitimate
--      same-client repeat.
--
-- This file does NOT touch upsert_completed_job_billing itself (unchanged
-- from migration 033) and does NOT re-validate its cross-client/sync logic
-- -- that was already proven, atomically, inside the function in migration
-- 033. This file only removes the one remaining blocker (the old UNIQUE
-- index) that sat underneath it during PHASE 1.
--
-- Additive-in-spirit but NOT reversible-after-the-fact the way migration
-- 033 was: once this file's SET NOT NULL and index swap have run AND at
-- least one same-client-shared-invoice row has actually been written (the
-- entire point of this feature), rolling back is no longer trivial -- see
-- Rollback below.
--
-- Verification (run manually against a real Postgres instance; this
-- migration's own .test.ts proves it's structurally correct from source
-- only, matching migrations 032/033's own discipline):
--   1. Before: `SELECT count(*) FROM completed_job_billing WHERE client_id
--      IS NULL;` returns 0 (expected, given migration 033's backfill and
--      the new app's own writes -- this file re-proves it rather than
--      assuming it).
--   2. Before: spot-check the row count of completed_job_billing equals the
--      count from immediately after migration 033 plus/minus any genuine
--      app activity in between (confirms nothing was silently dropped).
--   3. After: `\d completed_job_billing` shows client_id as NOT NULL, and
--      no remaining UNIQUE index on (workspace_id, invoice_number) -- only a
--      plain index with the same name.
--   4. After: re-attempt the Beth-Holcomb-style same-client-repeat scenario
--      end-to-end through the live app and confirm it now succeeds; confirm
--      a genuinely different-client reuse is still rejected; confirm
--      marking one job in a shared-invoice group Paid still synchronizes
--      the whole group.
--   5. Re-run this file -- the backfill, SET NOT NULL (on an already-NOT-
--      NULL column), DROP INDEX IF EXISTS, and CREATE INDEX IF NOT EXISTS
--      are all safe no-ops on a second run.
--
-- Rollback (only safe BEFORE any row has actually been written that depends
-- on the new behavior -- i.e., two rows sharing one invoice_number for the
-- same client; recreating the UNIQUE index at that point would fail with
-- the same error migration 033/034 together were written to relieve):
--   DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number;
--   CREATE UNIQUE INDEX idx_completed_job_billing_workspace_invoice_number
--     ON completed_job_billing(workspace_id, invoice_number)
--     WHERE invoice_number IS NOT NULL;
--   ALTER TABLE completed_job_billing ALTER COLUMN client_id DROP NOT NULL;
BEGIN;

-- Idempotent re-run of migration 033's own backfill -- see header comment
-- for why this is not merely defensive boilerplate in this file specifically.
UPDATE completed_job_billing cjb
SET client_id = a.client_id
FROM appointments a
WHERE a.id = cjb.appointment_id
  AND cjb.client_id IS NULL;

-- Named, explicit guard before SET NOT NULL -- see header comment.
DO $$
DECLARE
  v_null_count integer;
BEGIN
  SELECT count(*) INTO v_null_count FROM completed_job_billing WHERE client_id IS NULL;
  IF v_null_count > 0 THEN
    RAISE EXCEPTION 'completed_job_billing_finalize_null_client_id: % row(s) still have a NULL client_id after backfill -- investigate before setting NOT NULL', v_null_count;
  END IF;
END;
$$;

ALTER TABLE completed_job_billing
  ALTER COLUMN client_id SET NOT NULL;

DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number;

-- Same shape as the dropped index (same two columns, same partial WHERE),
-- minus UNIQUE -- see migration 033's header comment for why a plain index
-- (backing upsert_completed_job_billing's own lookups), not a
-- database-level uniqueness/exclusion rule, is the correct replacement.
CREATE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number
  ON completed_job_billing(workspace_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

COMMIT;
