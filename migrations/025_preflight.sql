-- ============================================================================
-- Migration 025 preflight — READ-ONLY. Every statement below is a SELECT.
-- Nothing here creates, alters, or deletes anything. Confirms the verified
-- production shape of `company_settings` before applying migration 025
-- (which adds a new, additive, nullable `timezone` column) -- do not run
-- migration 025 until this has been run and reviewed.
--
-- Exposes no password hashes, tokens, secrets, or client PII -- every query
-- below returns only table/column metadata, counts, and the owner-facing
-- business settings already visible on each workspace's own Settings page
-- (company name, booking/notification toggles, Business Hours).
-- ============================================================================


-- 1. Confirm company_settings exists, and see its full current column shape
--    -- business_hours should already be present (migration 024); timezone
--    should NOT yet be present (that absence is exactly what migration 025
--    is meant to fix). -- --
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'company_settings'
order by ordinal_position;


-- 2. Explicit collision check -- does company_settings.timezone already
--    exist? Expected result: zero rows. A nonzero result would mean this
--    column was already added by something else -- ADD COLUMN IF NOT
--    EXISTS would still be a safe no-op, but it should be understood before
--    proceeding, not assumed. -- --
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'company_settings' and column_name = 'timezone';


-- 3. Confirm business_hours specifically (migration 024's own column),
--    already relied upon by migration 025's own comments as "already
--    present." -- --
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'company_settings' and column_name = 'business_hours';


-- 4. Total company_settings row count. -- --
select count(*) as total_rows from company_settings;


-- 5. workspace_id integrity -- distinct count and NULL count. Counts only.
--    -- --
select count(distinct workspace_id) as distinct_workspace_ids,
       count(*) filter (where workspace_id is null) as null_workspace_id_count
from company_settings;


-- 6. Any workspace_id with more than one company_settings row (the
--    application assumes exactly one settings row per workspace). Expected
--    result: zero rows. -- --
select workspace_id, count(*) as row_count
from company_settings
where workspace_id is not null
group by workspace_id
having count(*) > 1;


-- 7. Every existing row's current company_name, booking_enabled,
--    notifications_enabled, and business_hours -- so each production
--    workspace's settings (including the real ACS business) can be visually
--    confirmed before and after migration 025 runs. This table is expected
--    to be a handful of rows at most; nothing selected here is beyond what
--    each workspace's own owner already sees on their own Settings page.
--    -- --
select workspace_id, company_name, booking_enabled, notifications_enabled, business_hours
from company_settings
order by workspace_id;


-- 8. Summary check -- would migration 025 be safe to apply? -- --
--   - Query 1 confirms company_settings exists with business_hours already
--     present and timezone NOT already present.
--   - Query 2 returned zero rows?      (no pre-existing timezone column --
--     migration 025 is a genuinely new addition, not a redundant re-run)
--   - Query 3 returned exactly one row?  (business_hours confirmed present,
--     matching migration 025's own header assumption)
--   - Query 6 returned zero rows?      (exactly one settings row per
--     workspace, as the application assumes)
-- If every answer above is "yes" / "as expected," migration 025 is safe to
-- apply as written.
