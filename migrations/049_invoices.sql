-- 049: SFT invoices (one completed job per invoice) + explicit "Paid
-- directly, no invoice" + Venmo.
--
-- Approved by Alberto 2026-11-12 (revised invoice plan v2 + follow-up):
--
--  * SFT issues its own series, SFT-1001, SFT-1002, ... per workspace. The
--    prefix "SFT" is RESERVED: a number typed in Billing ("Link Existing
--    Invoice") can never start with it, so a linked QuickBooks number can
--    never collide with a number SFT has issued, retired (voided) or will
--    issue later. Existing QuickBooks numbers are untouched.
--  * Invoice lifecycle: draft (editable, no number) -> issued (number
--    assigned, PDF stored, every detail frozen) -> void (kept forever, number
--    retired, never reused). Corrections = void + reissue.
--  * The number, the stored PDF and the Billing update commit in ONE
--    transaction (issue_invoice). The PDF is rendered by the app from
--    invoice_render_input(); issue_invoice only accepts it when the draft
--    revision, the proposed number and the exact render input still match
--    (see "How the PDF gets its number" below).
--  * Billing stays the single place for Paid / Payment Method. For an
--    issued SFT invoice they stay editable; only its number is protected.
--  * "Paid directly, no invoice" is its own per-job decision
--    (completed_job_billing.no_invoice_required), separate from the payment
--    method. Choosing Cash/Venmo/anything alone no longer closes a job.
--  * Venmo is added to the payment methods.
--
-- How the PDF gets its number
--   1. invoice_render_input(workspace, invoice) -- read-only. Returns the
--      draft's revision, the PROPOSED number (the workspace counter's
--      current value) and render_snapshot: the canonical JSON of every value
--      printed on the PDF, including that number and revision.
--   2. The app renders the PDF from that JSON only.
--   3. issue_invoice(workspace, invoice, revision, number, snapshot, pdf,
--      sha256) locks appointment -> invoice -> counter, then refuses unless:
--      the invoice is still a draft at exactly that revision
--      ('stale_revision'), the counter still proposes exactly that number
--      ('number_changed' -- the app re-renders with the new one), the
--      snapshot equals the one rebuilt from the locked row with that number
--      ('snapshot_mismatch'), and the bytes are a PDF whose SHA-256 matches
--      ('pdf_invalid'). Only then does it store number + PDF + snapshot,
--      advance the counter and write Billing. A refusal writes nothing and
--      consumes no number, so numbers have no gaps and nothing is "reserved".
--   A trigger bumps the revision on every content change of a draft and
--   freezes issued/void invoices, so an edit made while the PDF was being
--   rendered is always detected.
--
-- Rollout (first apply only, like 048's grandfathering): rows that are
-- closed under the OLD automatic rule -- paid, Cash, no invoice number --
-- get no_invoice_required = true, so they stay closed exactly as they appear
-- today. That backfill runs only in the same block that creates the column,
-- so re-running this file can never apply the old Cash rule to newer jobs.
-- No existing value is changed (only the new column is filled; updated_at is
-- untouched).
--
-- Compatibility with the currently deployed app (a593d9c): its Billing route
-- calls upsert_completed_job_billing with the SAME six arguments, which this
-- file replaces in place with the same signature. Ordinary Billing edits
-- keep working; typing an "SFT..." number is refused as 23505 (the deployed
-- app shows "That invoice number is already used by another job in this
-- workspace."). The deployed app cannot create invoices, so the other new
-- refusals cannot reach it.
--
-- Error codes raised (the new app maps them by message token):
--   23505  completed_job_billing_invoice_number_reserved   (typed "SFT...")
--   IV002  completed_job_billing_invoice_number_locked     (change/clear an issued SFT number)
--   IV003  completed_job_billing_invoice_draft_exists      (link while an SFT draft exists)
--   IV010  invoice_locked                                   (any write to a frozen invoice)
--
-- Safe to re-run. Rollback (only before any invoice exists):
--   DROP FUNCTION issue_invoice, void_invoice, create_invoice_draft,
--     update_invoice_draft, discard_invoice_draft, invoice_render_input,
--     invoice_render_snapshot, set_no_invoice_required, invoice_guard;
--   DROP TABLE invoices, invoice_counters;
--   re-run migration 033's upsert_completed_job_billing body;
--   ALTER TABLE completed_job_billing DROP COLUMN no_invoice_required;
--   restore the 5-value payment_method CHECK (only if no 'venmo' row exists).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. completed_job_billing: no_invoice_required (+ one-time backfill), Venmo
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'completed_job_billing' AND column_name = 'no_invoice_required'
  ) THEN
    ALTER TABLE completed_job_billing ADD COLUMN no_invoice_required BOOLEAN NOT NULL DEFAULT false;

    -- One-time: preserve jobs closed by the old automatic Cash rule.
    UPDATE completed_job_billing
    SET no_invoice_required = true
    WHERE paid = true AND payment_method = 'cash' AND invoice_number IS NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'completed_job_billing_no_invoice_required_shape') THEN
    ALTER TABLE completed_job_billing ADD CONSTRAINT completed_job_billing_no_invoice_required_shape
      CHECK (no_invoice_required = false OR (paid = true AND payment_method IS NOT NULL AND invoice_number IS NULL));
  END IF;
