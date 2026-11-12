-- READ-ONLY preflight for migrations/048_employee_seat_allowance.sql.
-- Run in the Supabase SQL Editor BEFORE applying 048. A single SELECT: it
-- changes nothing. Every row must say ok = true before 048 is applied.
--
-- check                              what it proves
--   migration_047_applied            the previous migration is in place
--   tables_present                   workspaces, employees, workspace_memberships, profiles
--   employee_columns                 employees.active / is_demo / workspace_id exist
--   roles                            anon, authenticated, service_role exist (for the grants)
--   seat_column_absent               048 not applied yet (if false: run 048-postflight.sql instead)
--   owner_link_column_absent         048 not applied yet
--   no_name_conflicts                none of 048's function / index / trigger names exist already
--   workspaces_over_5_active         informational count: these keep their headcount as allowance
WITH checks(check_name, ok, detail) AS (
  SELECT 'migration_047_applied',
         to_regprocedure('public.apply_future_edit(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb)') IS NOT NULL,
         'apply_future_edit() present'
  UNION ALL
  SELECT 'tables_present',
         to_regclass('public.workspaces') IS NOT NULL AND to_regclass('public.employees') IS NOT NULL
           AND to_regclass('public.workspace_memberships') IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL,
         'workspaces, employees, workspace_memberships, profiles'
  UNION ALL
  SELECT 'employee_columns',
         (SELECT count(*) = 3 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'employees' AND column_name IN ('active', 'is_demo', 'workspace_id')),
         'employees.active, is_demo, workspace_id'
  UNION ALL
  SELECT 'roles',
         (SELECT count(*) = 3 FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')),
         'anon, authenticated, service_role'
  UNION ALL
  SELECT 'seat_column_absent',
         NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'employee_seat_allowance'),
         'workspaces.employee_seat_allowance not yet present'
  UNION ALL
  SELECT 'owner_link_column_absent',
         NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'employees' AND column_name = 'owner_profile_id'),
         'employees.owner_profile_id not yet present'
  UNION ALL
  SELECT 'no_name_conflicts',
         NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('is_workspace_owner', 'employee_uses_seat', 'enforce_employee_seat_allowance', 'employee_seat_usage'))
           AND to_regclass('public.idx_employees_one_owner_link_per_workspace') IS NULL
           AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'employees_seat_allowance'),
         'no existing 048 functions, index or trigger'
  UNION ALL
  SELECT 'workspaces_over_5_active', true,
         (SELECT count(*) FROM (SELECT workspace_id FROM employees WHERE active AND NOT is_demo
                                GROUP BY workspace_id HAVING count(*) > 5) x)::text || ' workspace(s) will keep their headcount as allowance'
)
SELECT check_name, ok, detail FROM checks;
