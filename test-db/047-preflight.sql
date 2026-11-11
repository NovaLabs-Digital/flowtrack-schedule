-- READ-ONLY preflight for migrations/047_atomic_future_edit.sql.
-- Run in the Supabase SQL Editor BEFORE applying 047. A single SELECT: it
-- changes nothing. Every row must say ok = true before 047 is applied.
--
-- check                                  what it proves
--   migration_046_applied                the latest applied migration (046 session chat) is present
--   migration_045_applied                045 owner sign-in security is present
--   fn_sync_appointment_assignments      047 calls it (027a), exact signature
--   fn_activate_recurring_series         047 calls it (027a), exact signature
--   reminder_claim_columns               appointments has the reminder flags 047 clears (035/036)
--   recurring_series_columns             columns 047 reads/writes
--   roles                                anon, authenticated, service_role exist (for the grants)
--   apply_future_edit_absent             047 not applied yet (true = not yet present; if false,
--                                        run test-db/047-postflight.sql instead)
WITH checks(check_name, ok, detail) AS (
  SELECT 'migration_046_applied',
         to_regclass('public.demo_session_messages') IS NOT NULL
           AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'demo_session_post_message'),
         'demo_session_messages table + demo_session_post_message()'
  UNION ALL
  SELECT 'migration_045_applied',
         to_regclass('public.owner_security') IS NOT NULL AND to_regclass('public.owner_recovery_codes') IS NOT NULL,
         'owner_security + owner_recovery_codes tables'
  UNION ALL
  SELECT 'fn_sync_appointment_assignments',
         to_regprocedure('public.sync_appointment_assignments(uuid,uuid,uuid[],uuid[])') IS NOT NULL,
         'sync_appointment_assignments(uuid, uuid, uuid[], uuid[]) returns text'
  UNION ALL
  SELECT 'fn_activate_recurring_series',
         to_regprocedure('public.activate_recurring_series(uuid,uuid,uuid,uuid,text,integer,integer,text,text,timestamptz,uuid[],text)') IS NOT NULL,
         'activate_recurring_series(12 args) returns text'
  UNION ALL
  SELECT 'reminder_claim_columns',
         (SELECT count(*) = 3 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'appointments'
             AND column_name IN ('reminder_24h_sent_at', 'reminder_24h_claimed_at', 'reminder_24h_claim_token')),
         'appointments.reminder_24h_sent_at / _claimed_at / _claim_token'
  UNION ALL
  SELECT 'recurring_series_columns',
         (SELECT count(*) = 5 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'recurring_series'
             AND column_name IN ('id', 'workspace_id', 'status', 'client_id', 'updated_at')),
         'recurring_series id, workspace_id, status, client_id, updated_at'
  UNION ALL
  SELECT 'roles',
         (SELECT count(*) = 3 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')),
         'anon, authenticated, service_role'
  UNION ALL
  SELECT 'apply_future_edit_absent',
         to_regprocedure('public.apply_future_edit(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb)') IS NULL,
         'not yet applied'
)
SELECT check_name, ok, detail FROM checks;