END $$;

ALTER TABLE completed_job_billing DROP CONSTRAINT IF EXISTS completed_job_billing_payment_method_valid;
ALTER TABLE completed_job_billing ADD CONSTRAINT completed_job_billing_payment_method_valid
  CHECK (payment_method IS NULL OR payment_method IN ('zelle', 'venmo', 'check', 'cash', 'quickbooks_card', 'other'));

-- ---------------------------------------------------------------------------
-- 2. invoices + invoice_counters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_counters (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  next_number  INTEGER NOT NULL DEFAULT 1001 CHECK (next_number >= 1),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  appointment_id           UUID NOT NULL,
  client_id                UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  request_id               UUID NOT NULL,
  reissued_from_invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  status                   TEXT NOT NULL DEFAULT 'draft',
  revision                 INTEGER NOT NULL DEFAULT 1,
  invoice_number           TEXT,

  -- Everything printed on the PDF (a saved copy, never read live).
  business_name            TEXT NOT NULL,
  business_address         TEXT,
  business_phone           TEXT,
  business_email           TEXT,
  bill_to_name             TEXT NOT NULL,
  bill_to_address          TEXT,
  bill_to_email            TEXT,
  terms                    TEXT NOT NULL DEFAULT 'due_on_receipt',
  invoice_date             DATE NOT NULL,
  due_date                 DATE NOT NULL,
  service_date             DATE NOT NULL,
  product_service          TEXT NOT NULL,
  description              TEXT,
  quantity                 NUMERIC(10,2) NOT NULL DEFAULT 1,
  rate_cents               INTEGER NOT NULL,
  amount_cents             INTEGER NOT NULL,
  total_cents              INTEGER NOT NULL,
  payment_instructions     TEXT,
  note_to_client           TEXT,
  job_price_cents          INTEGER, -- the job's price when the draft was made (reference only)

  -- Set by issue_invoice / void_invoice only.
  issued_at                TIMESTAMPTZ,
  render_snapshot          JSONB,
  pdf                      BYTEA,
  pdf_sha256               TEXT,
  voided_at                TIMESTAMPTZ,
  void_reason              TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invoices_appointment_workspace_fkey
    FOREIGN KEY (appointment_id, workspace_id) REFERENCES appointments(id, workspace_id) ON DELETE RESTRICT,
  CONSTRAINT invoices_status_valid CHECK (status IN ('draft', 'issued', 'void')),
  CONSTRAINT invoices_terms_valid CHECK (terms IN ('due_on_receipt', 'net_15', 'net_30')),
  CONSTRAINT invoices_dates_valid CHECK (due_date >= invoice_date),
  CONSTRAINT invoices_names_present CHECK (btrim(business_name) <> '' AND btrim(bill_to_name) <> '' AND btrim(product_service) <> ''),
  CONSTRAINT invoices_amounts_valid CHECK (
    quantity > 0 AND rate_cents >= 0
    AND amount_cents = round(quantity * rate_cents)
    AND total_cents = amount_cents -- no tax/shipping lines in v1
  ),
  CONSTRAINT invoices_revision_positive CHECK (revision >= 1),
  CONSTRAINT invoices_status_shape CHECK (
    (status = 'draft'
      AND invoice_number IS NULL AND issued_at IS NULL AND render_snapshot IS NULL
      AND pdf IS NULL AND pdf_sha256 IS NULL AND voided_at IS NULL AND void_reason IS NULL)
    OR (status IN ('issued', 'void')
      AND invoice_number ~ '^SFT-[1-9][0-9]*$' AND issued_at IS NOT NULL AND render_snapshot IS NOT NULL
      AND pdf IS NOT NULL AND pdf_sha256 ~ '^[0-9a-f]{64}$'
      AND ((status = 'issued' AND voided_at IS NULL AND void_reason IS NULL)
        OR (status = 'void' AND voided_at IS NOT NULL AND btrim(coalesce(void_reason, '')) <> '')))
  )
);

