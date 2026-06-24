-- 007: Add color field to services

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#3B82F6';

-- Backfill existing services with distinct defaults
UPDATE services SET color = '#3B82F6' WHERE name = 'Regular Cleaning';
UPDATE services SET color = '#8B5CF6' WHERE name = 'Deep Cleaning';
UPDATE services SET color = '#F97316' WHERE name = 'Move-Out Cleaning';
UPDATE services SET color = '#22C55E' WHERE name = 'Office Cleaning';
UPDATE services SET color = '#14B8A6' WHERE name = 'Estimate';
