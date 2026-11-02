-- READ-ONLY PREFLIGHT for migration 045 (optional two-step sign-in and
-- recovery codes). Run in the Supabase SQL Editor BEFORE applying 045. A
-- single SELECT over system catalogs: it cannot write, create, or delete
-- anything, and reads no business data. Send back the one result row.
--
-- VERDICT = READY means production is exactly where 045 expects it:
--   * migration 044 is in place (the four functions it changed or added have
--     044's bodies; 17 Guided Demo Session functions);
--   * pending_mfa_challenges exists with its 9 original columns and none of
--     045's (purpose, enrolled, recovered);
--   * workspace_memberships has session_epoch and one owner membership per
--     identity (uq_workspace_memberships_profile_role);
--   * record_rate_limit_attempt exists (045's new limits use it);
--   * none of 045's tables or functions exist yet.
-- Anything else: stop.
WITH fn AS (
  SELECT p.proname, md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
),
checks AS (
  SELECT
    (SELECT count(*) FROM fn WHERE (proname, body_md5) IN (
       ('demo_session_view', '3ebc91e0dfa3aa2fdebe33fb1c219507'),
       ('demo_session_close', '4eb46ada41412672fa14b0c8397d423b'),
       ('demo_session_put_view', 'bd5a92bb0914b8f5d98dea42350fb695'),
       ('demo_session_sync_cursor', '36d701badb3ef4043e5685736998cabf'))) AS functions_at_044,
    (SELECT count(*) FROM fn WHERE proname LIKE 'demo\_session%') AS session_functions,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pending_mfa_challenges'
        AND column_name IN ('token', 'auth_user_id', 'factor_id', 'supabase_access_token', 'supabase_refresh_token',
                            'attempt_count', 'created_at', 'expires_at', 'consumed_at')) AS pending_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pending_mfa_challenges'
        AND column_name IN ('purpose', 'enrolled', 'recovered')) AS new_pending_columns_present,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'workspace_memberships' AND column_name = 'session_epoch') AS session_epoch_present,
    (SELECT count(*) FROM pg_constraint
      WHERE conname = 'uq_workspace_memberships_profile_role' AND contype = 'u') AS one_owner_membership_per_identity,
    (SELECT count(*) FROM fn WHERE proname = 'record_rate_limit_attempt') AS rate_limit_function,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('owner_security', 'owner_recovery_codes')) AS new_tables_present,
    (SELECT count(*) FROM fn WHERE proname LIKE 'owner\_security%' OR proname = 'owner_use_recovery_code') AS new_functions_present
)
SELECT
  CASE WHEN functions_at_044 = 4 AND session_functions = 17 AND pending_columns = 9 AND new_pending_columns_present = 0
            AND session_epoch_present = 1 AND one_owner_membership_per_identity = 1 AND rate_limit_function >= 1
            AND new_tables_present = 0 AND new_functions_present = 0
       THEN 'READY' ELSE 'STOP' END AS verdict,
  *
FROM checks;
