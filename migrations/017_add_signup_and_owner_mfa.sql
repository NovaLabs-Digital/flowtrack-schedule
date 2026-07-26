-- 017: Phase 5.7D — self-service signup, transactional workspace
-- provisioning, and mandatory owner MFA/session-revocation support.
--
-- Primarily additive and non-destructive throughout: two new tables,
-- additive columns on the pre-existing (untracked-origin — see migrations/
-- 016's own note and docs/CONTROLLED_CUSTOMER_ONBOARDING.md §0)
-- `workspace_memberships` table, and new functions. No existing row is
-- ever updated or deleted by this migration, and no existing column's
-- stored data is rewritten. The one deliberate exception (Phase 5.7D-R5,
-- verified against production) is a single schema-default correction on
-- `company_settings.notifications_enabled` — it changes the DEFAULT applied
-- to future INSERTs only; it does not touch any existing row's value (see
-- that section below for the exact statement and reasoning).
--
-- IMPORTANT — unverified schema caveat (same discipline established in
-- docs/CONTROLLED_CUSTOMER_ONBOARDING.md §0): this repository has never had
-- a tracked CREATE TABLE for `workspaces` or `workspace_memberships` — both
-- predate migration tracking. Everything below about their existing shape
-- (workspaces.id uuid primary key; workspace_memberships.profile_id/
-- workspace_id/role) is proven only by how existing application code reads
-- and writes them (app/api/auth/login/route.ts, migrations/015's own FK
-- references). Before running this migration against production, re-run
-- the information_schema preflight from that runbook's §0 and confirm
-- nothing below conflicts with a column this migration's author could not
-- see from source alone.
--
-- Safely re-runnable: every CREATE TABLE/INDEX uses IF NOT EXISTS, every
-- ALTER TABLE ... ADD COLUMN uses IF NOT EXISTS, and the unique-constraint
-- addition is guarded by an information_schema check rather than assumed
-- absent.

BEGIN;