-- A number is unique in its workspace forever (issued or void), so a retired
-- number can never come back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_workspace_number
  ON invoices (workspace_id, invoice_number) WHERE invoice_number IS NOT NULL;
-- Double-click / retry protection for draft creation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_workspace_request
  ON invoices (workspace_id, request_id);
-- One job, one live invoice (a draft or an issued one). Void ones don't count.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_one_active_per_appointment
  ON invoices (appointment_id) WHERE status IN ('draft', 'issued');
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_id ON invoices (workspace_id);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE invoices FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE invoice_counters FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The guard trigger: revisions for drafts, frozen issued/void invoices
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION invoice_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  -- Columns that are NOT printed content.
  meta CONSTANT TEXT[] := ARRAY['status', 'revision', 'invoice_number', 'issued_at', 'render_snapshot',
                                'pdf', 'pdf_sha256', 'voided_at', 'void_reason', 'updated_at'];
  ident CONSTANT TEXT[] := ARRAY['id', 'workspace_id', 'appointment_id', 'client_id', 'request_id',
                                 'reissued_from_invoice_id', 'created_at', 'job_price_cents'];
  o JSONB;
  n JSONB;
  k TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'invoice_locked' USING ERRCODE = 'IV010', DETAIL = 'only drafts can be deleted';
    END IF;
    RETURN OLD;
  END IF;

  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  FOREACH k IN ARRAY ident LOOP
    IF o -> k IS DISTINCT FROM n -> k THEN
      RAISE EXCEPTION 'invoice_locked' USING ERRCODE = 'IV010', DETAIL = k || ' cannot change';
    END IF;
  END LOOP;

  NEW.updated_at := now();

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    -- Any change to printed content is a new revision, whatever the caller sent.
    IF (o - meta) IS DISTINCT FROM (n - meta) THEN
      NEW.revision := OLD.revision + 1;
    ELSE
      NEW.revision := OLD.revision;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'issued' THEN
    IF (o - meta) IS DISTINCT FROM (n - meta) OR NEW.revision <> OLD.revision THEN
      RAISE EXCEPTION 'invoice_locked' USING ERRCODE = 'IV010', DETAIL = 'content cannot change while issuing';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'issued' AND NEW.status = 'void' THEN
    IF (o - ARRAY['status', 'voided_at', 'void_reason', 'updated_at']) IS DISTINCT FROM
       (n - ARRAY['status', 'voided_at', 'void_reason', 'updated_at']) THEN
      RAISE EXCEPTION 'invoice_locked' USING ERRCODE = 'IV010', DETAIL = 'voiding changes only the void fields';
    END IF;
    RETURN NEW;
  END IF;

  -- issued -> issued, void -> void: allowed only when nothing changes.
  IF OLD.status = NEW.status AND (o - 'updated_at') = (n - 'updated_at') THEN
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invoice_locked' USING ERRCODE = 'IV010',
    DETAIL = format('%s invoice cannot become %s or be edited', OLD.status, NEW.status);
END;
$fn$;

DROP TRIGGER IF EXISTS invoices_guard ON invoices;
CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoice_guard();

