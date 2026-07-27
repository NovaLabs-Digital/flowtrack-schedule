-- ============================================================================
-- Migration 018 preflight — READ-ONLY. Every statement below is a SELECT.
-- Nothing here creates, alters, or deletes anything. Confirms the verified
-- production shape of `profiles` before applying migration 018 (which, for
-- the first time, inserts into it) -- do not run migration 018 until this
-- has been run and reviewed.
--
-- Exposes no password hashes, tokens, secrets, or email addresses -- every
-- query below returns only table/column/constraint metadata.
-- ============================================================================


-- 1. profiles columns (types, nullability, defaults) -- --
-- migration 018 inserts only (id, email). This confirms both exist with a
-- compatible shape, and surfaces every other column so any additional
-- NOT NULL / no-default column is visible before relying on the query
-- in section 4 below to formally rule that out.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;


-- 2. Primary key on profiles.id -- --
select tc.constraint_name, tc.constraint_type,
       string_agg(kcu.column_name, ', ' order by kcu.ordinal_position) as columns
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
 and tc.table_schema = kcu.table_schema
where tc.table_schema = 'public' and tc.table_name = 'profiles'
group by tc.constraint_name, tc.constraint_type
order by tc.constraint_type, tc.constraint_name;


-- 3. Foreign key from profiles.id to auth.users.id, and its delete rule -- --
-- Confirms the exact reference and ON DELETE behavior the production
-- schema verification reported (ON DELETE CASCADE).
select
  tc.constraint_name,
  kcu.column_name as fk_column,
  ccu.table_schema as referenced_schema,
  ccu.table_name as referenced_table,
  ccu.column_name as referenced_column,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name
join information_schema.referential_constraints rc
  on tc.constraint_name = rc.constraint_name and tc.table_schema = rc.constraint_schema
where tc.table_schema = 'public'
  and tc.table_name = 'profiles'
  and tc.constraint_type = 'FOREIGN KEY';


-- 4. Any NOT NULL column with no default on profiles, other than id/email -- --
-- provision_owner_workspace (migration 018) inserts only (id, email).
-- Any other NOT NULL column with no default would make every provisioning
-- insert fail. Expected result: zero rows.
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and is_nullable = 'NO'
  and column_default is null
  and column_name not in ('id', 'email');


-- 5. Every foreign key defined ON workspace_memberships -- --
-- Confirms the exact constraint production's error named
-- (workspace_memberships_profile_id_fkey -> profiles.id), and rules out
-- any OTHER foreign key on this table that migration 018's insert order
-- would also need to satisfy.
select
  tc.constraint_name,
  kcu.column_name as fk_column,
  ccu.table_schema as referenced_schema,
  ccu.table_name as referenced_table,
  ccu.column_name as referenced_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name
where tc.table_schema = 'public'
  and tc.table_name = 'workspace_memberships'
  and tc.constraint_type = 'FOREIGN KEY';


-- 6. Existing profiles row count, and whether one already exists for any
--    current owner membership -- --
-- Counts only, no email or other identifying column -- confirms whether
-- any profiles rows already exist (e.g. from a prior, differently-sourced
-- mechanism) that ON CONFLICT (id) DO NOTHING must not disturb.
select count(*) as total_profiles_rows from profiles;

select count(*) as owner_memberships_without_a_profiles_row
from workspace_memberships wm
where wm.role = 'owner'
  and not exists (select 1 from profiles p where p.id = wm.profile_id);


-- 7. Summary check -- would migration 018 fail or leave a gap? -- --
--   - Query 1 shows id/email exist with a compatible shape?
--   - Query 4 returned zero rows?                    (no unexpected NOT NULL column)
--   - Query 5 shows exactly one FK on workspace_memberships,
--     to profiles.id?                                (matches the production error)
--   - Query 6's second SELECT: for the one existing owner membership
--     already confirmed in production (count = 1), does it show 1
--     (confirming that membership's profiles row is STILL missing, exactly
--     as production reported) or 0 (meaning something already fixed it
--     out of band)? Either way, migration 018 itself only affects FUTURE
--     provision_owner_workspace calls -- it does not touch this existing
--     row (see Phase 5.7D-R9's report: no manual production fix is made
--     in this phase).
-- If every answer above is "yes" / "as expected," migration 018 is safe to
-- apply as written.