-- =============================================================================
-- pending_signups — server-controlled home for the company name and consent
-- evidence collected at signup, between initial submission and email
-- confirmation. Deliberately NOT stored in Supabase Auth's user_metadata:
-- that field is browser-updatable in default Supabase configurations, and
-- mixing loosely-typed "claimed intent" with the identity record itself is
-- exactly the risk this table exists to avoid (see the Phase 5.7D-R1
-- audit's "Pending-signup data design"). Read only by
-- provision_owner_workspace below, looked up by the server-verified
-- auth_user_id — never by anything a browser supplies at confirmation time.
--
-- Rows are never deleted, including for abandoned/never-confirmed signups
-- (approved decision) — consumed_at marks successful completion without
-- destroying the audit trail.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_signups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id       uuid NOT NULL,
  email              text NOT NULL,
  company_name       text NOT NULL,
  terms_accepted_at  timestamptz NOT NULL,
  terms_version      text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  consumed_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_signups_auth_user_id ON pending_signups(auth_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_signups_email ON pending_signups(email);

ALTER TABLE pending_signups ENABLE ROW LEVEL SECURITY;
-- No policies — deny-all for anon/authenticated, service-role only,
-- matching every other table in this schema (see migration 014 and
-- docs/SECURITY.md, "Database Access & Row Level Security").

-- =============================================================================
-- pending_mfa_challenges — short-lived, single-use, server-only claim record
-- for the window between password verification and completed TOTP
-- verification. The browser is handed only the `token` column's value (a
-- high-entropy opaque reference, generated server-side) inside a signed,
-- HttpOnly cookie — the actual Supabase access/refresh token pair lives
-- here, server-side, and is never sent to the browser (see the Phase
-- 5.7D-R3 correction's "Selected pending-MFA token design"). Same
-- lease/claim shape already proven in this schema by
-- stripe_webhook_events/billing_email_log (migration 015).
--
-- Unlike pending_signups, this table legitimately SHOULD be cleaned up —
-- retaining expired transient credential material indefinitely is itself a
-- liability, not an audit asset. Application code deletes a row the moment
-- it is consumed or found expired (lazy deletion-on-read), and a periodic
-- purge of anything past expires_at + 1 hour is expected application-level
-- housekeeping — this is a genuinely different retention policy from
-- pending_signups, not an oversight or inconsistency.
-- =============================================================================

CREATE TABLE IF NOT EXISTS pending_mfa_challenges (
  token                  text PRIMARY KEY,
  auth_user_id           uuid NOT NULL,
  factor_id              text,
  supabase_access_token  text NOT NULL,
  supabase_refresh_token text NOT NULL,
  attempt_count          integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pending_mfa_challenges_auth_user_id ON pending_mfa_challenges(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_pending_mfa_challenges_expires_at ON pending_mfa_challenges(expires_at);

ALTER TABLE pending_mfa_challenges ENABLE ROW LEVEL SECURITY;
-- No policies — deny-all for anon/authenticated, service-role only.

-- =============================================================================
-- workspace_memberships — additive columns only.
--
-- terms_accepted_at / terms_version: consent evidence, copied from the
-- pending_signups row at provisioning time (see the function below) and
-- never touched again.
--
-- session_epoch: the one piece of server-side state that makes an otherwise
-- fully stateless, signed sft_session cookie revocable. Incremented only by
-- "sign out all devices," password reset/change, email change, MFA
-- removal/replacement, and support/security recovery — never by ordinary
-- sign-out (see the Phase 5.7D-R3 correction's "Final logout/revocation
-- behavior"). A signed owner session embeds the epoch value current at
-- issuance; every protected owner request re-compares it against the
-- current stored value and fails closed on any mismatch.
-- =============================================================================

ALTER TABLE workspace_memberships
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS session_epoch integer NOT NULL DEFAULT 1;

-- Required uniqueness preventing duplicate owner provisioning for the same
-- Auth identity: guarded by an information_schema check rather than assumed
-- absent, since this table's full existing constraint set is unverified
-- (see the caveat at the top of this file). If a constraint already
-- enforces this, this block is a safe no-op.
--
-- Phase 5.7D-R6 correction: information_schema.key_column_usage.column_name
-- is typed sql_identifier, not text -- array_agg() over it therefore
-- produces a sql_identifier[], and Postgres has no = operator between
-- sql_identifier[] and a plain text[] literal like ARRAY['profile_id',
-- 'role']. Production confirmed this fails outright: "ERROR 42883:
-- operator does not exist: information_schema.sql_identifier[] = text[]".
-- The whole migration is wrapped in BEGIN/COMMIT, so that failure rolled
-- back cleanly with nothing partially applied -- but the guard could never
-- actually run. Both sides are now explicitly cast to text/text[] so the
-- comparison type-checks and the guard behaves as originally intended.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'workspace_memberships'
      AND tc.constraint_type = 'UNIQUE'
      AND tc.table_schema = 'public'
    GROUP BY tc.constraint_name
    HAVING array_agg(kcu.column_name::text ORDER BY kcu.column_name::text) = ARRAY['profile_id', 'role']::text[]
  ) THEN
    ALTER TABLE workspace_memberships
      ADD CONSTRAINT uq_workspace_memberships_profile_role UNIQUE (profile_id, role);
  END IF;
END $$;

-- =============================================================================
-- company_settings.notifications_enabled — future-row default correction
-- (Phase 5.7D-R5). Verified against production: this column is currently
-- `boolean NOT NULL DEFAULT true`. A brand-new, just-signed-up workspace
-- must start with notifications OFF (matching `booking_enabled`'s existing
-- `false` default and provision_owner_workspace's own explicit literal
-- below) — a newly provisioned workspace should never begin sending
-- customer notifications before the owner has configured anything.
--
-- This statement changes ONLY the column's default for future INSERTs.
-- Postgres's ALTER COLUMN ... SET DEFAULT never reads, rewrites, or
-- otherwise touches a single existing row — every already-provisioned
-- workspace's current `notifications_enabled` value is left exactly as it
-- is. `booking_enabled` is not referenced by this statement and is
-- unaffected. This is the one intentional exception to this migration
-- being purely additive, called out explicitly rather than left implicit
-- in the "additive and non-destructive" framing above.
-- =============================================================================

ALTER TABLE company_settings
  ALTER COLUMN notifications_enabled SET DEFAULT false;

-- =============================================================================
-- provision_owner_workspace — the one transactional operation that creates
-- every application record for a newly confirmed owner, invoked only after
-- the caller has independently verified (server-side, against Supabase's
-- own auth.users.email_confirmed_at — never a client claim) that the given
-- Auth user's email is confirmed.
--
-- The ONLY parameter is the server-verified Auth user id. Every other value
-- is either read from the server-controlled pending_signups row (company
-- name, consent evidence) or a literal hardcoded in this function body
-- (role='owner', billing_mode='stripe', booking_enabled=false,
-- notifications_enabled=false) — this function has no parameter through
-- which a caller could supply a workspace id, role, billing mode, toggle
-- value, entitlement, or trial state.
--
-- Idempotent by construction: the first statement checks whether this Auth
-- user already owns a workspace and returns it unchanged if so, rather than
-- creating a second one. This single guard is what makes the function safe
-- to invoke more than once for the same identity (a retried confirmation
-- callback, a double-clicked link, a browser that lost the response after
-- the transaction already committed) — see the Phase 5.7D-R1 audit's
-- concurrency table.
--
-- Not SECURITY DEFINER: this function is only ever invoked via the
-- service-role client (supabaseAdmin.rpc(...)), exactly like every other
-- write in this application. A plain (non-SECURITY DEFINER) function
-- invoked by the service_role Postgres role executes AS service_role,
-- which already has RLS-bypass privileges at the role level — the same
-- reason every other service-role table write in this schema already
-- bypasses RLS with no SECURITY DEFINER anywhere. Introducing one here
-- would add a privilege-escalation surface this codebase has never needed.
-- =============================================================================

CREATE OR REPLACE FUNCTION provision_owner_workspace(p_auth_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_workspace_id uuid;
  v_pending pending_signups%ROWTYPE;
  v_new_workspace_id uuid;
BEGIN
  SELECT workspace_id INTO v_existing_workspace_id
  FROM workspace_memberships
  WHERE profile_id = p_auth_user_id AND role = 'owner'
  LIMIT 1;

  IF v_existing_workspace_id IS NOT NULL THEN
    RETURN v_existing_workspace_id;
  END IF;

  SELECT * INTO v_pending
  FROM pending_signups
  WHERE auth_user_id = p_auth_user_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'provision_owner_workspace: no pending_signups row for auth_user_id %', p_auth_user_id;
  END IF;

  -- Phase 5.7D-R5: workspaces.name is NOT NULL with no default in
  -- production (verified preflight finding) — it must come from the
  -- server-controlled pending_signups row, never a generated placeholder.
  -- pending_signups.company_name is itself NOT NULL and the signup route
  -- already rejects an empty company name before ever writing that row
  -- (app/api/auth/signup/route.ts), but this function does not trust that
  -- upstream validation alone: an empty-but-non-null string would still
  -- satisfy pending_signups' NOT NULL constraint while producing a blank,
  -- effectively nameless workspace, which is exactly the "empty or
  -- placeholder name" this guard exists to refuse.
  IF v_pending.company_name IS NULL OR btrim(v_pending.company_name) = '' THEN
    RAISE EXCEPTION 'provision_owner_workspace: pending_signups.company_name is empty for auth_user_id %', p_auth_user_id;
  END IF;

  v_new_workspace_id := gen_random_uuid();

  -- workspaces.slug is nullable and intentionally left untouched here — no
  -- verified application requirement reads or depends on it today.
  INSERT INTO workspaces (id, name) VALUES (v_new_workspace_id, v_pending.company_name);

  INSERT INTO workspace_memberships (profile_id, workspace_id, role, terms_accepted_at, terms_version, session_epoch)
  VALUES (p_auth_user_id, v_new_workspace_id, 'owner', v_pending.terms_accepted_at, v_pending.terms_version, 1);

  INSERT INTO company_settings (workspace_id, company_name, booking_enabled, notifications_enabled)
  VALUES (v_new_workspace_id, v_pending.company_name, false, false);

  INSERT INTO subscriptions (workspace_id, billing_mode)
  VALUES (v_new_workspace_id, 'stripe');

  UPDATE pending_signups SET consumed_at = now() WHERE auth_user_id = p_auth_user_id;

  RETURN v_new_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM anon;
REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM authenticated;
-- No explicit GRANT to service_role is required or added: the service role
-- already bypasses RLS and bears the elevated privilege every other write
-- in this schema relies on (see docs/SECURITY.md) — this function is
-- reachable only through supabaseAdmin, exactly like every other table
-- write in this application, never through a client-facing key.

-- =============================================================================
-- rate_limit_counters — Phase 5.7D-R4: durable, repository-backed abuse
-- protection for public-facing auth endpoints (signup, confirmation
-- resend, password login, MFA verification), replacing the previous
-- in-memory-only limiter for these surfaces. A per-serverless-instance
-- in-memory Map cannot protect a public endpoint on Vercel, where cold
-- starts and multiple concurrent instances mean an attacker's requests are
-- very likely spread across several completely independent counters.
--
-- bucket_key is never a raw IP address: application code computes it as
-- "<bucket-name>:<hex HMAC-SHA256 of the IP, keyed by SESSION_SECRET>"
-- before this table is ever touched (see lib/durableRateLimit.ts) — this
-- table never stores anything that identifies a real IP address on its
-- own, only an opaque, keyed, non-reversible digest scoped to one bucket.
--
-- No RLS policies — deny-all for anon/authenticated, service-role only,
-- matching every other table in this schema.
-- =============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key    text PRIMARY KEY,
  window_start  timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  locked_until  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window_start ON rate_limit_counters(window_start);

ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- record_rate_limit_attempt — the one atomic operation every rate-limited
-- endpoint calls, exactly once per attempt. SELECT ... FOR UPDATE takes a
-- row lock for the duration of the transaction, so two concurrent requests
-- for the same bucket_key are serialized by Postgres itself rather than
-- racing in application code — this is what makes the counter genuinely
-- atomic under concurrency, not merely "usually correct."
--
-- Parameters (window/max/lockout) are supplied by the CALLER as fixed,
-- hardcoded, documented constants per bucket (see
-- lib/durableRateLimit.ts's RATE_LIMIT_BUCKETS) — never a client-supplied
-- value; this function itself has no opinion on what a "reasonable" limit
-- is, it only enforces whatever fixed configuration the caller passes.
--
-- Not SECURITY DEFINER, for the identical reason provision_owner_workspace
-- above isn't: only ever invoked via the service-role client, which
-- already carries the necessary privilege at the role level.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_rate_limit_attempt(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_attempts integer,
  p_lockout_seconds integer
)
RETURNS TABLE(limited boolean, retry_after_seconds integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_row rate_limit_counters%ROWTYPE;
  v_new_count integer;
  v_locked_until timestamptz;
BEGIN
  SELECT * INTO v_row FROM rate_limit_counters WHERE bucket_key = p_bucket_key FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO rate_limit_counters (bucket_key, window_start, attempt_count, locked_until)
    VALUES (p_bucket_key, v_now, 1, NULL);
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  -- An expired lockout, or a window that's aged out with no lockout ever
  -- having been reached, both reset the counter to a fresh window rather
  -- than accumulating forever.
  IF (v_row.locked_until IS NOT NULL AND v_row.locked_until < v_now)
     OR (v_row.locked_until IS NULL AND v_now - v_row.window_start > make_interval(secs => p_window_seconds)) THEN
    UPDATE rate_limit_counters SET window_start = v_now, attempt_count = 1, locked_until = NULL
      WHERE bucket_key = p_bucket_key;
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  IF v_row.locked_until IS NOT NULL AND v_row.locked_until >= v_now THEN
    RETURN QUERY SELECT true, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.locked_until - v_now)))::integer);
    RETURN;
  END IF;

  v_new_count := v_row.attempt_count + 1;
  v_locked_until := NULL;
  IF v_new_count >= p_max_attempts THEN
    v_locked_until := v_now + make_interval(secs => p_lockout_seconds);
  END IF;

  UPDATE rate_limit_counters SET attempt_count = v_new_count, locked_until = v_locked_until
    WHERE bucket_key = p_bucket_key;

  IF v_locked_until IS NOT NULL THEN
    RETURN QUERY SELECT true, p_lockout_seconds;
  ELSE
    RETURN QUERY SELECT false, 0;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION record_rate_limit_attempt(text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_rate_limit_attempt(text, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION record_rate_limit_attempt(text, integer, integer, integer) FROM authenticated;

-- =============================================================================
-- clear_rate_limit — used only by the password-login bucket, whose
-- pre-existing (pre-durable) semantics were "only failures count, a
-- successful login clears the count" — preserved here rather than
-- silently changed to "every attempt counts" (that stricter rule is
-- intentional for signup/confirmation-resend/MFA-verify, whose abuse
-- shape is different — see lib/durableRateLimit.ts).
-- =============================================================================

CREATE OR REPLACE FUNCTION clear_rate_limit(p_bucket_key text)
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM rate_limit_counters WHERE bucket_key = p_bucket_key;
$$;

REVOKE ALL ON FUNCTION clear_rate_limit(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION clear_rate_limit(text) FROM anon;
REVOKE ALL ON FUNCTION clear_rate_limit(text) FROM authenticated;

COMMIT;
