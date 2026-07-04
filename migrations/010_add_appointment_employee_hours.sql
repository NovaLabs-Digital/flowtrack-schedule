-- 010: Manual employee hours entry per appointment, for future payroll totals

CREATE TABLE IF NOT EXISTS appointment_employee_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES employees(id),
  hours_worked NUMERIC(5,2) NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_employee_hours_unique
  ON appointment_employee_hours(appointment_id, employee_id);
