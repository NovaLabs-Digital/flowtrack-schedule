-- Run this in the Supabase SQL Editor
-- Expands client fields for full client management

ALTER TABLE clients ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_since date;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referred_by text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_contact_method text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_email boolean DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_sms boolean DEFAULT false;

-- Backfill status for existing rows
UPDATE clients SET status = 'active' WHERE status IS NULL;
