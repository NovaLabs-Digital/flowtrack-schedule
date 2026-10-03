-- 033: Billing / Completed Jobs -- allow one QuickBooks invoice to cover
-- multiple completed jobs for the SAME client. Migration 032's per-
-- workspace invoice-number uniqueness was stricter than real usage: a
-- recurring client's several completed visits are routinely combined onto
-- one invoice in QuickBooks. Real production usage exposed this (Beth
-- Holcomb: two completed jobs, one invoice number, same workspace) --
-- migration 032's UNIQUE index rejected the second one with "That invoice
-- number is already used by another job in this workspace," which was
-- wrong: QuickBooks had already combined them correctly, and SFT's own
-- job here is only to track which completed jobs belong to which
-- already-assigned QuickBooks invoice number (never a QuickBooks
-- integration -- see migration 032's own header comment, unchanged).
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
--
-- This migration only relieves #1's over-strict enforcement. #2 is
-- enforced in the APPLICATION layer (the one PATCH route that writes this
-- table -- app/api/billing/completed-jobs/update/route.ts), not at the
-- database layer. Why: "every row sharing this invoice number must share
-- the same client_id" is a functional-dependency rule, not a uniqueness
-- rule -- no plain UNIQUE/partial index can express it (a unique index on
-- (workspace_id, invoice_number, client_id) would itself reject Beth
-- Holcomb's legitimate second row, since two rows CAN correctly share all
-- three values). A PostgreSQL EXCLUDE constraint could express it (via a
-- WITH <> operator class), but this schema has never enabled a new
-- extension beyond what ships by default -- see migrations 027b/029's own
-- comments confirming this exact point for pgcrypto -- and btree_gist
-- would be required for an EXCLUDE constraint on uuid/text columns; a
-- trigger function was also considered and rejected as more machinery
-- than this fix calls for. completed_job_billing has exactly ONE write
-- path in this entire application (the route above; confirmed by
-- inspection -- no other route, RPC, or cron touches this table), so an
-- application-layer check is not a weaker fallback in front of a missing
-- database rule here -- it is the complete, real enforcement surface,
-- exactly as authoritative as a database constraint would be for this
-- specific table's actual threat model.
--
-- What this migration does:
--   1. Adds completed_job_billing.client_id, REFERENCES clients(id) ON
--      DELETE RESTRICT (same FK style as migration 026's own client_id
--      column). Backfilled for every existing row from its appointment's
--      client_id (appointments.client_id is NOT NULL for every row --
--      app/components/dashboard/types.ts's Appointment.client_id type is
--      `string`, never `string | null`), so every row has a real value
--      immediately after this migration runs. The column itself is left
--      nullable at the database layer rather than backfilled-then-SET-NOT-
--      NULL: this schema has no existing precedent anywhere in
--      migrations/ for a backfill-then-SET-NOT-NULL migration, and staying
--      nullable keeps this migration's rollback trivial (see the bottom of
--      this file) with no constraint to un-enforce first. The application
--      layer always populates it on every write (the one PATCH route
--      above derives it from the already workspace-verified appointment
--      row, never from client-supplied input) -- the same "DB stays
--      permissive, the app is the one actual guarantee" shape as several
--      other columns in this schema.
--   2. Drops the old per-workspace UNIQUE partial index on
--      (workspace_id, invoice_number) and replaces it, under the exact
--      same name, with a plain (non-unique) partial index of the identical
--      shape -- same two columns, same `WHERE invoice_number IS NOT NULL`
--      clause -- so the application's own same-invoice/different-client
--      lookup query (added alongside this migration) stays index-backed
--      and cheap, without forbidding the legitimate same-client repeat
--      that uniqueness was blocking.
--
-- What this migration deliberately does NOT do:
--   - no CREATE EXTENSION, no EXCLUDE USING constraint, no trigger
--     function (see the reasoning above);
--   - no quickbooks_invoice_id or other QuickBooks-integration column --
--     unchanged from migration 032's own "not a QuickBooks integration"
--     scope;
--   - no change to Cash/no-invoice behavior;
--   - no change to how paid/payment_method are stored -- they remain
--     PER-ROW, never synchronized across rows sharing an invoice number.
--     QuickBooks remains the authoritative reconciliation record (rule #3
--     above); SFT's own per-row paid tracking is a convenience for the
--     owner's workflow, not a ledger, so synchronizing it automatically
--     across a shared-invoice group would be new cascading-update
--     behavior this fix was not asked to add (see the accompanying report
--     for the full reasoning);
--   - no UI redesign -- the existing Invoice #/Paid/Payment Method
--     controls are unchanged; only the validation outcome changes.
--
-- Additive and non-destructive: no existing row can violate anything new
-- here. The UPDATE below only fills a column that did not previously
-- exist (every existing row's client_id starts NULL immediately after the
-- ADD COLUMN, then is filled from data that already exists and cannot be
-- ambiguous -- one appointment, one client). The dropped index only ever
-- REJECTED inserts; it never allowed a row to exist that this migration
-- now makes invalid, and every (workspace_id, invoice_number) pair already
-- accepted under the OLD stricter rule remains trivially valid under this
-- strictly looser one.
--
-- Verification (run manually against a real Postgres instance before this
-- migration is ever applied to production -- this test suite proves the
-- migration is additive/non-destructive from source only; see this
-- migration's own .test.ts and migration 032's .test.ts for that
-- discipline):
--   1. Before: confirm no row currently violates what's being loosened
--      (moot here -- loosening a rule can never be violated by existing
--      data) and spot-check that completed_job_billing has the same row
--      count before and after.
--   2. After: `\d completed_job_billing` shows client_id (uuid, nullable,
--      FK to clients) and no remaining UNIQUE index on
--      (workspace_id, invoice_number) -- only a plain index with the same
--      name.
--   3. `SELECT count(*) FROM completed_job_billing WHERE client_id IS
--      NULL;` returns 0.
--   4. Re-run this file -- every statement is guarded (ADD COLUMN IF NOT
--      EXISTS, the backfill's own `client_id IS NULL` guard, DROP INDEX IF
--      EXISTS, CREATE INDEX IF NOT EXISTS) so a second run is a safe no-op.
--
-- Rollback (only safe BEFORE any row has actually been written that
-- depends on the new behavior -- i.e., two rows sharing one invoice_number
-- for the same client; recreating the UNIQUE index at that point would
-- fail with the same error this migration was written to relieve):
--   DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number;
--   CREATE UNIQUE INDEX idx_completed_job_billing_workspace_invoice_number
--     ON completed_job_billing(workspace_id, invoice_number)
--     WHERE invoice_number IS NOT NULL;
--   ALTER TABLE completed_job_billing DROP COLUMN client_id;
BEGIN;

ALTER TABLE completed_job_billing
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE RESTRICT;

UPDATE completed_job_billing cjb
SET client_id = a.client_id
FROM appointments a
WHERE a.id = cjb.appointment_id
  AND cjb.client_id IS NULL;

DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number;

-- Same shape as the dropped index (same two columns, same partial WHERE),
-- minus UNIQUE -- see this file's header comment for why a plain index
-- (backing the application's own cross-client check), not a database-level
-- uniqueness/exclusion rule, is the correct replacement.
CREATE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number
  ON completed_job_billing(workspace_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

COMMIT;
