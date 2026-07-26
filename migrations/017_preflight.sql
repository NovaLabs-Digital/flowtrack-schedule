-- ============================================================================
-- Migration 017 preflight — READ-ONLY. Every statement below is a SELECT.
-- Nothing here creates, alters, or deletes anything. Do not run migration
-- 017 itself until this has been run and reviewed (per the caveat at the
-- top of migrations/017_add_signup_and_owner_mfa.sql and the same discipline
-- established in docs/CONTROLLED_CUSTOMER_ONBOARDING.md §0).
--
-- Exposes no password hashes, tokens, secrets, or email addresses. Every
-- query below returns only: table/column/constraint/function metadata,
-- row counts, and non-identifying UUIDs (profile_id/workspace_id — internal
-- surrogate keys, not personal information on their own).
--
-- Run this as one script (or statement by statement) against production
-- with a read-only/service-role connection. Review every result before
-- approving migration 017.
-- ============================================================================


-- 1. Existing workspace_memberships columns (types, nullability, defaults) --
-- migration 017 adds terms_accepted_at, terms_version, session_epoch via
-- ADD COLUMN IF NOT EXISTS -- this confirms none of the three already exist
-- with an incompatible type, and shows every column migration 017's ALTER
-- TABLE will run against.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'workspace_memberships'
order by ordinal_position;


-- 2. Existing constraints on workspace_memberships --
-- migration 017 conditionally adds a UNIQUE (profile_id, role) constraint,
-- guarded by an information_schema check for this exact column pair. This
-- shows every constraint that already exists, so the guard's behavior
-- (add vs. safe no-op) is predictable before running.
select tc.constraint_name, tc.constraint_type,
       string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as columns
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
 and tc.table_schema = kcu.table_schema
where tc.table_schema = 'public' and tc.table_name = 'workspace_memberships'
group by tc.constraint_name, tc.constraint_type
order by tc.constraint_type, tc.constraint_name;


-- 3. Existing indexes on workspace_memberships --
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'workspace_memberships'
order by indexname;


-- 4. Duplicate (profile_id, role) rows -- --
-- If this returns any rows, the conditional UNIQUE (profile_id, role)
-- constraint in migration 017 will FAIL to add (Postgres cannot create a
-- unique constraint over duplicate data). Zero rows expected.
select profile_id, role, count(*) as row_count
from workspace_memberships
group by profile_id, role
having count(*) > 1
order by row_count desc;


-- 5. Existing owner memberships per Auth identity -- --
-- Counts only (no email, no other column) -- confirms how many distinct
-- Auth identities currently hold an 'owner' membership, and flags (via the
-- having clause) any identity that somehow already holds more than one --
-- which provision_owner_workspace's "return existing workspace if found"
-- guard assumes cannot happen.
select profile_id, count(*) as owner_membership_count
from workspace_memberships
where role = 'owner'
group by profile_id
having count(*) > 1;

select count(*) as total_owner_memberships
from workspace_memberships
where role = 'owner';


-- 6. Required workspaces / company_settings / subscriptions columns -- --
-- provision_owner_workspace (migration 017) inserts into all three tables
-- with a fixed column list. This confirms every column it writes to
-- actually exists with a compatible/nullable shape, and surfaces any OTHER
-- NOT NULL column without a default that the function does not supply --
-- which would make every insert fail.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('workspaces', 'company_settings', 'subscriptions')
order by table_name, ordinal_position;

