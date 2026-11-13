-- 050: Review & Send for issued SFT invoices (email with the stored PDF).
--
-- Every send attempt is a Message History row (messages_sent, kind
-- 'invoice', channel 'email'), linked to its invoice. The app never emails
-- an invoice on its own: issuing writes nothing here.
--
--  * claim_invoice_send(workspace, invoice, request_id, to, subject, body,
--    acknowledged_attempt_id) locks the invoice row, then:
--      - the same request_id again (double-click / retry) -> 'replay': the
--        existing attempt, no second row, no second email;
--      - not an issued invoice (draft or void)         -> 'not_issued';
--      - an attempt still in flight (< 2 minutes)       -> 'in_progress';
--      - an earlier attempt that went out ('sent') or whose outcome is
--        unknown ('uncertain') must be acknowledged by its id before another
--        send            -> 'needs_acknowledgement' (with that attempt);
--      - otherwise inserts the attempt with provider_id 'sending' and the
--        stored PDF's sha256 (the exact attachment) -> 'claimed'.
--    A stale in-flight attempt (>= 2 minutes, e.g. the server stopped
--    mid-send) is treated as 'uncertain' and marked 'unconfirmed' when the
--    owner acknowledges it and sends again.
--  * finish_invoice_send(workspace, message, provider_id) records the
--    outcome: the provider's email id (accepted -> "Sent — delivery
--    unconfirmed"), 'failed' (confirmed rejection), 'unconfirmed' (unknown
--    outcome) or 'disabled' (sending switched off on this server).
--
-- Workspace isolation: (invoice_id, workspace_id) references
-- invoices(id, workspace_id), so an attempt can only point at an invoice of
-- its own workspace.
--
-- Compatibility with the deployed app (c023ca6): only new NULLable columns
-- on messages_sent; every existing insert (reminders, appointment emails)
-- keeps working unchanged and leaves them NULL.
--
-- Safe to re-run. Rollback (before any invoice email exists):
--   DROP FUNCTION claim_invoice_send, finish_invoice_send;
--   ALTER TABLE messages_sent DROP COLUMN invoice_id, DROP COLUMN send_request_id,
--     DROP COLUMN attachment_sha256;
--   ALTER TABLE invoices DROP CONSTRAINT invoices_id_workspace_id_key;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_id_workspace_id_key') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_id_workspace_id_key UNIQUE (id, workspace_id);
  END IF;
