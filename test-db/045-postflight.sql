-- READ-ONLY POSTFLIGHT for migration 045 (optional two-step sign-in and
-- recovery codes). Run in the Supabase SQL Editor AFTER applying 045. A
-- single SELECT over system catalogs: it cannot write, create, or delete
-- anything, and reads no business data. Send back the one result row.
--
-- VERDICT = MATCH means 045 was applied exactly as written:
--   * owner_security and owner_recovery_codes exist with the right columns,
--     row-level security on, a unique (auth_user_id, code_hash), and no
--     access at all for anon or authenticated;
--   * pending_mfa_challenges gained purpose / enrolled / recovered with
--     their defaults and the purpose check;
--   * the five new functions have 045's bodies and signatures, are SECURITY
--     INVOKER with search_path = public, and only service_role may EXECUTE
--     them (not PUBLIC, anon, or authenticated);
--   * migration 044's functions are unchanged (17 Guided Demo Session
--     functions).
WITH expected_fn(proname, args, body_md5) AS (VALUES
    ('owner_security_state', 'p_user uuid', '602113832ef3cb9520f2058f7edd5d74'),
    ('owner_security_lock', 'p_user uuid, p_holder text, p_seconds integer', '7149f4ad5feeaa4c438545f1c8236884'),
    ('owner_security_unlock', 'p_user uuid, p_holder text', '9983b289e3e9447b96a40edef6d757f4'),
    ('owner_security_finish', 'p_user uuid, p_holder text, p_required boolean, p_code_hashes text[]', '022ccd2e8cd20241e42bb889f373db93'),
    ('owner_use_recovery_code', 'p_user uuid, p_code_hash text', 'de04e1f806df8f7d9e333914f7031465')
),
fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5,
         p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.proname LIKE 'owner\_security%' OR p.proname = 'owner_use_recovery_code')
),
checks AS (
  SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
       AND (table_name, column_name, data_type, is_nullable) IN (
         ('owner_security', 'auth_user_id', 'uuid', 'NO'),
         ('owner_security', 'two_factor_required', 'boolean', 'NO'),
         ('owner_security', 'lock_holder', 'text', 'YES'),
         ('owner_security', 'lock_expires_at', 'timestamp with time zone', 'YES'),
         ('owner_security', 'updated_at', 'timestamp with time zone', 'NO'),
         ('owner_recovery_codes', 'id', 'bigint', 'NO'),
         ('owner_recovery_codes', 'auth_user_id', 'uuid', 'NO'),
         ('owner_recovery_codes', 'code_hash', 'text', 'NO'),
         ('owner_recovery_codes', 'created_at', 'timestamp with time zone', 'NO'),
         ('owner_recovery_codes', 'used_at', 'timestamp with time zone', 'YES'))) AS new_table_columns_ok,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('owner_security', 'owner_recovery_codes') AND c.relrowsecurity) AS tables_with_rls,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('owner_security', 'owner_recovery_codes')
        AND (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
             OR has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))) AS tables_exposed,
    (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.owner_recovery_codes'::regclass AND contype = 'u') AS recovery_code_unique,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'pending_mfa_challenges'
       AND (column_name, data_type, is_nullable) IN (('purpose', 'text', 'NO'), ('enrolled', 'boolean', 'NO'), ('recovered', 'boolean', 'NO'))) AS pending_columns_ok,
    (SELECT count(*) FROM pg_constraint WHERE conname = 'pending_mfa_challenges_purpose_check' AND contype = 'c') AS pending_purpose_check,
    (SELECT count(*) FROM fn) AS functions_present,
    (SELECT count(*) FROM fn JOIN expected_fn e USING (proname, args, body_md5)) AS functions_body_match,
    (SELECT string_agg(e.proname, ', ' ORDER BY e.proname) FROM expected_fn e
       WHERE NOT EXISTS (SELECT 1 FROM fn WHERE fn.proname = e.proname AND fn.args = e.args AND fn.body_md5 = e.body_md5)) AS mismatched_functions,
    (SELECT count(*) FROM fn WHERE NOT prosecdef AND proconfig = ARRAY['search_path=public']) AS invoker_search_path,
    (SELECT count(*) FROM fn WHERE
       has_function_privilege('anon', fn.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', fn.oid, 'EXECUTE')
       OR proacl IS NULL
       OR EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0)) AS functions_exposed,
    (SELECT count(*) FROM fn WHERE has_function_privilege('service_role', fn.oid, 'EXECUTE')) AS functions_service_role_ok,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'demo\_session%') AS session_functions,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND (p.proname, md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g'))) IN (
        ('demo_session_view', '3ebc91e0dfa3aa2fdebe33fb1c219507'),
        ('demo_session_close', '4eb46ada41412672fa14b0c8397d423b'),
        ('demo_session_put_view', 'bd5a92bb0914b8f5d98dea42350fb695'),
        ('demo_session_sync_cursor', '36d701badb3ef4043e5685736998cabf'))) AS functions_at_044
)
SELECT
  CASE WHEN new_table_columns_ok = 10 AND tables_with_rls = 2 AND tables_exposed = 0 AND recovery_code_unique = 1
            AND pending_columns_ok = 3 AND pending_purpose_check = 1
            AND functions_present = 5 AND functions_body_match = 5 AND mismatched_functions IS NULL
            AND invoker_search_path = 5 AND functions_exposed = 0 AND functions_service_role_ok = 5
            AND session_functions = 17 AND functions_at_044 = 4
       THEN 'MATCH' ELSE 'STOP' END AS verdict,
  *
FROM checks;