-- Any NOT NULL column with no default, on these three tables, that is NOT
-- one of the columns provision_owner_workspace explicitly supplies --
-- (workspaces.id/name; company_settings.workspace_id/company_name/
-- booking_enabled/notifications_enabled; subscriptions.workspace_id/
-- billing_mode) -- would cause every provisioning insert to fail. Expected
-- result: zero rows.
--
-- Phase 5.7D-R5 correction: workspaces.name was added to the allowed list
-- below after the production preflight confirmed it is `text NOT NULL`
-- with no default -- provision_owner_workspace now explicitly supplies it
-- from the pending signup's company name (see
-- migrations/017_add_signup_and_owner_mfa.sql), so it is no longer an
-- unaccounted-for column. Before this correction, this query would have
-- (correctly) flagged workspaces.name as a conflict; after it, this query
-- returns zero rows against the verified production schema.
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and is_nullable = 'NO'
  and column_default is null
  and (
    (table_name = 'workspaces' and column_name not in ('id', 'name'))
    or (table_name = 'company_settings' and column_name not in
        ('workspace_id', 'company_name', 'booking_enabled', 'notifications_enabled'))
    or (table_name = 'subscriptions' and column_name not in
        ('workspace_id', 'billing_mode'))
  );


-- 7. Conflicting object names -- tables -- --
-- migration 017 creates pending_signups, pending_mfa_challenges, and
-- rate_limit_counters with CREATE TABLE IF NOT EXISTS. If any of these
-- names already exists as something else (a view, a table with an
-- incompatible shape), the migration will either silently no-op against
-- the wrong object or fail outright -- either way this must be reviewed
-- before running.
select table_name, table_type
from information_schema.tables
where table_schema = 'public'
  and table_name in ('pending_signups', 'pending_mfa_challenges', 'rate_limit_counters');

-- If any of the three exist as tables already, show their current columns
-- for comparison against migrations/017_add_signup_and_owner_mfa.sql's
-- CREATE TABLE definitions.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('pending_signups', 'pending_mfa_challenges', 'rate_limit_counters')
order by table_name, ordinal_position;


-- 8. Conflicting object names -- functions -- --
-- migration 017 creates/replaces provision_owner_workspace,
-- record_rate_limit_attempt, and clear_rate_limit via CREATE OR REPLACE
-- FUNCTION. CREATE OR REPLACE silently overwrites an existing function of
-- the same name and argument signature -- if any of these names already
-- exists with DIFFERENT logic (e.g. from a hand-run hotfix, or a name
-- collision with something unrelated), running migration 017 will
-- silently destroy that existing definition. Review any result below
-- before proceeding.
select p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as is_security_definer,
       l.lanname as language
from pg_proc p
join pg_namespace n on p.pronamespace = n.oid
join pg_language l on p.prolang = l.oid
where n.nspname = 'public'
  and p.proname in ('provision_owner_workspace', 'record_rate_limit_attempt', 'clear_rate_limit');


-- 9. Current RLS state -- --
-- Confirms current RLS status on every table migration 017 touches (two
-- new tables it will enable RLS on, plus workspace_memberships which it
-- only ALTERs, never toggles RLS on). Migration 017 does not add any
-- policy to any table -- deny-all-by-default for anon/authenticated is
-- expected and matches every other table in this schema (migration 014).
select relname as table_name, relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('workspace_memberships', 'workspaces', 'company_settings',
                  'subscriptions', 'pending_signups', 'pending_mfa_challenges',
                  'rate_limit_counters')
order by relname;

-- Existing policies on any of these tables (expected: none, on any of them
-- -- this schema uses service-role-only access with zero RLS policies
-- throughout, per docs/SECURITY.md).
select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('workspace_memberships', 'workspaces', 'company_settings',
                     'subscriptions', 'pending_signups', 'pending_mfa_challenges',
                     'rate_limit_counters');


-- 10. Summary check -- would migration 017 fail outright? -- --
-- A quick manual checklist to read off the results above before approving:
--   - Query 4 returned zero rows?                        (duplicate profile_id/role)
--   - Query 6's second SELECT returned zero rows?         (unexpected NOT NULL column)
--   - Query 7 returned no existing pending_signups /
--     pending_mfa_challenges / rate_limit_counters?       (name collision)
--   - Query 8 returned no existing function with these
--     three names, OR any existing one is confirmed safe
--     to overwrite?                                       (function collision)
--   - Query 9's policy check returned zero rows?          (unexpected existing policy)
-- If every answer above is "yes" / "as expected," migration 017 is safe to
-- apply as written. If any answer is "no," STOP and resolve the specific
-- conflict before running the migration.
