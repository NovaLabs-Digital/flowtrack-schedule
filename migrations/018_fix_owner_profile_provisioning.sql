-- 018: Phase 5.7D-R9 — fixes provision_owner_workspace to create the
-- required `profiles` row before inserting into `workspace_memberships`.
--
-- Root cause (verified against a real production signup failure):
-- `workspace_memberships.profile_id` carries a foreign key constraint
-- (`workspace_memberships_profile_id_fkey`) to `profiles.id`, which itself
-- references `auth.users.id` with `ON DELETE CASCADE`. Supabase Auth does
-- NOT auto-populate a `profiles` row on user creation in this project.
-- migration 017's original provision_owner_workspace never inserted into
-- `profiles` at all, so the very first real self-service signup failed
-- outright the moment it reached the workspace_memberships insert:
--
--   ERROR 23503: insert or update on table "workspace_memberships"
--   violates foreign key constraint "workspace_memberships_profile_id_fkey"
--   DETAIL: Key (profile_id) is not present in table "profiles".
--
-- Because that call was one function invocation (implicitly transactional),
-- the failure rolled back completely — no partial workspace/membership/
-- settings/subscription row was left behind. This migration does not
-- touch migration 017's executable SQL at all (immutable historical
-- record, already applied to production) — it only replaces the function
-- via CREATE OR REPLACE, exactly as provision_owner_workspace itself was
-- always designed to be upgraded (see 017's own header comment).
--
-- Why this was missed by every prior audit and by migration 017's own
-- preflight: this repository has carried a documented assumption since
-- before self-service signup existed at all (docs/CONTROLLED_CUSTOMER_
-- ONBOARDING.md §0, written for the original *manual* onboarding runbook)
-- that stated outright "no code path in this repository ever queries or
-- writes profiles" and "this runbook does not require a profiles row to
-- exist for login to work." That claim was inherited unquestioned into
-- this self-service provisioning design — provision_owner_workspace was
-- built to insert into workspaces/workspace_memberships/company_settings/
-- subscriptions, mirroring that same manual runbook's write set, which
-- itself never included profiles either (and carries the identical latent
-- bug — corrected in docs/CONTROLLED_CUSTOMER_ONBOARDING.md alongside this
-- migration). migrations/017_preflight.sql's required-columns check (§6)
-- was scoped to workspaces/company_settings/subscriptions — the exact set
-- provision_owner_workspace was already known to write to — and never
-- asked the broader question "what does workspace_memberships' OWN
-- foreign key definition require to exist first," even though that
-- constraint would have been visible in that same preflight's §2 (general
-- constraint listing) had it been cross-referenced specifically for this.
-- This was a transitive-dependency gap: every table provisioning directly
-- writes to was checked; the one table an inherited foreign key silently
-- required (one hop upstream, via workspace_memberships' own constraint,
-- not via anything provision_owner_workspace's own INSERT list mentioned)
-- was not.
--
-- Operational note: because both migration 017 and this migration define
-- provision_owner_workspace via CREATE OR REPLACE FUNCTION, migrations
-- must be applied in order and never re-run out of order — re-running
-- 017 after this migration has been applied would silently revert
-- provision_owner_workspace back to the broken pre-R9 version. This is
-- inherent to using CREATE OR REPLACE FUNCTION across ordered migrations,
-- not a defect in either file.
--
-- Safely re-runnable: CREATE OR REPLACE FUNCTION is replace-safe by
-- construction; the REVOKE statements below are idempotent (revoking an
-- already-revoked privilege is a no-op).

BEGIN;

-- =============================================================================
-- provision_owner_workspace — replaces migration 017's original definition.
-- Everything about the function's contract is unchanged: the ONLY
-- parameter is the server-verified Auth user id; every other value is
-- either read from the server-controlled pending_signups row (company
-- name, email, consent evidence) or a literal hardcoded in this function
-- body (role='owner', billing_mode='stripe', booking_enabled=false,
-- notifications_enabled=false) — no parameter through which a caller
-- could supply a workspace id, role, billing mode, toggle value,
-- entitlement, or trial state. Idempotent by construction: the first
-- statement checks whether this Auth user already owns a workspace and
-- returns it unchanged if so, rather than creating a second one — unchanged
-- from migration 017. Not SECURITY DEFINER, for the identical reason
-- documented in migration 017: only ever invoked via the service-role
-- client (supabaseAdmin.rpc(...)), which already carries the necessary
-- privilege at the role level.
--
-- The one behavioral change: a `profiles (id, email)` row is now inserted
-- immediately before the `workspace_memberships` insert that depends on
-- it, using `ON CONFLICT (id) DO NOTHING` so a profiles row that already
-- exists for any other reason is never overwritten — its email or any
-- other existing column value is left exactly as-is.
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

  -- Unchanged from migration 017 (Phase 5.7D-R5): workspaces.name is NOT
  -- NULL with no default in production — it must come from the
  -- server-controlled pending_signups row, never a generated placeholder.
  IF v_pending.company_name IS NULL OR btrim(v_pending.company_name) = '' THEN
    RAISE EXCEPTION 'provision_owner_workspace: pending_signups.company_name is empty for auth_user_id %', p_auth_user_id;
  END IF;

  v_new_workspace_id := gen_random_uuid();

  -- workspaces.slug is nullable and intentionally left untouched here — no
  -- verified application requirement reads or depends on it today.
  INSERT INTO workspaces (id, name) VALUES (v_new_workspace_id, v_pending.company_name);

  -- Phase 5.7D-R9: required before the workspace_memberships insert below
  -- — see this file's header comment for the full root-cause explanation.
  -- ON CONFLICT (id) DO NOTHING means a pre-existing profiles row (however
  -- it got there) is never touched, never overwritten, and its existing
  -- email or any other column is left exactly as it was.
  INSERT INTO profiles (id, email)
  VALUES (p_auth_user_id, v_pending.email)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO workspace_memberships (profile_id, workspace_id, role, terms_accepted_at, terms_version, session_epoch)
  VALUES (p_auth_user_id, v_new_workspace_id, 'owner', v_pending.terms_accepted_at, v_pending.terms_version, 1);

  INSERT INTO company_settings (workspace_id, company_name, booking_enabled, notifications_enabled)
  VALUES (v_new_workspace_id, v_pending.company_name, false, false);

  -- Stripe-mode subscription record only -- no trial is granted locally;
  -- trial state remains exclusively the Stripe webhook's responsibility
  -- (unchanged from migration 017).
  INSERT INTO subscriptions (workspace_id, billing_mode)
  VALUES (v_new_workspace_id, 'stripe');

  UPDATE pending_signups SET consumed_at = now() WHERE auth_user_id = p_auth_user_id;

  RETURN v_new_workspace_id;
END;
$$;

-- Re-stated explicitly (idempotent — CREATE OR REPLACE FUNCTION itself
-- preserves existing privileges, but this is restated here defensively so
-- this file alone is a complete, self-verifying statement of the
-- function's access control, with nothing left implicit).
REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM anon;
REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM authenticated;

COMMIT;