-- ---------------------------------------------------------------------------
-- 4. The canonical render input
-- ---------------------------------------------------------------------------

-- Every value the PDF prints, for one invoice row and one number. The app
-- renders only from this; issue_invoice compares against it.
CREATE OR REPLACE FUNCTION invoice_render_snapshot(p_inv invoices, p_invoice_number TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'invoice_id', p_inv.id,
    'revision', p_inv.revision,
    'invoice_number', p_invoice_number,
    'business_name', p_inv.business_name,
    'business_address', p_inv.business_address,
    'business_phone', p_inv.business_phone,
    'business_email', p_inv.business_email,
    'bill_to_name', p_inv.bill_to_name,
    'bill_to_address', p_inv.bill_to_address,
    'bill_to_email', p_inv.bill_to_email,
    'terms', p_inv.terms,
    'invoice_date', to_char(p_inv.invoice_date, 'YYYY-MM-DD'),
    'due_date', to_char(p_inv.due_date, 'YYYY-MM-DD'),
    'service_date', to_char(p_inv.service_date, 'YYYY-MM-DD'),
    'product_service', p_inv.product_service,
    'description', p_inv.description,
    'quantity', p_inv.quantity,
    'rate_cents', p_inv.rate_cents,
    'amount_cents', p_inv.amount_cents,
    'subtotal_cents', p_inv.amount_cents,
    'total_cents', p_inv.total_cents,
    'balance_due_cents', p_inv.total_cents,
    'payment_instructions', p_inv.payment_instructions,
    'note_to_client', p_inv.note_to_client
  );
$fn$;

