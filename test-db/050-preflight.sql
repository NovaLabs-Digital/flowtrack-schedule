-- READ-ONLY preflight for migrations/050_invoice_email.sql.
-- Run in the Supabase SQL Editor BEFORE applying 050. A single SELECT: it
-- changes nothing. Every row must say ok = true before 050 is applied.
-- Counts only.
--
-- check                     what it proves
--   migration_049_applied   invoices + issue_invoice exist
--   messages_sent_shape     messages_sent has the columns 050 builds on
--   not_applied_yet         messages_sent.invoice_id absent (if false: run 050-postflight.sql)
--   no_name_conflicts       no existing 050 functions, constraints or indexes
--   invoice_ids_unique      (id, workspace_id) can be made unique on invoices (always true: id is the key)
WITH checks(check_name, ok, detail) AS (
  SELECT 'migration_049_applied',
         to_regclass('public.invoices') IS NOT NULL
           AND to_regprocedure('public.issue_invoice(uuid,uuid,integer,text,jsonb,text,text)') IS NOT NULL,
         'invoices table and issue_invoice present'
  UNION ALL
  SELECT 'messages_sent_shape',
         (SELECT count(*) = 8 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'messages_sent'
             AND column_name IN ('id', 'appointment_id', 'channel', 'kind', 'to_value', 'body', 'provider_id', 'workspace_id')),
         'messages_sent core columns present'
  UNION ALL
  SELECT 'not_applied_yet',
         NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'messages_sent' AND column_name = 'invoice_id'),
         'messages_sent.invoice_id not yet present'
  UNION ALL
  SELECT 'no_name_conflicts',
         to_regprocedure('public.claim_invoice_send(uuid,uuid,uuid,text,text,text,uuid)') IS NULL
           AND to_regprocedure('public.finish_invoice_send(uuid,uuid,text)') IS NULL
           AND to_regprocedure('public.invoice_send_state(text,timestamptz)') IS NULL
           AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN
                 ('invoices_id_workspace_id_key', 'messages_sent_invoice_fkey', 'messages_sent_invoice_shape'))
           AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname IN
                 ('idx_messages_sent_workspace_send_request', 'idx_messages_sent_invoice_sending', 'idx_messages_sent_invoice')),
         'no existing 050 objects'
  UNION ALL
  SELECT 'invoice_ids_unique',
         NOT EXISTS (SELECT id, workspace_id FROM invoices GROUP BY id, workspace_id HAVING count(*) > 1),
         (SELECT count(*) FROM invoices)::text || ' invoice(s)'
)
SELECT check_name, ok, detail FROM checks;
