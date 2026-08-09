-- 024: Phase 4 (Business Hours) -- adds a new, additive, nullable column:
-- company_settings.business_hours.
--
-- No existing column, row, index, policy, or other table is touched. No row
-- is deleted or rewritten. Safely re-runnable (ADD COLUMN IF NOT EXISTS;
-- the constraint guard below only adds a constraint that isn't already
-- present).
--
-- NULL means "this workspace has not saved custom Business Hours" -- every
-- existing company_settings row simply has NULL after this migration. The
-- application (see lib/businessHours.ts's effectiveBusinessHours) treats a
-- NULL value as the same Mon-Fri 07:00-17:00 default this app has always
-- effectively used, so this migration does not change any existing workspace's booking behavior merely by adding the column. No backfill is
-- performed or needed.
--
-- Shape (validated by the application, not by SQL -- see the file header
-- rationale below):
--   {
--     "monday":    [{ "start": "08:00", "end": "12:00" }, { "start": "13:00", "end": "17:00" }],
--     "tuesday":   [{ "start": "08:00", "end": "17:00" }],
--     "wednesday": [],
--     ...
--   }
-- An empty array for a day means Closed. Times are normalized 24-hour
-- "HH:mm" wall-clock strings, interpreted using the existing global
-- BUSINESS_TZ (America/New_York) until the dedicated per-workspace Time
-- Zone phase -- never a locale-formatted "8:00 AM" string.
--
-- The CHECK constraint here only guards the outermost shape (must be a JSON
-- object, not an array/string/number) -- the real per-day/per-range
-- business rules (valid HH:mm, start < end, no overlaps, valid weekday
-- keys, ...) are intentionally validated in application code
-- (lib/businessHours.ts's normalizeBusinessHours), matching this project's
-- established preference (see prior additive migrations) for simple,
-- maintainable SQL over complex business-rule constraints.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS business_hours jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'company_settings' AND constraint_name = 'company_settings_business_hours_is_object'
  ) THEN
    ALTER TABLE company_settings
      ADD CONSTRAINT company_settings_business_hours_is_object
      CHECK (business_hours IS NULL OR jsonb_typeof(business_hours) = 'object');
  END IF;
END $$;

-- =============================================================================
-- Backfill.
--
-- None. Every existing company_settings row simply has business_hours = NULL after this migration -- exactly the pre-existing "using the default
-- Mon-Fri 07:00-17:00 hours" state this feature is designed to represent,
-- not a value this migration invents or infers.
-- =============================================================================
