-- 014: Explicitly enable Row Level Security (no policies) on every
-- protected business/tenant table.
--
-- Verified authoritative state before this migration (Phase 4A investigation):
--   - RLS is already enabled on all 10 tables below.
--   - FORCE ROW LEVEL SECURITY is false on all of them.
--   - No RLS policies exist on any of them.
--   - anon/authenticated hold standard default table grants, but because RLS
--     is enabled with zero policies, every request from those roles is
--     denied — confirmed empirically: querying any of these tables with the
--     anon key returns HTTP 200 with an empty result set, never the real
--     rows and never a grant/permission error.
--   - No views or materialized views depend on these tables.
--   - No SECURITY DEFINER function references any of them.
--
-- This migration changes nothing about current behavior. Its purpose is to
-- make that already-true state an explicit, versioned, intentional part of
-- the schema — not an accident of however these tables were originally
-- created — so it survives future schema changes and isn't mistaken for an
-- oversight.
--
-- ENABLE ROW LEVEL SECURITY is idempotent: re-running it on a table where
-- RLS is already enabled is a no-op, not an error. Safe to apply more than
-- once.
--
-- IMPORTANT — read before touching RLS on these tables:
--
--   1. No-policy RLS is deliberate deny-all for `anon` and `authenticated`.
--      There is intentionally no policy granting either role any access,
--      to any row, on any of these tables.
--
--   2. Business-data access must remain server-only, through the
--      service-role client (`lib/supabaseAdmin.ts`). The service role
--      bypasses RLS entirely by Supabase's design — that is the ONLY
--      intended way any table below is ever read or written. No client
--      code should ever query these tables directly with the anon key.
--
--   3. Workspace isolation (which workspace's rows a given request may
--      see) is enforced entirely in application code — every route in
--      app/api/** and every server component scopes its queries by
--      workspace_id, audited exhaustively during the Tenant Foundation
--      Phase 2 sprint. RLS as configured here does NOT know what a
--      workspace is; it only blocks non-service-role access outright.
--      The two layers serve different purposes: the audited routes ensure
--      the *correct* workspace's data is returned; this RLS configuration
--      ensures nothing can reach these tables *at all* except through
--      those audited routes.
--
--   4. Do not disable RLS on these tables, and do not add a permissive
--      policy (e.g. `USING (true)`) to silence a Supabase dashboard
--      "RLS enabled, no policies" warning. That warning is describing
--      this migration's intended state correctly — it is not a problem
--      to fix. Disabling RLS or adding an open policy would remove real,
--      currently-effective protection against direct anon-key access.
--
--   5. If workspace-aware RLS policies are ever deliberately designed in
--      the future (e.g. as part of a move toward client-side Supabase
--      Auth sessions), that is a separate, larger architectural decision
--      requiring its own review — not something to bolt on incrementally
--      here.

ALTER TABLE workspaces                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_memberships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE services                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_employee_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages_sent              ENABLE ROW LEVEL SECURITY;

-- Deliberately NOT included in this migration:
--   - Any CREATE POLICY statement (see note 1 above).
--   - ALTER TABLE ... FORCE ROW LEVEL SECURITY (would additionally restrict
--     the table owner; out of scope for this change and not verified safe).
--   - Any GRANT/REVOKE statement (grants are unchanged; RLS is the
--     enforcement layer here, not table-level privileges).
