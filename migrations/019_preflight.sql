-- ============================================================================
-- Migration 019 preflight — READ-ONLY. Every statement below is a SELECT.
-- Nothing here creates, alters, or deletes anything. Confirms the verified
-- production shape of `employees.email` and `idx_employees_email` before
-- applying migration 019 (which drops the global unique index and replaces
-- it with a workspace-scoped, case-insensitive one) -- do not run
-- migration 019 until this has been run and reviewed.
--
-- Exposes no password hashes, tokens, secrets, or actual email addresses --
-- every query below returns only table/column/index metadata and counts.
-- ============================================================================


-- 1. employees.email / employees.workspace_id columns (types, nullability) -- --
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'employees'
  and column_name in ('email', 'workspace_id', 'password_hash', 'active')
order by ordinal_position;


-- 2. Every index currently defined on employees -- --
-- Confirms idx_employees_email exists exactly as migration 008 created it
-- (global, no workspace_id, no LOWER()) before migration 019 drops it.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'employees'
order by indexname;


-- 3. Within-workspace duplicate normalized-email count -- --
-- The one precondition that would make migration 019's new unique index
-- (workspace_id, LOWER(email)) impossible to create as written. Expected
-- result: zero rows. Counts only -- no email value is returned.
select workspace_id, count(*) as duplicate_count
from employees
where email is not null
group by workspace_id, lower(email)
having count(*) > 1;


-- 4. Employees whose stored email is not already lowercase -- --
-- Confirms whether migration 019 needs a backfill UPDATE (it is written to
-- assume it does not). A count only -- no email value is returned.
select count(*) as non_lowercase_email_count
from employees
where email is not null and email <> lower(email);


-- 5. Cross-workspace normalized-email collision count -- --
-- Informational only (not a blocker either way -- this is the exact
-- scenario the migration exists to permit going forward). Counts distinct
-- normalized emails that currently appear in more than one workspace.
select count(*) as cross_workspace_shared_email_count
from (
  select lower(email) as norm_email
  from employees
  where email is not null
  group by lower(email)
  having count(distinct workspace_id) > 1
) t;


-- 6. Summary check -- would migration 019 fail? -- --
--   - Query 1 confirms email/workspace_id/password_hash/active exist with
--     the expected shape.
--   - Query 2 shows exactly one existing index on email
--     (idx_employees_email, global, no workspace scoping) -- confirms
--     there is exactly one index for migration 019 to replace.
--   - Query 3 returned zero rows?                 (no within-workspace
--     duplicate would block the new unique index)
--   - Query 4 returned 0?                          (no backfill needed;
--     if nonzero, migration 019 must be revised to add a backfill UPDATE
--     before creating the new index)
-- If every answer above is "yes" / "as expected," migration 019 is safe to
-- apply as written.
