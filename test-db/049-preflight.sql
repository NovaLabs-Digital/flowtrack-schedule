-- READ-ONLY preflight for migrations/049_invoices.sql.
-- Run in the Supabase SQL Editor BEFORE applying 049. A single SELECT: it
-- changes nothing. Every row must say ok = true before 049 is applied.
-- Counts only -- no client names, amounts or invoice numbers are shown.
--
-- check                           what it proves
--   migration_048_applied         the previous migration is in place
--   billing_shape                 completed_job_billing has the 032-034 columns, client_id NOT NULL
--   billing_function_033          upsert_completed_job_billing(uuid,uuid,uuid,text,boolean,text) exists
--   appointment_pair_key          appointments(id, workspace_id) unique key exists (for the invoice FK)
--   roles                         anon, authenticated, service_role exist (for the grants)
--   not_applied_yet               completed_job_billing.no_invoice_required absent (if false: run 049-postflight.sql)
--   no_name_conflicts             none of 049's tables / functions / trigger exist already
--   payment_methods_known         every saved payment method is one 049 still allows
--   no_sft_numbers_in_use         no saved invoice number starts with "SFT" (that prefix becomes reserved)
--   backfill_cash_closed_jobs     informational: jobs that will be marked "Paid directly, no invoice"
--                                 (paid + Cash + no invoice number -- closed under today's rule)
--   paid_other_without_number     informational: paid with another method and no number; these show
--                                 "Needs invoice number" today and still will (not changed by 049)
WITH checks(check_name, ok, detail) AS (
  SELECT 'migration_048_applied',
         to_regprocedure('public.employee_seat_usage(uuid)') IS NOT NULL,
         'employee_seat_usage() present'
  UNION ALL
  SELECT 'billing_shape',
         (SELECT count(*) = 5 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'completed_job_billing'
             AND column_name IN ('appointment_id', 'client_id', 'invoice_number', 'paid', 'payment_method'))
           AND EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = 'public' AND table_name = 'completed_job_billing'
                         AND column_name = 'client_id' AND is_nullable = 'NO'),
         'appointment_id, client_id (NOT NULL), invoice_number, paid, payment_method'
  UNION ALL
  SELECT 'billing_function_033',
         to_regprocedure('public.upsert_completed_job_billing(uuid,uuid,uuid,text,boolean,text)') IS NOT NULL,
         'upsert_completed_job_billing present with the 033 signature'
  UNION ALL
  SELECT 'appointment_pair_key',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_id_workspace_id_key'),
         'appointments_id_workspace_id_key present'
  UNION ALL
  SELECT 'roles',
         (SELECT count(*) = 3 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')),
         'anon, authenticated, service_role'
  UNION ALL
  SELECT 'not_applied_yet',
         NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'completed_job_billing'
                       AND column_name = 'no_invoice_required'),
         'completed_job_billing.no_invoice_required not yet present'
  UNION ALL
  SELECT 'no_name_conflicts',
         to_regclass('public.invoices') IS NULL AND to_regclass('public.invoice_counters') IS NULL
           AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname IN (
                 'invoice_guard', 'invoice_render_snapshot', 'invoice_render_input', 'invoice_draft_tax_rate', 'set_no_invoice_required',
                 'create_invoice_draft', 'update_invoice_draft', 'discard_invoice_draft', 'issue_invoice', 'void_invoice'))
           AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_guard'),
         'no existing 049 tables, functions or trigger'
  UNION ALL
  SELECT 'payment_methods_known',
         NOT EXISTS (SELECT 1 FROM completed_job_billing
                     WHERE payment_method IS NOT NULL
                       AND payment_method NOT IN ('zelle', 'venmo', 'check', 'cash', 'quickbooks_card', 'other')),
         'every saved payment method is allowed after 049'
  UNION ALL
  SELECT 'no_sft_numbers_in_use',
         NOT EXISTS (SELECT 1 FROM completed_job_billing WHERE upper(btrim(invoice_number)) LIKE 'SFT%'),
         (SELECT count(*) FROM completed_job_billing WHERE upper(btrim(invoice_number)) LIKE 'SFT%')::text
           || ' saved invoice number(s) start with SFT'
  UNION ALL
  SELECT 'backfill_cash_closed_jobs', true,
         (SELECT count(*) FROM completed_job_billing
           WHERE paid = true AND payment_method = 'cash' AND invoice_number IS NULL)::text
           || ' job(s) in '
           || (SELECT count(DISTINCT workspace_id) FROM completed_job_billing
                WHERE paid = true AND payment_method = 'cash' AND invoice_number IS NULL)::text
           || ' workspace(s) will be marked Paid directly, no invoice'
  UNION ALL
  SELECT 'paid_other_without_number', true,
         (SELECT count(*) FROM completed_job_billing
           WHERE paid = true AND payment_method IS DISTINCT FROM 'cash' AND invoice_number IS NULL)::text
           || ' job(s) paid by another method with no number (unchanged: still Needs invoice number)'
)
SELECT check_name, ok, detail FROM checks;
