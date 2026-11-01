-- READ-ONLY PREFLIGHT for migration 043 (guest control permissions).
-- Run in the Supabase SQL Editor BEFORE applying 043. A single SELECT over
-- system catalogs: it cannot write, create, or delete anything, and reads no
-- business data. Send back the one result row.
--
-- VERDICT = READY means production is exactly at migration 042 for these
-- functions: demo_session_apply has 042's body (whitespace-insensitive),
-- signature, SECURITY INVOKER, search_path, and service_role-only EXECUTE;
-- there is a single demo_session_apply; and demo_session_find_op (added by
-- 043) does not exist yet. Anything else: stop.
WITH fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5,
         p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('demo_session_apply', 'demo_session_find_op')
),
checks AS (
  SELECT
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('demo_sessions', 'demo_session_ops')) AS tables_present,
    (SELECT count(*) FROM fn WHERE proname = 'demo_session_apply') AS apply_functions,
    (SELECT count(*) FROM fn WHERE proname = 'demo_session_apply'
       AND args = 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_gen bigint, p_base_version bigint, p_op_id uuid, p_new_state jsonb, p_response_status integer, p_response jsonb'
       AND body_md5 = 'ad9e00ca51cb20500f56ffbaf1dfc213'
       AND NOT prosecdef AND proconfig = ARRAY['search_path=public']) AS apply_is_042,
    (SELECT count(*) FROM fn WHERE proname = 'demo_session_apply' AND (
       has_function_privilege('anon', fn.oid, 'EXECUTE') OR has_function_privilege('authenticated', fn.oid, 'EXECUTE')
       OR proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(fn.proacl) a WHERE a.grantee = 0))) AS apply_exposed,
    (SELECT count(*) FROM fn WHERE proname = 'demo_session_find_op') AS find_op_present
)
SELECT
  CASE WHEN tables_present = 2 AND apply_functions = 1 AND apply_is_042 = 1
            AND apply_exposed = 0 AND find_op_present = 0
       THEN 'READY' ELSE 'STOP' END AS verdict,
  *
FROM checks;
