-- 006: Create employees table and add employee_id to appointments

CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  phone TEXT,
  color TEXT NOT NULL DEFAULT '#3B82F6',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id);

CREATE INDEX IF NOT EXISTS idx_appointments_employee_id
  ON appointments(employee_id);
