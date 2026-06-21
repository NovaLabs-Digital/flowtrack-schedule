-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard → SQL Editor)
-- Adds duration_minutes column to appointments table
-- Existing rows default to 60 minutes

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS duration_minutes integer DEFAULT 60;
