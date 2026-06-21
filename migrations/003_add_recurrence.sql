-- Run this in the Supabase SQL Editor
-- Adds recurrence support to appointments

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS series_id uuid;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS frequency_type text DEFAULT 'one_time';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS repeat_weeks integer DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_appointments_series_id ON appointments (series_id);
