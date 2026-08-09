-- 023: Phase 2 (Monthly Recurring Appointments) -- adds a new, additive,
-- nullable column: appointments.repeat_months.
--
-- Monthly recurrence is intentionally NOT layered onto the existing
-- repeat_weeks column (migration 003) -- a monthly series uses
-- frequency_type = 'monthly' and this new column; a weekly series
-- continues to use frequency_type = 'weekly' and repeat_weeks exactly as
-- it does today, completely untouched by this migration. No existing
-- column, row, index, policy, or other table is touched. No row is deleted
-- or rewritten. Safely re-runnable (ADD COLUMN IF NOT EXISTS; the
-- constraint guard below only adds a constraint that isn't already
-- present).
--
-- NULL means "this appointment is not part of a monthly-interval series"
-- -- every existing appointment (one-time, daily, weekdays, or weekly)
-- simply has NULL after this migration, matching its exact pre-migration
-- appearance. No backfill is performed or needed.
--
-- The CHECK constraint mirrors the UI's supported domain (1 through 12
-- months, see app/components/dashboard/AppointmentModal.tsx) and, like
-- price_cents' (migration 020) and team_color's (migration 022) own CHECK
-- constraints, permits NULL unconditionally -- it can never invalidate an
-- existing row, since every existing row has NULL in this new column.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS repeat_months integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'appointments' AND constraint_name = 'appointments_repeat_months_range'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_repeat_months_range
      CHECK (repeat_months IS NULL OR (repeat_months >= 1 AND repeat_months <= 12));
  END IF;
END $$;

-- =============================================================================
-- Backfill.
--
-- None. Every existing appointment simply has repeat_months = NULL after
-- this migration -- exactly the pre-existing "not a monthly series" state
-- this feature is designed to represent, not a value this migration
-- invents or infers. Existing weekly/daily/weekdays series continue to be
-- fully described by frequency_type + repeat_weeks alone, unchanged.
-- =============================================================================
