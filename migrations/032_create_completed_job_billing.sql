-- 032: Billing / Completed Jobs (V1) -- an owner-facing report that lists
-- completed cleanings and lets the owner record the QuickBooks invoice
-- number, paid status, and payment method for each one, replacing the
-- manual "review the schedule, write it down, open QuickBooks" workflow.
--
-- This is explicitly NOT a QuickBooks integration. No external API is
-- called by anything in this migration or the application code that reads
-- it. The schema is deliberately minimal -- no speculative
-- quickbooks_invoice_id / external_payment_id / reconciled_at columns are
-- added in V1; a future integration phase will design those against the
-- real QuickBooks/bank APIs once they're actually being built, not guessed
-- at now.
--
-- One new table, zero changes to any existing table, zero backfill. Creates
-- exactly one row per appointment the owner has started billing-tracking
-- for -- created lazily (on the owner's first edit of invoice_number/paid/
-- payment_method for that appointment), never proactively for every
-- historical completed appointment. Deliberately separate from
-- `appointments` (scheduling data), mirroring this schema's existing
-- separation of appointment_employee_hours from appointments for the same
-- reason: a reconciliation/correction concern that applies to a subset of
-- appointments, not a core scheduling field.
--
-- "Completed" itself is NOT redefined or stored here -- it remains
-- whatever lib/payroll.ts's deriveAppointmentTrackingStatus() already
-- computes from appointment_employees (the same definition the Dispatch
-- panel's own "Completed" count already uses). This migration adds no new
-- appointment-status concept.
--
-- appointment_id is UNIQUE: at most one billing row per appointment. ON
-- DELETE RESTRICT (not CASCADE) on both FKs -- an appointment or workspace
-- is never actually hard-deleted by this application (appointments are
-- only ever soft-cancelled, see app/api/appointments/delete/route.ts), so
-- RESTRICT is a safety net that would surface loudly rather than silently
-- discarding a billing/reconciliation record if that ever changed.
--
-- invoice_number: free text (matches whatever QuickBooks assigns). NULL is
-- explicitly allowed -- a completed job can, and routinely will, appear in
-- this report before its QuickBooks invoice has been created. Normalized
-- (trimmed, blank -> NULL) by the application layer (lib/completedJobBilling.ts)
-- before every write; the CHECK below is a defense-in-depth backstop
-- against a non-NULL-but-blank value slipping in some other way, matching
-- this schema's existing "DB constraint as last line of defense, app
-- validation as the primary check" convention (see migration 020's own
-- comment on this same tradeoff for price_cents).
--
-- Supporting uniqueness for the composite FK below. `id` is already globally
-- unique via appointments_pkey, so (id, workspace_id) is trivially satisfied
-- by every existing row -- this can never fail validation against existing
-- data, it only builds one new index. Purely additive: no existing column,
-- row, or constraint on `appointments` is touched or altered. Guarded by an
-- information_schema check (same discipline as migration 017's analogous
-- workspace_memberships uniqueness guard) so this migration stays safely
-- re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'appointments'
      AND constraint_name = 'appointments_id_workspace_id_key'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_id_workspace_id_key UNIQUE (id, workspace_id);
  END IF;
END $$;

-- Unique PER WORKSPACE when set: a partial unique index (NULL excluded) so
-- any number of not-yet-invoiced rows can coexist, and two different
-- workspaces can freely reuse the same invoice number (QuickBooks numbering
-- is workspace/company-specific, not global). A duplicate within the SAME
-- workspace is rejected at the database layer; the API route
-- (app/api/billing/completed-jobs/update/route.ts) catches that specific
-- violation (SQLSTATE 23505) and returns a clear, owner-friendly message
-- rather than a raw database error.
--
-- paid: boolean, default false -- every row starts "not yet paid," matching
-- a freshly-completed job that hasn't been reconciled yet.
--
-- payment_method: one of a fixed small set (Zelle / Check / Cash /
-- QuickBooks-Card / Other). NULL is allowed ONLY while paid = false --
-- enforced here as the authoritative last line of defense; the API route
-- validates this and returns a friendly error before ever reaching this
-- constraint. This is the one business rule in this table enforced at the
-- database layer as well as in application code, because it is a real data-
-- integrity invariant ("never claim a job was paid with no record of how"),
-- not merely a UI nicety.
--
-- invoice_number is required to be STORED already-trimmed (invoice_number =
-- btrim(invoice_number)), not merely non-blank. The application layer
-- (lib/completedJobBilling.ts's normalizeInvoiceNumber) already trims before
-- every write, but the original version of this constraint only rejected
-- fully-blank values, so "13425" and " 13425 " could both pass the CHECK and
-- be stored as two visually-identical but byte-distinct values -- defeating
-- the per-workspace uniqueness index below, which compares raw stored bytes.
-- This CHECK closes that gap at the database layer for any future write path
-- that does not go through the application's own normalization.
--
-- workspace_id / appointment_id integrity: this table is looked up almost
-- exclusively by appointment_id (see app/api/billing/completed-jobs/
-- update/route.ts), with workspace_id carried alongside for RLS-style
-- scoping and the invoice-number-uniqueness index. A single-column FK on
-- appointment_id alone cannot express "this specific appointment belongs to
-- this specific workspace" -- a row could reference a real appointment_id
-- while carrying the WRONG workspace_id, and nothing at the database layer
-- would catch it (the API's own workspace checks are the only guard). To
-- close that gap at the database layer too, appointment_id and workspace_id
-- together are enforced by a COMPOSITE foreign key against
-- appointments(id, workspace_id) below -- which requires a supporting
-- unique constraint on that exact column pair on `appointments` first (see
-- the ALTER TABLE appointments block immediately above the CREATE TABLE).
CREATE TABLE IF NOT EXISTS completed_job_billing (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  appointment_id uuid NOT NULL UNIQUE,
  invoice_number text,
  paid           boolean NOT NULL DEFAULT false,
  payment_method text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT completed_job_billing_invoice_number_trimmed
    CHECK (invoice_number IS NULL OR (invoice_number = btrim(invoice_number) AND length(invoice_number) > 0)),
  CONSTRAINT completed_job_billing_payment_method_valid
    CHECK (payment_method IS NULL OR payment_method IN ('zelle', 'check', 'cash', 'quickbooks_card', 'other')),
  CONSTRAINT completed_job_billing_paid_requires_method
    CHECK (paid = false OR payment_method IS NOT NULL),
  CONSTRAINT completed_job_billing_appointment_workspace_fkey
    FOREIGN KEY (appointment_id, workspace_id) REFERENCES appointments(id, workspace_id) ON DELETE RESTRICT
);

-- Enforces "invoice number unique per workspace" (item 3 of the approved
-- plan) without blocking any number of still-blank (not yet invoiced) rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number
  ON completed_job_billing(workspace_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Speeds the report's own date-range query, which always filters by
-- workspace_id first (via the appointment_id list already resolved from
-- `appointments`).
CREATE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_id
  ON completed_job_billing(workspace_id);

ALTER TABLE completed_job_billing ENABLE ROW LEVEL SECURITY;
-- No policies -- deny-all for anon/authenticated, service-role only.
-- Matches every other business/tenant table in this schema (see migration
-- 014's bulk RLS-enable and migration 015's identical pattern for the
-- subscriptions/stripe_webhook_events/billing_email_log tables). Application
-- code reads/writes this table only through the service-role client
-- (lib/supabaseAdmin.ts), after its own session/workspace/capability checks
-- -- exactly like every other table here.
