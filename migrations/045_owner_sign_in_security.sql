-- 045: optional two-step sign-in for owners, with single-use recovery codes.
--
-- The setting belongs to the owner's sign-in identity (the Supabase Auth
-- user), like the authenticator itself. An identity can own only one
-- workspace (uq_workspace_memberships_profile_role, migration 017), so there
-- is exactly one owner membership -- and one session_epoch -- per setting.
--
-- Two-step sign-in is ON unless an owner turned it off: an identity with no
-- owner_security row is treated as ON, so existing and new owners keep it
-- with no backfill. The application asks for a code whenever the setting is
-- on OR a verified authenticator exists, so any partial failure leaves
-- sign-in stricter, never weaker.
--
-- Recovery codes are stored only as SHA-256 hashes of high-entropy random
-- codes (80 bits each), used at most once (owner_use_recovery_code marks a
-- code used atomically, so a replayed or concurrent use is refused).
--
-- Security changes (turning on/off, new recovery codes, recovery) hold a
-- short per-identity lock while the authenticator is being changed, so two
-- changes can never interleave; owner_security_finish applies the setting,
-- replaces the recovery codes, and increases session_epoch (signing out
-- every other device) in one transaction.
--
-- pending_mfa_challenges gains:
--   * purpose: which flow a verification belongs to (sign-in, turning on,
--     turning off, new recovery codes);
--   * enrolled: an authenticator was set up in this flow;
--   * recovered: a recovery code was accepted in this flow.
--
-- Safe with the code deployed before this migration: it never reads the new
-- tables, and the new pending_mfa_challenges columns have defaults.
BEGIN;

CREATE TABLE IF NOT EXISTS owner_security (
  auth_user_id        uuid PRIMARY KEY,
  two_factor_required boolean NOT NULL DEFAULT true,
  lock_holder         text,
  lock_expires_at     timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS owner_recovery_codes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id uuid NOT NULL,
  code_hash    text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  used_at      timestamptz,
  UNIQUE (auth_user_id, code_hash)
);

ALTER TABLE owner_security ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE owner_security, owner_recovery_codes FROM PUBLIC;
REVOKE ALL ON TABLE owner_security, owner_recovery_codes FROM anon;
REVOKE ALL ON TABLE owner_security, owner_recovery_codes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE owner_security, owner_recovery_codes TO service_role;

ALTER TABLE pending_mfa_challenges ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';
ALTER TABLE pending_mfa_challenges ADD COLUMN IF NOT EXISTS enrolled boolean NOT NULL DEFAULT false;
ALTER TABLE pending_mfa_challenges ADD COLUMN IF NOT EXISTS recovered boolean NOT NULL DEFAULT false;
DO $purpose$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pending_mfa_challenges_purpose_check') THEN
    ALTER TABLE pending_mfa_challenges
      ADD CONSTRAINT pending_mfa_challenges_purpose_check CHECK (purpose IN ('login', 'enable', 'disable', 'codes'));
  END IF;
END;
$purpose$;

-- The identity's sign-in security state: whether two-step sign-in is on,
-- how many recovery codes it has (and how many are unused).
CREATE OR REPLACE FUNCTION owner_security_state(p_user uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'required', COALESCE((SELECT two_factor_required FROM owner_security WHERE auth_user_id = p_user), true),
    'codes_total', (SELECT count(*) FROM owner_recovery_codes WHERE auth_user_id = p_user),
    'codes_unused', (SELECT count(*) FROM owner_recovery_codes WHERE auth_user_id = p_user AND used_at IS NULL)
  );
$$;

-- Takes (or renews) the identity's security-change lock for p_holder.
-- Refused while another holder's lock is still current.
CREATE OR REPLACE FUNCTION owner_security_lock(p_user uuid, p_holder text, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v owner_security;
BEGIN
  IF p_holder IS NULL OR length(p_holder) = 0 OR p_seconds IS NULL OR p_seconds < 1 OR p_seconds > 1800 THEN
    RETURN false;
  END IF;
  INSERT INTO owner_security (auth_user_id) VALUES (p_user) ON CONFLICT (auth_user_id) DO NOTHING;
  SELECT * INTO v FROM owner_security WHERE auth_user_id = p_user FOR UPDATE;
  IF v.lock_holder IS NOT NULL AND v.lock_holder <> p_holder AND v.lock_expires_at > now() THEN
    RETURN false;
  END IF;
  UPDATE owner_security
     SET lock_holder = p_holder, lock_expires_at = now() + make_interval(secs => p_seconds)
   WHERE auth_user_id = p_user;
  RETURN true;
END;
$$;

-- Releases the lock if p_holder holds it (after a change failed part-way).
CREATE OR REPLACE FUNCTION owner_security_unlock(p_user uuid, p_holder text)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE owner_security SET lock_holder = NULL, lock_expires_at = NULL
   WHERE auth_user_id = p_user AND lock_holder = p_holder;
$$;

-- Completes a security change held by p_holder, in one transaction:
--   * p_required (NULL = unchanged) sets whether two-step sign-in is on;
--   * p_code_hashes (NULL = unchanged) replaces every recovery code;
--   * session_epoch increases, signing out every other device;
--   * the lock is released.
-- Returns the new session_epoch, or NULL (changing nothing) if p_holder
-- does not hold the lock or the identity has no owner membership.
CREATE OR REPLACE FUNCTION owner_security_finish(p_user uuid, p_holder text, p_required boolean, p_code_hashes text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v owner_security;
  v_epoch integer;
BEGIN
  SELECT * INTO v FROM owner_security WHERE auth_user_id = p_user FOR UPDATE;
  IF NOT FOUND OR v.lock_holder IS DISTINCT FROM p_holder OR p_holder IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_code_hashes IS NOT NULL AND (
       cardinality(p_code_hashes) > 20
       OR EXISTS (SELECT 1 FROM unnest(p_code_hashes) h WHERE h IS NULL OR h !~ '^[0-9a-f]{64}$')
       OR (SELECT count(DISTINCT h) FROM unnest(p_code_hashes) h) <> cardinality(p_code_hashes)) THEN
    RAISE EXCEPTION 'invalid recovery code hashes';
  END IF;

  UPDATE workspace_memberships SET session_epoch = session_epoch + 1
   WHERE profile_id = p_user AND role = 'owner'
  RETURNING session_epoch INTO v_epoch;
  IF v_epoch IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_code_hashes IS NOT NULL THEN
    DELETE FROM owner_recovery_codes WHERE auth_user_id = p_user;
    INSERT INTO owner_recovery_codes (auth_user_id, code_hash)
      SELECT p_user, h FROM unnest(p_code_hashes) h;
  END IF;
  UPDATE owner_security
     SET two_factor_required = COALESCE(p_required, two_factor_required),
         lock_holder = NULL, lock_expires_at = NULL, updated_at = now()
   WHERE auth_user_id = p_user;
  RETURN v_epoch;
END;
$$;

-- Marks one unused recovery code as used. True only for the single caller
-- that used it; a used, unknown, or concurrently used code returns false.
CREATE OR REPLACE FUNCTION owner_use_recovery_code(p_user uuid, p_code_hash text)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH used AS (
    UPDATE owner_recovery_codes SET used_at = now()
     WHERE auth_user_id = p_user AND code_hash = p_code_hash AND used_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM used);
$$;

DO $grants$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'owner_security_state(uuid)',
    'owner_security_lock(uuid, text, integer)',
    'owner_security_unlock(uuid, text)',
    'owner_security_finish(uuid, text, boolean, text[])',
    'owner_use_recovery_code(uuid, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$grants$;

COMMIT;
