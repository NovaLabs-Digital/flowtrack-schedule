-- READ-ONLY postflight for migrations/048_employee_seat_allowance.sql.
-- Run in the Supabase SQL Editor AFTER applying 048 and BEFORE deploying the
-- app. A single SELECT: it changes nothing. Every row must say ok = true.
WITH f AS (
  SELECT p.proname, p.prosecdef, p.proconfig, p.oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname IN ('is_workspace_owner', 'employee_uses_seat', 'enforce_employee_seat_allowance', 'employee_seat_usage')
),
checks(check_name, ok, detail) AS (
  SELECT 'seat_column',
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'employee_seat_allowance'
                   AND is_nullable = 'NO' AND column_default = '5'),
         'workspaces.employee_seat_allowance integer NOT NULL DEFAULT 5'
  UNION ALL
  SELECT 'seat_range_check', EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_employee_seat_allowance_range'),
         'allowance between 0 and 1000'
  UNION ALL
  SELECT 'every_workspace_has_room', NOT EXISTS (
           SELECT 1 FROM workspaces w
           WHERE w.employee_seat_allowance < (SELECT count(*) FROM employees e WHERE e.workspace_id = w.id AND e.active AND NOT e.is_demo)),
         'no workspace starts above its allowance (rollout kept every team above 5)'
  UNION ALL
  SELECT 'owner_link_column', EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'employees' AND column_name = 'owner_profile_id'),
         'employees.owner_profile_id'
  UNION ALL
  SELECT 'nothing_auto_linked', NOT EXISTS (SELECT 1 FROM employees WHERE owner_profile_id IS NOT NULL),
         'no record was linked by the migration (owners link themselves)'
  UNION ALL
  SELECT 'one_link_per_workspace_index', to_regclass('public.idx_employees_one_owner_link_per_workspace') IS NOT NULL,
         'unique index: at most one owner record per workspace'
  UNION ALL
  SELECT 'trigger_enabled', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employees_seat_allowance' AND tgenabled = 'O'),
         'employees_seat_allowance trigger present and enabled'
  UNION ALL
  SELECT 'functions_present', (SELECT count(*) = 4 FROM f), '4 functions'
  UNION ALL
  SELECT 'functions_security_invoker', NOT EXISTS (SELECT 1 FROM f WHERE prosecdef), 'none is SECURITY DEFINER'
  UNION ALL
  SELECT 'functions_search_path_pinned', NOT EXISTS (SELECT 1 FROM f WHERE NOT ('search_path=public' = ANY (coalesce(proconfig, '{}')))),
         'SET search_path = public on all'
  UNION ALL
  SELECT 'seat_usage_server_only',
         has_function_privilege('service_role', 'public.employee_seat_usage(uuid)', 'EXECUTE')
           AND NOT has_function_privilege('anon', 'public.employee_seat_usage(uuid)', 'EXECUTE')
           AND NOT has_function_privilege('authenticated', 'public.employee_seat_usage(uuid)', 'EXECUTE'),
         'employee_seat_usage: service_role only'
  UNION ALL
  SELECT 'workspaces_with_raised_allowance', true,
         (SELECT count(*) FROM workspaces WHERE employee_seat_allowance <> 5)::text || ' workspace(s) not at the default 5'
)
SELECT check_name, ok, detail FROM checks;
