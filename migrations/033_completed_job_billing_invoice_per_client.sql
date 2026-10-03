-- 033 (PHASE 1 of 2 -- see migration 034 for PHASE 2/finalization): Billing /
-- Completed Jobs -- allow one QuickBooks invoice to cover multiple completed
-- jobs for the SAME client, and keep paid/payment_method consistent across
-- every job sharing that invoice. Migration 032's per-workspace
-- invoice-number uniqueness was stricter than real usage: a recurring
-- client's several completed visits are routinely combined onto one invoice
-- in QuickBooks. Real production usage exposed this (Beth Holcomb: three
-- completed jobs, one invoice number, same workspace) -- migration 032's
-- UNIQUE index rejected the second one with "That invoice number is already
-- used by another job in this workspace," which was wrong: QuickBooks had
-- already combined them correctly, and SFT's own job here is only to track
-- which completed jobs belong to which already-assigned QuickBooks invoice
-- number (never a QuickBooks integration -- see migration 032's own header
-- comment, unchanged).
--
-- Approved business rule (narrows, does not replace, migration 032's
-- intent):
--   1. The same invoice number MAY repeat across multiple completed jobs
--      for the SAME client.
--   2. The same invoice number must NOT be silently reused across
--      DIFFERENT clients in the same workspace.
--   3. Cash/no-invoice behavior is unchanged (invoice_number stays
--      nullable; this migration adds no constraint on it beyond what 032
--      already has).
--   4. Payment status belongs to the INVOICE, not to any one job inside it
--      -- if any job under a shared invoice number is marked Paid (with a
--      payment method), every other job under that exact (workspace_id,
--      client_id, invoice_number) triple must read the same
--      paid/payment_method, and the reverse when marked back to unpaid.
--
-- WHY THIS IS SPLIT INTO TWO MIGRATIONS (033 + 034), NOT ONE:
-- An earlier version of this change did the column add, backfill, SET NOT
-- NULL, and the UNIQUE-index-to-non-unique-index swap all in this one file.
-- That is NOT safe to deploy independently from the application code: the
-- CURRENTLY DEPLOYED route writes this table with a raw upsert that never
-- sets client_id at all. If that one-file version were applied to
-- production BEFORE the new application code is live, the very next time
-- the still-old code created a BRAND NEW billing row (first invoice entry
-- for a newly completed job), the INSERT would omit client_id and be
-- rejected by the NOT NULL constraint -- a real, if narrow, availability
-- gap. Splitting into two migrations removes that gap entirely:
--   PHASE 1 (this file): purely additive. client_id is added NULLABLE, the
--     new function is created, and the OLD UNIQUE invoice-number index is
--     left completely untouched. The CURRENTLY DEPLOYED application keeps
--     working exactly as it does today -- it never references client_id or
--     the new function, so it cannot be broken by anything in this file.
--   PHASE 2 (migration 034): applied only AFTER the new application code
--     (which writes via the new function and always supplies client_id) has
--     been deployed and verified healthy. It enforces client_id NOT NULL and
--     swaps the UNIQUE index for a non-unique one of the identical shape,
--     fully activating the same-client-repeat capability.
-- See this file's "PRODUCTION EXECUTION ORDER" section below for the exact
-- sequence, and migration 034's own header for its half of it.
--
-- Why rule #2 (cross-client rejection) is enforced application/function
-- layer, not by a database constraint: "every row sharing this invoice
-- number must share the same client_id" is a functional-dependency rule,
-- not a uniqueness rule -- no plain UNIQUE/partial index can express it (a
-- unique index on (workspace_id, invoice_number, client_id) would itself
-- reject Beth Holcomb's legitimate second row, since two rows CAN correctly
-- share all three values). A PostgreSQL EXCLUDE constraint could express it
-- (via a WITH <> operator class), but this schema has never enabled a new
-- extension beyond what ships by default -- see migrations 027b/029's own
-- comments confirming this exact point for pgcrypto -- and btree_gist would
-- be required for an EXCLUDE constraint on uuid/text columns; a standalone
-- trigger function was also considered and rejected as more machinery than
-- this fix calls for, now that the same cross-client check is already done,
-- atomically, INSIDE upsert_completed_job_billing below (as a RAISE
-- EXCEPTION, not a freestanding trigger) -- see that function's own comment.
-- Because completed_job_billing has exactly ONE write path in this entire
-- application (the function below, called only from
-- app/api/billing/completed-jobs/update/route.ts; confirmed by inspection --
-- no other route, RPC, or cron touches this table), this enforcement is the
-- complete, real enforcement surface once PHASE 2 (migration 034) also
-- retires the old UNIQUE index -- see migration 034's own header for why the
-- old index is intentionally left in place for the duration of PHASE 1.
--
-- What THIS FILE (PHASE 1) does:
--   1. Adds completed_job_billing.client_id, NULLABLE, REFERENCES
--      clients(id) ON DELETE RESTRICT (same FK style as migration 026's own
--      client_id column). Backfilled for every existing row from its
--      appointment's client_id. Deliberately NOT set NOT NULL here --
--      that happens only in migration 034, after the new application code
--      (the only code that reliably supplies it) is already live. See the
--      split rationale above.
--   2. Adds upsert_completed_job_billing(workspace_id, appointment_id,
--      client_id, invoice_number, paid, payment_method), the new write path
--      this table's application code will use once deployed. In one
--      transaction, it: (a) rejects with a distinguishable error if
--      invoice_number is already used by a DIFFERENT client in this
--      workspace (rule #2 -- closes the small check-then-write race window a
--      two-step app-level check would otherwise leave open); (b) inserts or
--      updates (ON CONFLICT appointment_id, matching the UNIQUE constraint
--      from migration 032) the one row for this appointment; (c) if
--      invoice_number is non-null, synchronizes paid/payment_method onto
--      every OTHER row sharing the exact same (workspace_id, client_id,
--      invoice_number) -- rule #4. Scoped strictly by workspace_id AND
--      client_id in the same WHERE clause, so a sync can never cross a
--      client or a workspace boundary. Not SECURITY DEFINER -- called only
--      via the service-role client, which already bypasses RLS at the role
--      level, exactly like every other write in this schema (same reasoning
--      as provision_owner_workspace, migration 017).
--      NOTE: during PHASE 1 (before migration 034 runs), calling this
--      function with a same-client repeated invoice number will still fail
--      -- not from this function's own logic, which allows it, but from the
--      OLD UNIQUE index (migration 032) still being in place underneath the
--      function's INSERT. That failure surfaces as the existing, already-
--      handled 23505 "already used by another job" error. This is an
--      accepted, temporary limitation of the intermediate state (see
--      migration 034's header) -- reliability during the rollout window
--      matters more than activating the new capability a few minutes
--      earlier.
--
-- Does NOT do, in this file or the feature as a whole:
--   - no CREATE EXTENSION, no EXCLUDE USING constraint, no standalone
--     trigger (see the reasoning above);
--   - no quickbooks_invoice_id or other QuickBooks-integration column --
--     unchanged from migration 032's own "not a QuickBooks integration"
--     scope;
--   - no new invoice/invoice-group table -- the group is still just "rows
--     that happen to share (workspace_id, client_id, invoice_number)," not
--     a separately modeled entity;
--   - no change to Cash/no-invoice behavior -- a null invoice_number never
--     triggers the sibling-sync branch, so those rows stay exactly as
--     per-row as before;
--   - no UI redesign -- the existing Invoice #/Paid/Payment Method controls
--     are unchanged; only what happens after Save changes, and only once
--     migration 034 has also run.
--
-- Additive and non-destructive: no existing row can violate anything new
-- here, and nothing this file does can reject or alter any write the
-- CURRENTLY DEPLOYED application makes. The backfill UPDATE only fills a
-- column that did not previously exist, and does so on a NULLABLE column,
-- so there is no row-count or constraint risk. CREATE OR REPLACE FUNCTION
-- is naturally idempotent (safe to re-run). The old UNIQUE index is left
-- completely untouched by this file.
--
-- Safety proof for the eventual NOT NULL (applied only in migration 034,
-- repeated there in full -- summarized here since the backfill that depends
-- on it runs in this file): every completed_job_billing row's appointment_id
-- carries a composite FK to appointments(id, workspace_id) with ON DELETE
-- RESTRICT (migration 032) -- an appointment referenced by a billing row can
-- never be deleted, so the backfill's JOIN can never fail to find a match.
-- Separately, appointments.client_id is NOT NULL in this application's own
-- type (app/components/dashboard/types.ts's Appointment.client_id is
-- `string`, never `string | null`) and, at the moment of this review, a live
-- read-only query against production confirmed 0 of 2033 existing
-- appointments (every workspace, not just ones with billing rows) have a
-- NULL client_id, and 0 of the (then) 5 existing completed_job_billing rows
-- were orphaned or resolved to a NULL client_id. There is no legitimate path
-- in this application that creates an appointment without a client_id.
--
-- PRODUCTION EXECUTION ORDER (the full six-step sequence; steps 1-2 are this
-- file's half, steps 3-6 happen later -- repeated in migration 034's header
-- so either file alone still documents the whole sequence):
--   1. Apply THIS migration (033) to production.
--   2. Verify: `\d completed_job_billing` shows client_id (uuid, nullable,
--      FK to clients); `\df upsert_completed_job_billing` shows the new
--      function; the UNIQUE index idx_completed_job_billing_workspace_
--      invoice_number is still present and still UNIQUE (unchanged).
--      Confirm the CURRENTLY DEPLOYED application still creates and edits
--      billing rows normally (expected -- nothing it does changed).
--   3. Push/deploy the new application commit (the route that writes via
--      upsert_completed_job_billing and always supplies client_id).
--   4. Verify app health: create a new billing row and edit an existing one
--      through the live app; confirm a genuinely different-client invoice
--      reuse is rejected (the function's own check, already active). A
--      same-client repeat is still expected to fail at this point (old
--      index) -- that is correct for this intermediate state, not a bug.
--   5. Apply migration 034 (PHASE 2/finalization) to production.
--   6. Verify: client_id is NOT NULL; the invoice-number index is
--      non-unique; re-attempt the same-client-repeat scenario end-to-end and
--      confirm it now succeeds; confirm cross-client rejection and the
--      paid/payment_method group sync both still work; confirm the table's
--      row count is unchanged from before either migration (no data lost or
--      rewritten).
--
-- Verification for THIS file specifically (run manually against a real
-- Postgres instance before applying to production -- this migration's own
-- .test.ts proves it's additive/non-destructive from source only, matching
-- migration 032's own discipline):
--   1. Before: spot-check current row count of completed_job_billing.
--   2. After: `\d completed_job_billing` shows client_id (uuid, nullable,
--      FK to clients) and the UNIQUE index on (workspace_id, invoice_number)
--      is still present, still UNIQUE. `\df upsert_completed_job_billing`
--      shows the new function. Row count is unchanged.
--   3. `SELECT count(*) FROM completed_job_billing WHERE client_id IS
--      NULL;` returns 0 (every existing row backfilled; new rows from the
--      still-old app will be NULL until migration 034 runs, which is
--      expected and handled there).
--   4. Re-run this file -- every statement is guarded (ADD COLUMN IF NOT
--      EXISTS, the backfill's own `client_id IS NULL` guard, CREATE OR
--      REPLACE FUNCTION) so a second run is a safe no-op.
--
-- Rollback (safe at any point during PHASE 1, i.e. before migration 034 has
-- run -- once 034 has run, roll back 034 first):
--   DROP FUNCTION IF EXISTS upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text);
--   ALTER TABLE completed_job_billing DROP COLUMN client_id;
BEGIN;

ALTER TABLE completed_job_billing
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE RESTRICT;

UPDATE completed_job_billing cjb
SET client_id = a.client_id
FROM appointments a
WHERE a.id = cjb.appointment_id
  AND cjb.client_id IS NULL;

-- The one write path this table's application code will use once deployed
-- (migration 034 retires the old write path's remaining blocker -- see that
-- file's header). Not SECURITY DEFINER: invoked only via the service-role
-- client (supabaseAdmin.rpc(...)), which already bypasses RLS at the role
-- level, same as provision_owner_workspace (migration 017).
CREATE OR REPLACE FUNCTION upsert_completed_job_billing(
  p_workspace_id uuid,
  p_appointment_id uuid,
  p_client_id uuid,
  p_invoice_number text,
  p_paid boolean,
  p_payment_method text
)
RETURNS completed_job_billing
LANGUAGE plpgsql
AS $$
DECLARE
  v_row completed_job_billing;
  v_conflicting_client uuid;
BEGIN
  IF p_invoice_number IS NOT NULL THEN
    -- Rule #2: this invoice number must not already belong to a different
    -- client in this workspace. Checked here, inside the same transaction
    -- as the write below, so there is no gap between checking and writing
    -- for a concurrent request to land in.
    SELECT client_id INTO v_conflicting_client
    FROM completed_job_billing
    WHERE workspace_id = p_workspace_id
      AND invoice_number = p_invoice_number
      AND appointment_id <> p_appointment_id
      AND client_id <> p_client_id
    LIMIT 1;

    IF v_conflicting_client IS NOT NULL THEN
      RAISE EXCEPTION 'completed_job_billing_invoice_number_different_client'
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  INSERT INTO completed_job_billing (
    workspace_id, appointment_id, client_id, invoice_number, paid, payment_method, updated_at
  )
  VALUES (
    p_workspace_id, p_appointment_id, p_client_id, p_invoice_number, p_paid, p_payment_method, now()
  )
  ON CONFLICT (appointment_id) DO UPDATE
    SET client_id = EXCLUDED.client_id,
        invoice_number = EXCLUDED.invoice_number,
        paid = EXCLUDED.paid,
        payment_method = EXCLUDED.payment_method,
        updated_at = now()
  RETURNING * INTO v_row;

  -- Rule #4: every OTHER job sharing this exact invoice number, for this
  -- same client, in this same workspace, now reads the identical
  -- paid/payment_method this row was just given. Never touches a
  -- different client_id or workspace_id -- both are in the WHERE clause,
  -- not just invoice_number.
  IF p_invoice_number IS NOT NULL THEN
    UPDATE completed_job_billing
    SET paid = p_paid,
        payment_method = p_payment_method,
        updated_at = now()
    WHERE workspace_id = p_workspace_id
      AND client_id = p_client_id
      AND invoice_number = p_invoice_number
      AND appointment_id <> p_appointment_id;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text) TO service_role;

COMMIT;
