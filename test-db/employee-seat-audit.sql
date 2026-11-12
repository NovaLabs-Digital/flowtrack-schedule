-- READ-ONLY audit before the employee-seat rollout (migrations/048).
-- Run ONCE in the Supabase SQL Editor. A single SELECT: it changes nothing.
-- Counts only -- no workspace names, employee names or contact details.
--
-- "Active employees" = employees.active = true AND is_demo = false (the rule
-- 048 enforces). The owner is not an employee row and is never counted.
-- Workspaces above 5 keep an allowance equal to their headcount at rollout.
--
-- metric                              meaning
--   workspaces_with_employees         workspaces that have at least one employee row
--   workspaces_over_5_active          workspaces 048 will grandfather (allowance = headcount)
--   over_5_by_size                    how many of those have 6 / 7 / 8 / 9 / 10+ active
--   largest_active_team               the biggest active headcount
--   workspaces_at_exactly_5           will be full immediately after rollout
--   inactive_employees_total          inactive rows (never use a seat)
--   current_acs_active / old_acs_active  Alberto's own two workspaces (3c7d1b2b / c6053b32)
--   possible_owner_as_employee        workspaces where an ACTIVE employee's email equals the
--                                     workspace owner's sign-in email. A HINT only: employee
--                                     email is optional and editable, so this can miss owner
--                                     rows and cannot prove one. Such a row uses a seat under 048.
WITH counts AS (
  SELECT workspace_id,
         count(*) FILTER (WHERE active AND NOT is_demo) AS active_n,
         count(*) FILTER (WHERE NOT active AND NOT is_demo) AS inactive_n
  FROM employees
  GROUP BY workspace_id
)
SELECT 'workspaces_with_employees' AS metric, count(*)::text AS value FROM counts WHERE active_n + inactive_n > 0
UNION ALL
SELECT 'workspaces_over_5_active', count(*)::text FROM counts WHERE active_n > 5
UNION ALL
SELECT 'over_5_by_size',
       coalesce(string_agg(bucket || ': ' || n, ', ' ORDER BY ord), 'none')
FROM (
  SELECT CASE WHEN active_n >= 10 THEN '10+' ELSE active_n::text END AS bucket,
         CASE WHEN active_n >= 10 THEN 10 ELSE active_n END AS ord, count(*) AS n
  FROM counts WHERE active_n > 5 GROUP BY 1, 2
) b
UNION ALL
SELECT 'largest_active_team', coalesce(max(active_n), 0)::text FROM counts
UNION ALL
SELECT 'workspaces_at_exactly_5', count(*)::text FROM counts WHERE active_n = 5
UNION ALL
SELECT 'inactive_employees_total', coalesce(sum(inactive_n), 0)::text FROM counts
UNION ALL
SELECT 'current_acs_active', coalesce((SELECT active_n FROM counts WHERE workspace_id = '3c7d1b2b-9d99-4eb5-80d3-5072ecd56d7a'), 0)::text
UNION ALL
SELECT 'old_acs_active', coalesce((SELECT active_n FROM counts WHERE left(workspace_id::text, 8) = 'c6053b32'), 0)::text
UNION ALL
SELECT 'possible_owner_as_employee', count(DISTINCT e.workspace_id)::text
FROM employees e
JOIN workspace_memberships m ON m.workspace_id = e.workspace_id AND m.role = 'owner'
JOIN profiles p ON p.id = m.profile_id
WHERE e.active AND NOT e.is_demo AND e.email IS NOT NULL AND lower(e.email) = lower(p.email);
