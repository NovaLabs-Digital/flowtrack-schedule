-- READ-ONLY postflight for migrations/049_invoices.sql.
-- Run in the Supabase SQL Editor right AFTER applying 049. A single SELECT:
-- it changes nothing. Every row must say ok = true. Counts only.
--
-- check                           what it proves
--   no_invoice_column             completed_job_billing.no_invoice_required boolean NOT NULL default false
--   backfill_complete             every paid + Cash + no-number job is marked (true right after applying;
--                                 later an owner may undo one on purpose)
--   backfill_only_cash            every marked job is paid, Cash, with no number (nothing else was marked)
--   venmo_allowed                 payment method CHECK includes venmo
--   direct_payment_shape          the no_invoice_required shape CHECK exists
--   invoice_tables                invoices + invoice_counters exist with row level security on
--   invoice_indexes               number unique per workspace, request id unique, one live invoice per job
--   invoice_guard_trigger         the trigger freezing issued/void invoices exists
--   functions_present             all 049 functions exist; upsert keeps the 033 signature
--   no_public_access              anon / authenticated cannot read the tables or run the functions
--   no_invoices_yet               informational: invoice count (0 until the new app is deployed)
WITH checks(check_name, ok, detail) AS (
  SELECT 'no_invoice_column',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'completed_job_billing'
                   AND column_name = 'no_invoice_required' AND data_type = 'boolean'
                   AND is_nullable = 'NO' AND column_default = 'false'),
         'no_invoice_required boolean NOT NULL DEFAULT false'
  UNION ALL
  SELECT 'backfill_complete',
         NOT EXISTS (SELECT 1 FROM completed_job_billing
                     WHERE paid AND payment_method = 'cash' AND invoice_number IS NULL AND NOT no_invoice_required),
         (SELECT count(*) FROM completed_job_billing WHERE no_invoice_required)::text || ' job(s) marked Paid directly, no invoice'
  UNION ALL
  SELECT 'backfill_only_cash',
         NOT EXISTS (SELECT 1 FROM completed_job_billing
                     WHERE no_invoice_required AND NOT (paid AND payment_method = 'cash' AND invoice_number IS NULL)),
         'right after applying, only paid + Cash + no-number jobs are marked'
  UNION ALL
  SELECT 'venmo_allowed',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'completed_job_billing_payment_method_valid'
                   AND pg_get_constraintdef(oid) LIKE '%venmo%'),
         'completed_job_billing_payment_method_valid includes venmo'
  UNION ALL
  SELECT 'direct_payment_shape',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'completed_job_billing_no_invoice_required_shape'),
         'completed_job_billing_no_invoice_required_shape present'
  UNION ALL
  SELECT 'invoice_tables',
         (SELECT count(*) = 2 FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relname IN ('invoices', 'invoice_counters') AND relrowsecurity),
         'invoices, invoice_counters with RLS enabled'
  UNION ALL
  SELECT 'invoice_indexes',
         (SELECT count(*) = 3 FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname
           JOIN pg_index x ON x.indexrelid = c.oid
           WHERE i.schemaname = 'public' AND x.indisunique
             AND i.indexname IN ('idx_invoices_workspace_number', 'idx_invoices_workspace_request', 'idx_invoices_one_active_per_appointment')),
         'three unique indexes present'
  UNION ALL
  SELECT 'invoice_guard_trigger',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_guard' AND NOT tgisinternal),
         'invoices_guard present'
  UNION ALL
  SELECT 'functions_present',
         to_regprocedure('public.upsert_completed_job_billing(uuid,uuid,uuid,text,boolean,text)') IS NOT NULL
           AND to_regprocedure('public.set_no_invoice_required(uuid,uuid,boolean,text)') IS NOT NULL
           AND to_regprocedure('public.create_invoice_draft(uuid,uuid,uuid,jsonb)') IS NOT NULL
           AND to_regprocedure('public.update_invoice_draft(uuid,uuid,integer,jsonb)') IS NOT NULL
           AND to_regprocedure('public.discard_invoice_draft(uuid,uuid)') IS NOT NULL
           AND to_regprocedure('public.invoice_render_input(uuid,uuid)') IS NOT NULL
           AND to_regprocedure('public.issue_invoice(uuid,uuid,integer,text,jsonb,text,text)') IS NOT NULL
           AND to_regprocedure('public.void_invoice(uuid,uuid,text)') IS NOT NULL,
         'all 049 functions present'
  UNION ALL
  SELECT 'no_public_access',
         NOT has_table_privilege('anon', 'public.invoices', 'SELECT')
           AND NOT has_table_privilege('authenticated', 'public.invoices', 'SELECT')
           AND NOT has_table_privilege('anon', 'public.invoice_counters', 'SELECT')
           AND NOT has_table_privilege('authenticated', 'public.invoice_counters', 'SELECT')
           AND NOT EXISTS (
             SELECT 1 FROM pg_proc p, unnest(ARRAY['anon', 'authenticated']) r
             WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname IN ('upsert_completed_job_billing', 'set_no_invoice_required', 'create_invoice_draft',
                                 'update_invoice_draft', 'discard_invoice_draft', 'invoice_render_input',
                                 'issue_invoice', 'void_invoice', 'invoice_render_snapshot', 'invoice_guard')
               AND has_function_privilege(r, p.oid, 'EXECUTE')),
         'service role only'
  UNION ALL
  SELECT 'no_invoices_yet', true,
         (SELECT count(*) FROM invoices)::text || ' invoice(s)'
)
SELECT check_name, ok, detail FROM checks;
