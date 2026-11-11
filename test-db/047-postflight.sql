-- READ-ONLY postflight for migrations/047_atomic_future_edit.sql.
-- Run in the Supabase SQL Editor AFTER applying 047 and BEFORE deploying the
-- app. A single SELECT: it changes nothing. Every row must say ok = true.
WITH f AS (
  SELECT p.oid, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) AS result
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.apply_future_edit(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb)')
),
checks(check_name, ok, detail) AS (
  SELECT 'function_present', EXISTS (SELECT 1 FROM f), 'apply_future_edit(uuid, uuid, timestamptz, jsonb x5)'
  UNION ALL
  SELECT 'returns_jsonb', coalesce((SELECT result = 'jsonb' FROM f), false), 'returns jsonb'
  UNION ALL
  SELECT 'security_invoker', coalesce((SELECT NOT prosecdef FROM f), false), 'SECURITY INVOKER (not DEFINER)'
  UNION ALL
  SELECT 'search_path_pinned', coalesce((SELECT 'search_path=public' = ANY (proconfig) FROM f), false), 'SET search_path = public'
  UNION ALL
  SELECT 'anon_cannot_execute', coalesce((SELECT NOT has_function_privilege('anon', oid, 'EXECUTE') FROM f), false), 'anon: no EXECUTE'
  UNION ALL
  SELECT 'authenticated_cannot_execute', coalesce((SELECT NOT has_function_privilege('authenticated', oid, 'EXECUTE') FROM f), false), 'authenticated: no EXECUTE'
  UNION ALL
  SELECT 'service_role_can_execute', coalesce((SELECT has_function_privilege('service_role', oid, 'EXECUTE') FROM f), false), 'service_role: EXECUTE'
)
SELECT check_name, ok, detail FROM checks;
