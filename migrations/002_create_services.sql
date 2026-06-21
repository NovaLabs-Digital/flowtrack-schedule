-- Run this in the Supabase SQL Editor
-- Creates the services table and seeds default cleaning services

CREATE TABLE IF NOT EXISTS services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  description      text,
  duration_minutes integer NOT NULL DEFAULT 60,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- Seed defaults (only if table is empty)
INSERT INTO services (name, description, duration_minutes, active)
SELECT * FROM (VALUES
  ('Regular Cleaning',    'Standard residential cleaning service',  120, true),
  ('Deep Cleaning',       'Thorough deep cleaning of entire home',  180, true),
  ('Move-Out Cleaning',   'Full cleaning for move-in or move-out',  240, true),
  ('Office Cleaning',     'Commercial office cleaning',             120, true),
  ('Estimate',            'On-site estimate and walk-through',       60, true)
) AS v(name, description, duration_minutes, active)
WHERE NOT EXISTS (SELECT 1 FROM services LIMIT 1);
