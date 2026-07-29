-- 019: Employee email uniqueness — global to workspace-scoped.
--
-- Root cause (verified against a real production failure): migration 008
-- created idx_employees_email as a GLOBAL unique partial index
-- (`ON employees(email) WHERE email IS NOT NULL`, no workspace_id, no case
-- normalization). That was correct back when every employee belonged to
-- exactly one workspace, but this application now supports the same real
-- person having a separate employee record in more than one workspace
-- (confirmed in production: Teresa exists as an employee in both the
-- original admin workspace and the newly provisioned ACS workspace, using
-- the identical real email address in both). Configuring her ACS login
-- with that email correctly failed with:
--
--   ERROR: duplicate key value violates unique constraint
--   "idx_employees_email"
--
-- because the admin-workspace row already held that exact value in the
-- global index. This is the intended fix, not a workaround: email
-- uniqueness should be scoped per business (workspace), matching how every
-- other uniqueness concern in this schema already works (e.g.
-- subscriptions.workspace_id UNIQUE, never a bare global UNIQUE).
--
-- This migration also introduces case-insensitive comparison
-- (`LOWER(email)`), matching the existing normalization convention already
-- used for owner-account email at signup
-- (app/api/auth/signup/route.ts: `.trim().toLowerCase()`) — employee email
-- previously had no such normalization anywhere in this codebase. See the
-- companion application changes in app/api/employees/route.ts (normalizes
-- on write) and app/api/auth/login/route.ts (normalizes and safely
-- disambiguates multiple workspace matches on read — see that file's own
-- comment for why a plain "first match wins" lookup would be unsafe now
-- that the same email can exist in more than one workspace).
--
-- No backfill is required: migrations/019_preflight.sql's duplicate check
-- confirmed, immediately before writing this migration, that every
-- existing employees.email value already happens to be stored in
-- lowercase, and that zero workspaces currently contain two employees
-- sharing a normalized email (the one precondition that would make the
-- new unique index impossible to create as written). This migration does
-- not modify any existing row.
--
-- Safely re-runnable: DROP INDEX IF EXISTS and CREATE UNIQUE INDEX IF NOT
-- EXISTS are both idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_employees_email;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_workspace
  ON employees (workspace_id, LOWER(email))
  WHERE email IS NOT NULL;

COMMIT;
