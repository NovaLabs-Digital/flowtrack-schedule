-- 009: Add actual start/complete timestamps for job tracking

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS actual_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS actual_completed_at TIMESTAMPTZ;
