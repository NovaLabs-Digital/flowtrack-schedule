-- Test-only baseline for the disposable PostgreSQL used by test-db/.
--
-- Supabase-specific roles and the handful of base tables that predate the
-- tracked migrations (workspaces, company_settings, clients, appointments,
-- employees, appointment_employee_hours -- the "Tenant Foundation" columns,
-- notably workspace_id, were added outside migrations/, see
-- migrations/014's header). Every migration under migrations/ that this
-- harness applies afterwards is the REAL production file, unmodified; this
-- file only supplies what those files assume already exists. Keep it
-- minimal: a column belongs here only if a real migration or function reads
-- it and no tracked migration creates it.

-- Roles and the auth/extensions stubs live in test-db/supabase-stubs.sql (the
-- harness loads it first).

-- Supabase grants every new public table to all three API roles at CREATE time
-- (default privileges); a migration that wants less must REVOKE explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role, anon, authenticated;

CREATE TABLE workspaces (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT
);

CREATE TABLE company_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  timezone     TEXT
);

CREATE TABLE clients (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  email        TEXT,
  phone        TEXT
);

-- 006 only ADDs appointments.employee_id and creates employees IF NOT EXISTS,
-- so the workspace-scoped shape production has is declared here first.
CREATE TABLE employees (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name         TEXT NOT NULL,
  phone        TEXT,
  color        TEXT NOT NULL DEFAULT '#3B82F6',
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE appointments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  client_id    UUID NOT NULL REFERENCES clients(id),
  service_type TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  scheduled_end TIMESTAMPTZ,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'scheduled',
  cancel_token TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 010 creates this IF NOT EXISTS (without workspace_id); production has the
-- workspace-scoped shape the routes write to.
CREATE TABLE appointment_employee_hours (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  employee_id    UUID REFERENCES employees(id),
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  hours_worked   NUMERIC(5,2) NOT NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
