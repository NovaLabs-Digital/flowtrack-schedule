-- Run this in the Supabase SQL Editor
-- Adds archived_at column for soft-archive of clients

ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at timestamptz;
