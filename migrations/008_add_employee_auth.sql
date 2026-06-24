-- 008: Add email and password_hash to employees for login

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email
  ON employees(email) WHERE email IS NOT NULL;
