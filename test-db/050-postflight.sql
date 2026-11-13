-- READ-ONLY postflight for migrations/050_invoice_email.sql.
-- Run in the Supabase SQL Editor right AFTER applying 050. A single SELECT:
-- it changes nothing. Every row must say ok = true. Counts only.
--
-- check                     what it proves
--   message_columns         messages_sent.invoice_id / send_request_id / attachment_sha256 (nullable)
--   existing_rows_untouched every existing message row has the three new columns NULL
--   invoice_link            (invoice_id, workspace_id) -> invoices(id, workspace_id) + shape CHECK
--   send_indexes            one attempt per request id; one in-flight send per invoice
--   functions_present       claim_invoice_send, finish_invoice_send, invoice_send_state
--   no_public_access        anon / authenticated cannot run the functions
--   no_invoice_emails_yet   informational: invoice email attempts (0 until the new app is deployed)
WITH checks(check_name, ok, detail) AS (
  SELECT 'message_columns',
         (SELECT count(*) = 3 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'messages_sent' AND is_nullable = 'YES'
             AND column_name IN ('invoice_id', 'send_request_id', 'attachment_sha256')),
         'three nullable columns present'
  UNION ALL
  SELECT 'existing_rows_untouched',
         NOT EXISTS (SELECT 1 FROM messages_sent WHERE kind <> 'invoice'
                       AND (invoice_id IS NOT NULL OR send_request_id IS NOT NULL OR attachment_sha256 IS NOT NULL)),
         (SELECT count(*) FROM messages_sent WHERE kind <> 'invoice')::text || ' existing message row(s), new columns empty'
  UNION ALL
  SELECT 'invoice_link',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_id_workspace_id_key')
           AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_invoice_fkey' AND contype = 'f')
           AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_invoice_shape' AND contype = 'c'),
         'workspace-scoped invoice link and shape check present'
  UNION ALL
  SELECT 'send_indexes',
         (SELECT count(*) = 2 FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname
           JOIN pg_index x ON x.indexrelid = c.oid
           WHERE i.schemaname = 'public' AND x.indisunique
             AND i.indexname IN ('idx_messages_sent_workspace_send_request', 'idx_messages_sent_invoice_sending')),
         'two unique indexes present'
  UNION ALL
  SELECT 'functions_present',
         to_regprocedure('public.claim_invoice_send(uuid,uuid,uuid,text,text,text,uuid)') IS NOT NULL
           AND to_regprocedure('public.finish_invoice_send(uuid,uuid,text)') IS NOT NULL
           AND to_regprocedure('public.invoice_send_state(text,timestamptz)') IS NOT NULL,
         'all 050 functions present'
  UNION ALL
  SELECT 'no_public_access',
         NOT EXISTS (
           SELECT 1 FROM pg_proc p, unnest(ARRAY['anon', 'authenticated']) r
           WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname IN ('claim_invoice_send', 'finish_invoice_send', 'invoice_send_state')
             AND has_function_privilege(r, p.oid, 'EXECUTE')),
         'service role only'
  UNION ALL
  SELECT 'no_invoice_emails_yet', true,
         (SELECT count(*) FROM messages_sent WHERE invoice_id IS NOT NULL)::text || ' invoice email attempt(s)'
)
SELECT check_name, ok, detail FROM checks;