CREATE OR REPLACE FUNCTION invoice_render_input(p_workspace_id UUID, p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  v_inv invoices;
  v_next INTEGER;
  v_number TEXT;
BEGIN
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_inv.status <> 'draft' THEN
    RETURN jsonb_build_object('outcome', 'not_draft', 'status', v_inv.status, 'invoice_number', v_inv.invoice_number);
  END IF;
  SELECT next_number INTO v_next FROM invoice_counters WHERE workspace_id = p_workspace_id;
  v_number := 'SFT-' || coalesce(v_next, 1001);
  RETURN jsonb_build_object(
    'outcome', 'ok',
    'revision', v_inv.revision,
    'invoice_number', v_number,
    'render_snapshot', invoice_render_snapshot(v_inv, v_number)
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Billing write path (same signature as 033; deployed app keeps working)
-- ---------------------------------------------------------------------------

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
  v_current_number text;
  v_invoice invoices;
BEGIN
  -- 049: the appointment row is the per-job lock shared by every billing and
  -- invoice write (create draft, issue, void, direct payment, this), always
  -- taken first, so two of them for the same job run one after the other.
  PERFORM 1 FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR NO KEY UPDATE;

  SELECT invoice_number INTO v_current_number
  FROM completed_job_billing
  WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id;

  SELECT * INTO v_invoice
  FROM invoices
  WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id AND status IN ('draft', 'issued');

  IF v_invoice.status = 'issued' THEN
    -- Paid / payment method stay editable; the SFT number does not.
    IF p_invoice_number IS DISTINCT FROM v_invoice.invoice_number THEN
      RAISE EXCEPTION 'completed_job_billing_invoice_number_locked' USING ERRCODE = 'IV002';
    END IF;
  ELSIF v_invoice.status = 'draft' AND p_invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'completed_job_billing_invoice_draft_exists' USING ERRCODE = 'IV003';
  ELSIF p_invoice_number IS NOT NULL
        AND p_invoice_number IS DISTINCT FROM v_current_number
        AND upper(btrim(p_invoice_number)) LIKE 'SFT%' THEN
    -- Reserved for SFT's own series (issued, retired or future). A legacy
    -- row that already holds such a number keeps it (not "changing").
    RAISE EXCEPTION 'completed_job_billing_invoice_number_reserved' USING ERRCODE = 'unique_violation';
  END IF;

  IF p_invoice_number IS NOT NULL THEN
    -- Rule #2 (033): not already used by a different client in this workspace.
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
        -- 049: setting a number or marking unpaid ends "paid directly".
        no_invoice_required = CASE
          WHEN EXCLUDED.invoice_number IS NOT NULL OR EXCLUDED.paid = false OR EXCLUDED.payment_method IS NULL THEN false
          ELSE completed_job_billing.no_invoice_required
        END,
        updated_at = now()
  RETURNING * INTO v_row;

  -- Rule #4 (033): paid status belongs to the invoice.
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

-- ---------------------------------------------------------------------------
-- 6. Paid directly, no invoice
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_no_invoice_required(
  p_workspace_id UUID,
  p_appointment_id UUID,
  p_no_invoice_required BOOLEAN,
  p_payment_method TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_client UUID;
  v_billing completed_job_billing;
  v_row completed_job_billing;
BEGIN
  SELECT client_id INTO v_client FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  SELECT * INTO v_billing FROM completed_job_billing
  WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id;

  IF NOT p_no_invoice_required THEN
    -- Undo: an invoice is needed again. Paid / method are left as they are.
    UPDATE completed_job_billing SET no_invoice_required = false, updated_at = now()
    WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id
    RETURNING * INTO v_row;
    RETURN jsonb_build_object('outcome', 'ok', 'billing', to_jsonb(v_row));
  END IF;

  IF p_payment_method IS NULL OR p_payment_method NOT IN ('zelle', 'venmo', 'check', 'cash', 'quickbooks_card', 'other') THEN
    RETURN jsonb_build_object('outcome', 'invalid_payment_method');
  END IF;
  IF EXISTS (SELECT 1 FROM invoices WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id
             AND status IN ('draft', 'issued')) THEN
    RETURN jsonb_build_object('outcome', 'job_has_invoice');
  END IF;
  IF v_billing.invoice_number IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'job_has_invoice_number', 'invoice_number', v_billing.invoice_number);
  END IF;

  INSERT INTO completed_job_billing (workspace_id, appointment_id, client_id, invoice_number, paid, payment_method, no_invoice_required, updated_at)
  VALUES (p_workspace_id, p_appointment_id, v_client, NULL, true, p_payment_method, true, now())
  ON CONFLICT (appointment_id) DO UPDATE
    SET client_id = EXCLUDED.client_id, paid = true, payment_method = EXCLUDED.payment_method,
        no_invoice_required = true, updated_at = now()
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'ok', 'billing', to_jsonb(v_row));
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 7. Drafts
-- ---------------------------------------------------------------------------

-- Creates the draft for one completed job (the app checks completion with
-- isCompletedForBilling before calling). Same p_request_id again = the same
-- draft back (double-click / retry).
CREATE OR REPLACE FUNCTION create_invoice_draft(
  p_workspace_id UUID,
  p_appointment_id UUID,
  p_request_id UUID,
  p_draft JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_appt RECORD;
  v_existing invoices;
  v_active invoices;
  v_billing completed_job_billing;
  v_from invoices;
  v_from_id UUID;
  v_qty NUMERIC(10,2);
  v_rate INTEGER;
  v_amount INTEGER;
  v_row invoices;
BEGIN
  IF p_workspace_id IS NULL OR p_appointment_id IS NULL OR p_request_id IS NULL OR jsonb_typeof(p_draft) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;

  SELECT id, client_id, status, price_cents INTO v_appt FROM appointments
  WHERE id = p_appointment_id AND workspace_id = p_workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Replay (checked after the job lock, so a simultaneous duplicate waits
  -- and then finds the first one's draft).
  SELECT * INTO v_existing FROM invoices WHERE workspace_id = p_workspace_id AND request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.appointment_id <> p_appointment_id THEN
      RETURN jsonb_build_object('outcome', 'request_id_conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'ok', 'replayed', true, 'invoice_id', v_existing.id,
                              'revision', v_existing.revision, 'status', v_existing.status);
  END IF;

  IF v_appt.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'appointment_cancelled');
  END IF;
  SELECT * INTO v_active FROM invoices
  WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id AND status IN ('draft', 'issued');
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'job_has_invoice', 'invoice_id', v_active.id, 'status', v_active.status,
                              'invoice_number', v_active.invoice_number);
  END IF;
  SELECT * INTO v_billing FROM completed_job_billing
  WHERE appointment_id = p_appointment_id AND workspace_id = p_workspace_id;
  IF v_billing.invoice_number IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'job_has_invoice_number', 'invoice_number', v_billing.invoice_number);
  END IF;
  IF v_billing.no_invoice_required THEN
    RETURN jsonb_build_object('outcome', 'job_paid_directly');
  END IF;

  v_from_id := NULLIF(p_draft ->> 'reissued_from_invoice_id', '')::uuid;
  IF v_from_id IS NOT NULL THEN
    SELECT * INTO v_from FROM invoices WHERE id = v_from_id AND workspace_id = p_workspace_id;
    IF NOT FOUND OR v_from.status <> 'void' OR v_from.appointment_id <> p_appointment_id THEN
      RETURN jsonb_build_object('outcome', 'invalid_reissue');
    END IF;
  END IF;

  v_qty := coalesce((p_draft ->> 'quantity')::numeric, 1);
  v_rate := (p_draft ->> 'rate_cents')::integer;
  IF v_rate IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'field', 'rate_cents');
  END IF;
  v_amount := round(v_qty * v_rate);

  INSERT INTO invoices (
    workspace_id, appointment_id, client_id, request_id, reissued_from_invoice_id,
    business_name, business_address, business_phone, business_email,
    bill_to_name, bill_to_address, bill_to_email,
    terms, invoice_date, due_date, service_date, product_service, description,
    quantity, rate_cents, amount_cents, total_cents,
    payment_instructions, note_to_client, job_price_cents
  ) VALUES (
    p_workspace_id, p_appointment_id, v_appt.client_id, p_request_id, v_from_id,
    coalesce(p_draft ->> 'business_name', ''), p_draft ->> 'business_address', p_draft ->> 'business_phone', p_draft ->> 'business_email',
    coalesce(p_draft ->> 'bill_to_name', ''), p_draft ->> 'bill_to_address', p_draft ->> 'bill_to_email',
    coalesce(p_draft ->> 'terms', 'due_on_receipt'),
    (p_draft ->> 'invoice_date')::date, (p_draft ->> 'due_date')::date, (p_draft ->> 'service_date')::date,
    coalesce(p_draft ->> 'product_service', ''), p_draft ->> 'description',
    v_qty, v_rate, v_amount, v_amount,
    p_draft ->> 'payment_instructions', p_draft ->> 'note_to_client', v_appt.price_cents
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('outcome', 'ok', 'replayed', false, 'invoice_id', v_row.id,
                            'revision', v_row.revision, 'status', v_row.status);
END;
$fn$;

-- Replaces a draft's printed content. p_expected_revision guards against
-- two tabs overwriting each other.
CREATE OR REPLACE FUNCTION update_invoice_draft(
  p_workspace_id UUID,
  p_invoice_id UUID,
  p_expected_revision INTEGER,
  p_draft JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_appointment UUID;
  v_inv invoices;
  v_qty NUMERIC(10,2);
  v_rate INTEGER;
  v_amount INTEGER;
BEGIN
  IF jsonb_typeof(p_draft) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  SELECT appointment_id INTO v_appointment FROM invoices WHERE id = p_invoice_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM 1 FROM appointments WHERE id = v_appointment AND workspace_id = p_workspace_id FOR NO KEY UPDATE;
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;

  IF v_inv.status <> 'draft' THEN
    RETURN jsonb_build_object('outcome', 'not_draft', 'status', v_inv.status, 'invoice_number', v_inv.invoice_number);
  END IF;
  IF v_inv.revision <> p_expected_revision THEN
    RETURN jsonb_build_object('outcome', 'stale_revision', 'revision', v_inv.revision);
  END IF;

  v_qty := coalesce((p_draft ->> 'quantity')::numeric, 1);
  v_rate := (p_draft ->> 'rate_cents')::integer;
  IF v_rate IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input', 'field', 'rate_cents');
  END IF;
  v_amount := round(v_qty * v_rate);

  UPDATE invoices SET
    business_name = coalesce(p_draft ->> 'business_name', ''),
    business_address = p_draft ->> 'business_address',
    business_phone = p_draft ->> 'business_phone',
    business_email = p_draft ->> 'business_email',
    bill_to_name = coalesce(p_draft ->> 'bill_to_name', ''),
    bill_to_address = p_draft ->> 'bill_to_address',
    bill_to_email = p_draft ->> 'bill_to_email',
    terms = coalesce(p_draft ->> 'terms', 'due_on_receipt'),
    invoice_date = (p_draft ->> 'invoice_date')::date,
    due_date = (p_draft ->> 'due_date')::date,
    service_date = (p_draft ->> 'service_date')::date,
    product_service = coalesce(p_draft ->> 'product_service', ''),
    description = p_draft ->> 'description',
    quantity = v_qty,
    rate_cents = v_rate,
    amount_cents = v_amount,
    total_cents = v_amount,
    payment_instructions = p_draft ->> 'payment_instructions',
    note_to_client = p_draft ->> 'note_to_client'
  WHERE id = p_invoice_id
  RETURNING * INTO v_inv;

  RETURN jsonb_build_object('outcome', 'ok', 'invoice_id', v_inv.id, 'revision', v_inv.revision);
END;
$fn$;

CREATE OR REPLACE FUNCTION discard_invoice_draft(p_workspace_id UUID, p_invoice_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_appointment UUID;
  v_inv invoices;
BEGIN
  SELECT appointment_id INTO v_appointment FROM invoices WHERE id = p_invoice_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM 1 FROM appointments WHERE id = v_appointment AND workspace_id = p_workspace_id FOR NO KEY UPDATE;
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.status <> 'draft' THEN
    RETURN jsonb_build_object('outcome', 'not_draft', 'status', v_inv.status);
  END IF;
  DELETE FROM invoices WHERE id = p_invoice_id;
  RETURN jsonb_build_object('outcome', 'ok');
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Issue: number + stored PDF + Billing, together
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION issue_invoice(
  p_workspace_id UUID,
  p_invoice_id UUID,
  p_revision INTEGER,
  p_invoice_number TEXT,
  p_render_snapshot JSONB,
  p_pdf_base64 TEXT,
  p_pdf_sha256 TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_appointment UUID;
  v_inv invoices;
  v_billing completed_job_billing;
  v_next INTEGER;
  v_expected TEXT;
  v_pdf BYTEA;
BEGIN
  SELECT appointment_id INTO v_appointment FROM invoices WHERE id = p_invoice_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Lock order: appointment -> invoice -> counter -> billing row.
  PERFORM 1 FROM appointments WHERE id = v_appointment AND workspace_id = p_workspace_id FOR NO KEY UPDATE;
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;

  IF v_inv.status = 'issued' THEN
    -- Already issued (double-click / retry): the stored document is the one.
    RETURN jsonb_build_object('outcome', 'already_issued', 'invoice_id', v_inv.id,
                              'invoice_number', v_inv.invoice_number, 'revision', v_inv.revision,
                              'pdf_sha256', v_inv.pdf_sha256);
  END IF;
  IF v_inv.status = 'void' THEN
    RETURN jsonb_build_object('outcome', 'invoice_void', 'invoice_number', v_inv.invoice_number);
  END IF;
  IF v_inv.revision IS DISTINCT FROM p_revision THEN
    RETURN jsonb_build_object('outcome', 'stale_revision', 'revision', v_inv.revision);
  END IF;

  SELECT * INTO v_billing FROM completed_job_billing
  WHERE appointment_id = v_appointment AND workspace_id = p_workspace_id;
  IF v_billing.invoice_number IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'job_has_invoice_number', 'invoice_number', v_billing.invoice_number);
  END IF;
  IF v_billing.no_invoice_required THEN
    RETURN jsonb_build_object('outcome', 'job_paid_directly');
  END IF;

  INSERT INTO invoice_counters (workspace_id) VALUES (p_workspace_id) ON CONFLICT (workspace_id) DO NOTHING;
  SELECT next_number INTO v_next FROM invoice_counters WHERE workspace_id = p_workspace_id FOR UPDATE;
  v_expected := 'SFT-' || v_next;
  IF p_invoice_number IS DISTINCT FROM v_expected THEN
    RETURN jsonb_build_object('outcome', 'number_changed', 'invoice_number', v_expected, 'revision', v_inv.revision);
  END IF;

  IF p_render_snapshot IS DISTINCT FROM invoice_render_snapshot(v_inv, v_expected) THEN
    RETURN jsonb_build_object('outcome', 'snapshot_mismatch');
  END IF;

  BEGIN
    v_pdf := decode(p_pdf_base64, 'base64');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'pdf_invalid');
  END;
  IF v_pdf IS NULL OR length(v_pdf) < 5 OR substring(v_pdf FROM 1 FOR 5) <> '\x255044462d'::bytea -- "%PDF-"
     OR p_pdf_sha256 IS NULL OR encode(sha256(v_pdf), 'hex') <> lower(p_pdf_sha256) THEN
    RETURN jsonb_build_object('outcome', 'pdf_invalid');
  END IF;

  UPDATE invoices
  SET status = 'issued',
      invoice_number = v_expected,
      issued_at = now(),
      render_snapshot = p_render_snapshot,
      pdf = v_pdf,
      pdf_sha256 = lower(p_pdf_sha256)
  WHERE id = p_invoice_id;

  UPDATE invoice_counters SET next_number = v_next + 1, updated_at = now() WHERE workspace_id = p_workspace_id;

  -- Billing gets the number; paid / payment method stay as they were.
  PERFORM upsert_completed_job_billing(
    p_workspace_id, v_appointment, v_inv.client_id, v_expected,
    coalesce(v_billing.paid, false), v_billing.payment_method
  );

  RETURN jsonb_build_object('outcome', 'issued', 'invoice_id', p_invoice_id,
                            'invoice_number', v_expected, 'revision', v_inv.revision,
                            'pdf_sha256', lower(p_pdf_sha256));
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. Void (number retired forever; Billing number cleared)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION void_invoice(p_workspace_id UUID, p_invoice_id UUID, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_appointment UUID;
  v_inv invoices;
  v_billing completed_job_billing;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('outcome', 'reason_required');
  END IF;
  SELECT appointment_id INTO v_appointment FROM invoices WHERE id = p_invoice_id AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  PERFORM 1 FROM appointments WHERE id = v_appointment AND workspace_id = p_workspace_id FOR NO KEY UPDATE;
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.status <> 'issued' THEN
    RETURN jsonb_build_object('outcome', 'not_issued', 'status', v_inv.status);
  END IF;

  SELECT * INTO v_billing FROM completed_job_billing
  WHERE appointment_id = v_appointment AND workspace_id = p_workspace_id;
  IF v_billing.paid THEN
    RETURN jsonb_build_object('outcome', 'invoice_paid');
  END IF;

  UPDATE invoices SET status = 'void', voided_at = now(), void_reason = btrim(p_reason) WHERE id = p_invoice_id;

  IF v_billing.invoice_number = v_inv.invoice_number THEN
    PERFORM upsert_completed_job_billing(
      p_workspace_id, v_appointment, v_inv.client_id, NULL, false, v_billing.payment_method
    );
  END IF;

  RETURN jsonb_build_object('outcome', 'ok', 'invoice_id', p_invoice_id, 'invoice_number', v_inv.invoice_number);
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 10. Grants: service role only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION invoice_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION invoice_render_snapshot(invoices, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION invoice_render_input(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION set_no_invoice_required(UUID, UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_invoice_draft(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION update_invoice_draft(UUID, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION discard_invoice_draft(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION issue_invoice(UUID, UUID, INTEGER, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION void_invoice(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION invoice_render_input(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION set_no_invoice_required(UUID, UUID, BOOLEAN, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION create_invoice_draft(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION update_invoice_draft(UUID, UUID, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION discard_invoice_draft(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION issue_invoice(UUID, UUID, INTEGER, TEXT, JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION void_invoice(UUID, UUID, TEXT) TO service_role;
GRANT SELECT ON TABLE invoices TO service_role;
GRANT SELECT ON TABLE invoice_counters TO service_role;

COMMIT;
