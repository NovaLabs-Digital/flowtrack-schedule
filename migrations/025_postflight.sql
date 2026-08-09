-- ============================================================================
-- Migration 025 postflight — READ-ONLY. Every statement below is a SELECT.
-- Nothing here creates, alters, or deletes anything. Confirms migration 025
-- (adding company_settings.timezone) applied cleanly and changed nothing
-- else -- run this AFTER migration 025 and review before proceeding to
-- deploy the application code that reads this column.
--
-- Exposes no password hashes, tokens, secrets, or client PII -- every query
-- below returns only table/column metadata, counts, and the owner-facing
-- business settings already visible on each workspace's own Settings page.
-- ============================================================================


-- 1. Confirm company_settings.timezone now exists and is selectable, with
--    the expected shape (nullable text, no default). -- --
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'company_settings' and column_name = 'timezone';


-- 2. Confirm business_hours (migration 024) still exists, unaffected. -- --
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'company_settings' and column_name = 'business_hours';


-- 3. Confirm appointments.repeat_months (migration 023) still exists,
--    unaffected -- migration 025 never references the appointments table.
--    -- --
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'appointments' and column_name = 'repeat_months';


-- 4. Total company_settings row count -- compare against the count you saw
--    when you ran 025_preflight.sql; should be identical (migration 025
--    adds a column, never a row). -- --
select count(*) as total_rows from company_settings;


-- 5. Every existing row's timezone value -- expected: NULL for every row,
--    with zero exceptions (migration 025 performs no backfill). -- --
select workspace_id, timezone
from company_settings
order by workspace_id;


-- 6. Count of any non-NULL timezone -- expected: 0. A nonzero result here
--    means something other than this migration wrote a value and should be
--    investigated before proceeding. -- --
select count(*) as non_null_timezone_count
from company_settings
where timezone is not null;


-- 7. workspace_id integrity, unchanged check -- distinct count, NULL count,
--    and any duplicate. Expected to exactly match query 5/6 of
--    025_preflight.sql. -- --
select count(distinct workspace_id) as distinct_workspace_ids,
       count(*) filter (where workspace_id is null) as null_workspace_id_count
from company_settings;

select workspace_id, count(*) as row_count
from company_settings
where workspace_id is not null
group by workspace_id
having count(*) > 1;


-- 8. Every existing row's current company_name, booking_enabled,
--    notifications_enabled, and business_hours -- compare field-by-field
--    against what 025_preflight.sql's query 7 showed for the same
--    workspace_id; every value should be byte-identical (migration 025
--    does not touch any of these columns). -- --
select workspace_id, company_name, booking_enabled, notifications_enabled, business_hours
from company_settings
order by workspace_id;


-- 9. Summary check -- did migration 025 apply cleanly with no side effects?
--    -- --
--   - Query 1 confirms timezone exists, nullable, no default.
--   - Query 2 and 3 confirm business_hours and repeat_months are untouched.
--   - Query 4 matches 025_preflight.sql's row count exactly?
--   - Query 6 returned 0?                (every timezone is NULL)
--   - Query 7's duplicate check returned zero rows, and its distinct/NULL
--     counts match 025_preflight.sql exactly?
--   - Query 8's values match 025_preflight.sql's query 7, row for row?
-- If every answer above is "yes" / "as expected," migration 025 applied
-- cleanly and it is safe to deploy the application code that reads
-- company_settings.timezone.
-- ============================================================================