END $$;

ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS invoice_id UUID;
ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS send_request_id UUID;
ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS attachment_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_invoice_fkey') THEN
    ALTER TABLE messages_sent ADD CONSTRAINT messages_sent_invoice_fkey
      FOREIGN KEY (invoice_id, workspace_id) REFERENCES invoices(id, workspace_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_invoice_shape') THEN
    ALTER TABLE messages_sent ADD CONSTRAINT messages_sent_invoice_shape CHECK (
      (invoice_id IS NULL AND send_request_id IS NULL AND attachment_sha256 IS NULL)
      OR (invoice_id IS NOT NULL AND kind = 'invoice' AND channel = 'email'
          AND send_request_id IS NOT NULL AND attachment_sha256 ~ '^[0-9a-f]{64}$')
    );
  END IF;
END $$;

-- One attempt per request id (double-click / retry protection).
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sent_workspace_send_request
  ON messages_sent (workspace_id, send_request_id) WHERE send_request_id IS NOT NULL;
-- At most one send in flight per invoice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_sent_invoice_sending
  ON messages_sent (invoice_id) WHERE invoice_id IS NOT NULL AND provider_id = 'sending';
CREATE INDEX IF NOT EXISTS idx_messages_sent_invoice
  ON messages_sent (invoice_id, created_at) WHERE invoice_id IS NOT NULL;

-- How an invoice attempt's provider_id reads:
--   'sent'      a provider email id (accepted; delivery itself unconfirmed)
--   'failed'    confirmed rejection (nothing was sent)
--   'disabled'  sending switched off on this server (nothing was sent)
--   'uncertain' 'unconfirmed', or 'sending' for 2 minutes or more
--   'sending'   in flight (< 2 minutes)
CREATE OR REPLACE FUNCTION invoice_send_state(p_provider_id TEXT, p_created_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $fn$
  SELECT CASE
    WHEN p_provider_id = 'sending' AND p_created_at > now() - interval '2 minutes' THEN 'sending'
    WHEN p_provider_id IN ('sending', 'unconfirmed') THEN 'uncertain'
    WHEN p_provider_id = 'failed' THEN 'failed'
    WHEN p_provider_id = 'disabled' THEN 'disabled'
    WHEN p_provider_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'sent'
    ELSE 'uncertain'
  END
$fn$;

CREATE OR REPLACE FUNCTION claim_invoice_send(
  p_workspace_id UUID,
  p_invoice_id UUID,
  p_request_id UUID,
  p_to TEXT,
  p_subject TEXT,
  p_body TEXT,
  p_acknowledged_attempt_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_inv invoices;
  v_msg messages_sent;
  v_open messages_sent;
  v_open_state TEXT;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'request_id');
  END IF;

  -- The invoice row is the per-invoice send lock (void_invoice takes it too).
  SELECT * INTO v_inv FROM invoices WHERE id = p_invoice_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- Same request again: the attempt it already made.
  SELECT * INTO v_msg FROM messages_sent WHERE workspace_id = p_workspace_id AND send_request_id = p_request_id;
  IF FOUND THEN
    IF v_msg.invoice_id IS DISTINCT FROM p_invoice_id THEN
      RETURN jsonb_build_object('outcome', 'request_conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'attempt_id', v_msg.id, 'provider_id', v_msg.provider_id,
                              'state', invoice_send_state(v_msg.provider_id, v_msg.created_at),
                              'to', v_msg.to_value, 'created_at', v_msg.created_at);
  END IF;

  IF v_inv.status <> 'issued' THEN
    RETURN jsonb_build_object('outcome', 'not_issued', 'status', v_inv.status);
  END IF;

  IF p_to IS NULL OR length(p_to) > 254 OR p_to !~ '^[^@[:space:]<>,;"()]+@[^@[:space:]<>,;"()]+\.[^@[:space:]<>,;"()]+$' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'to');
  END IF;
  IF p_subject IS NULL OR btrim(p_subject) = '' OR length(p_subject) > 200 OR p_subject ~ '[\r\n]' THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'subject');
  END IF;
  IF p_body IS NULL OR btrim(p_body) = '' OR length(p_body) > 10000 THEN
    RETURN jsonb_build_object('outcome', 'invalid', 'field', 'body');
  END IF;

  -- The most recent attempt that went out or whose outcome is unknown.
  SELECT * INTO v_open FROM messages_sent
  WHERE invoice_id = p_invoice_id
    AND invoice_send_state(provider_id, created_at) IN ('sending', 'sent', 'uncertain')
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF FOUND THEN
    v_open_state := invoice_send_state(v_open.provider_id, v_open.created_at);
    IF v_open_state = 'sending' THEN
      RETURN jsonb_build_object('outcome', 'in_progress', 'attempt_id', v_open.id, 'to', v_open.to_value, 'created_at', v_open.created_at);
    END IF;
    IF p_acknowledged_attempt_id IS DISTINCT FROM v_open.id THEN
      RETURN jsonb_build_object('outcome', 'needs_acknowledgement', 'attempt_id', v_open.id, 'state', v_open_state,
                                'to', v_open.to_value, 'created_at', v_open.created_at);
    END IF;
    IF v_open.provider_id = 'sending' THEN
      -- Stale in-flight attempt the owner has acknowledged as unknown.
      UPDATE messages_sent SET provider_id = 'unconfirmed' WHERE id = v_open.id;
    END IF;
  END IF;

  INSERT INTO messages_sent (appointment_id, channel, kind, to_value, body, subject, provider_id, workspace_id,
                             invoice_id, send_request_id, attachment_sha256)
  VALUES (v_inv.appointment_id, 'email', 'invoice', p_to, p_body, p_subject, 'sending', p_workspace_id,
          p_invoice_id, p_request_id, v_inv.pdf_sha256)
  RETURNING * INTO v_msg;

  RETURN jsonb_build_object('outcome', 'claimed', 'attempt_id', v_msg.id, 'invoice_number', v_inv.invoice_number,
                            'pdf_sha256', v_inv.pdf_sha256, 'created_at', v_msg.created_at);
END;
$fn$;

CREATE OR REPLACE FUNCTION finish_invoice_send(p_workspace_id UUID, p_attempt_id UUID, p_provider_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_msg messages_sent;
BEGIN
  IF p_provider_id IS NULL OR NOT (
       p_provider_id IN ('failed', 'unconfirmed', 'disabled')
       OR p_provider_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  SELECT * INTO v_msg FROM messages_sent
  WHERE id = p_attempt_id AND workspace_id = p_workspace_id AND invoice_id IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  -- Only an attempt whose outcome isn't known yet can be finished; a late
  -- answer for an attempt already marked 'unconfirmed' is still recorded.
  IF v_msg.provider_id NOT IN ('sending', 'unconfirmed') THEN
    RETURN jsonb_build_object('outcome', 'already_finished', 'provider_id', v_msg.provider_id);
  END IF;
  UPDATE messages_sent SET provider_id = p_provider_id WHERE id = p_attempt_id;
  RETURN jsonb_build_object('outcome', 'ok', 'state', invoice_send_state(p_provider_id, v_msg.created_at));
END;
$fn$;

REVOKE ALL ON FUNCTION invoice_send_state(TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION claim_invoice_send(UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION finish_invoice_send(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION invoice_send_state(TEXT, TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION claim_invoice_send(UUID, UUID, UUID, TEXT, TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION finish_invoice_send(UUID, UUID, TEXT) TO service_role;

COMMIT;
