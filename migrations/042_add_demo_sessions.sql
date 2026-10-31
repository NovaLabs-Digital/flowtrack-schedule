-- 042: Guided Demo Sessions (milestone 1).
--
-- One host (Alberto, checked by the application against
-- DEMO_HOST_AUTH_USER_ID) shares a FRESH FICTIONAL demo dataset with one
-- visitor. This table holds only that fictional dataset and the session's
-- access/control bookkeeping -- never real business data -- and only the
-- server (service_role) can touch it. No existing table or row is changed.
--
-- Rules enforced here, under a row lock, on every call:
--   * identity: the host's auth user id, or the visitor's id + epoch;
--   * lifecycle: a session ends 2 hours after creation, or when the host
--     has not been seen for 5 minutes; a visitor in control who has not been
--     seen for 20 seconds loses control to the host;
--   * control: only the current controller may change data, and only with
--     the current control_gen (every change of control increments it, so a
--     delayed request from a previous controller can never apply);
--   * versions: a change must be based on the current state_version
--     (compare-and-swap), and each op_id applies at most once.
-- Ending a session clears the dataset, invitation and display name at once;
-- demo_session_cleanup (daily cron) deletes ended rows after 7 days.
BEGIN;

CREATE TABLE IF NOT EXISTS demo_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_auth_user_id     UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
  end_reason            TEXT CHECK (end_reason IN ('host_ended', 'expired', 'host_absent', 'replaced')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  invite_token_hash     TEXT,
  invite_expires_at     TIMESTAMPTZ,
  visitor_id            UUID,
  visitor_epoch         INTEGER NOT NULL DEFAULT 0,
  visitor_display_name  TEXT CHECK (visitor_display_name IS NULL OR char_length(visitor_display_name) BETWEEN 1 AND 40),
  visitor_joined_at     TIMESTAMPTZ,
  visitor_last_seen_at  TIMESTAMPTZ,
  host_last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  controller            TEXT NOT NULL DEFAULT 'host' CHECK (controller IN ('host', 'visitor')),
  control_gen           BIGINT NOT NULL DEFAULT 1,
  state                 JSONB,
  state_version         BIGINT NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS demo_sessions_invite_token_hash_key
  ON demo_sessions (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS demo_sessions_host_status_idx ON demo_sessions (host_auth_user_id, status);
CREATE INDEX IF NOT EXISTS demo_sessions_status_ended_idx ON demo_sessions (status, ended_at);

-- One row per applied change, so a retried request (same op_id) is answered
-- with its original result instead of applying twice.
CREATE TABLE IF NOT EXISTS demo_session_ops (
  session_id      UUID NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  op_id           UUID NOT NULL,
  result_version  BIGINT NOT NULL,
  response_status INTEGER NOT NULL,
  response        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, op_id)
);

ALTER TABLE demo_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_session_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE demo_sessions, demo_session_ops FROM PUBLIC;
REVOKE ALL ON TABLE demo_sessions, demo_session_ops FROM anon;
REVOKE ALL ON TABLE demo_sessions, demo_session_ops FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE demo_sessions, demo_session_ops TO service_role;

-- ---------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------

-- Ends a session and clears everything it held. Bumps control_gen so no
-- earlier authority survives.
CREATE OR REPLACE FUNCTION demo_session_close(p_session_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  UPDATE demo_sessions
  SET status = 'ended', end_reason = p_reason, ended_at = now(),
      state = NULL, invite_token_hash = NULL, invite_expires_at = NULL,
      visitor_display_name = NULL, controller = 'host', control_gen = control_gen + 1
  WHERE id = p_session_id AND status = 'live';
  DELETE FROM demo_session_ops WHERE session_id = p_session_id;
END;
$fn$;

-- Locks one session row and applies time-based lifecycle rules first, so
-- every caller sees (and acts on) the session as it stands right now.
CREATE OR REPLACE FUNCTION demo_session_lock(p_session_id UUID)
RETURNS demo_sessions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  SELECT * INTO v FROM demo_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v.status = 'live' AND now() >= v.expires_at THEN
    PERFORM demo_session_close(v.id, 'expired');
  ELSIF v.status = 'live' AND v.host_last_seen_at < now() - interval '5 minutes' THEN
    PERFORM demo_session_close(v.id, 'host_absent');
  ELSIF v.status = 'live' AND v.controller = 'visitor'
        AND (v.visitor_last_seen_at IS NULL OR v.visitor_last_seen_at < now() - interval '20 seconds') THEN
    UPDATE demo_sessions SET controller = 'host', control_gen = control_gen + 1 WHERE id = v.id;
  END IF;
  SELECT * INTO v FROM demo_sessions WHERE id = p_session_id;
  RETURN v;
END;
$fn$;

-- What the browser is allowed to know about a session (never the token hash
-- or the other participant's identifiers).
CREATE OR REPLACE FUNCTION demo_session_view(v demo_sessions)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'id', v.id,
    'status', v.status,
    'end_reason', v.end_reason,
    'expires_at', v.expires_at,
    'controller', v.controller,
    'control_gen', v.control_gen,
    'state_version', v.state_version,
    'invite_pending', v.invite_token_hash IS NOT NULL AND v.invite_expires_at > now(),
    'invite_expires_at', v.invite_expires_at,
    'visitor_joined', v.visitor_id IS NOT NULL,
    'visitor_online', v.visitor_last_seen_at IS NOT NULL AND v.visitor_last_seen_at >= now() - interval '20 seconds',
    'visitor_display_name', v.visitor_display_name,
    'host_online', v.host_last_seen_at >= now() - interval '20 seconds'
  );
$fn$;

-- True when the caller is the session's host or its current visitor.
CREATE OR REPLACE FUNCTION demo_session_is_participant(
  v demo_sessions, p_role TEXT, p_host UUID, p_visitor UUID, p_epoch INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(
    (p_role = 'host' AND p_host IS NOT NULL AND v.host_auth_user_id = p_host)
    OR (p_role = 'visitor' AND p_visitor IS NOT NULL AND v.visitor_id = p_visitor AND v.visitor_epoch = p_epoch),
    false);
$fn$;

-- ---------------------------------------------------------------------
-- Host actions
-- ---------------------------------------------------------------------

-- Starts a session with a fresh fictional dataset and a 30-minute
-- invitation. Any earlier live session of this host is ended first.
CREATE OR REPLACE FUNCTION demo_session_create(p_host UUID, p_state JSONB, p_invite_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
  r RECORD;
BEGIN
  IF p_host IS NULL OR p_state IS NULL OR jsonb_typeof(p_state) <> 'object'
     OR p_invite_hash IS NULL OR length(p_invite_hash) < 32 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  FOR r IN SELECT id FROM demo_sessions WHERE host_auth_user_id = p_host AND status = 'live' FOR UPDATE LOOP
    PERFORM demo_session_close(r.id, 'replaced');
  END LOOP;
  INSERT INTO demo_sessions (host_auth_user_id, expires_at, invite_token_hash, invite_expires_at, state)
  VALUES (p_host, now() + interval '2 hours', p_invite_hash, now() + interval '30 minutes', p_state)
  RETURNING * INTO v;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

-- Issues a new invitation. Any previous visitor loses access (epoch bump)
-- and, if they were in control, control returns to the host.
CREATE OR REPLACE FUNCTION demo_session_reinvite(p_session_id UUID, p_host UUID, p_invite_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  IF p_invite_hash IS NULL OR length(p_invite_hash) < 32 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, 'host', p_host, NULL, NULL) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended', 'session', demo_session_view(v));
  END IF;
  UPDATE demo_sessions
  SET invite_token_hash = p_invite_hash,
      invite_expires_at = LEAST(now() + interval '30 minutes', expires_at),
      visitor_id = NULL, visitor_epoch = visitor_epoch + 1, visitor_display_name = NULL,
      visitor_joined_at = NULL, visitor_last_seen_at = NULL,
      control_gen = CASE WHEN controller = 'visitor' THEN control_gen + 1 ELSE control_gen END,
      controller = 'host'
  WHERE id = v.id
  RETURNING * INTO v;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

-- Gives control to the visitor or takes it back. Every actual change of
-- control increments control_gen, invalidating the previous controller's
-- pending requests.
CREATE OR REPLACE FUNCTION demo_session_set_controller(p_session_id UUID, p_host UUID, p_to TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  IF p_to IS NULL OR p_to NOT IN ('host', 'visitor') THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, 'host', p_host, NULL, NULL) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended', 'session', demo_session_view(v));
  END IF;
  IF p_to = 'visitor' AND (v.visitor_id IS NULL OR v.visitor_last_seen_at IS NULL
                           OR v.visitor_last_seen_at < now() - interval '20 seconds') THEN
    RETURN jsonb_build_object('outcome', 'visitor_unavailable', 'session', demo_session_view(v));
  END IF;
  IF v.controller <> p_to THEN
    UPDATE demo_sessions SET controller = p_to, control_gen = control_gen + 1, host_last_seen_at = now()
    WHERE id = v.id RETURNING * INTO v;
  END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

-- The host's current live session, if any (for Resume Session).
CREATE OR REPLACE FUNCTION demo_session_current(p_host UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_id UUID;
  v    demo_sessions;
BEGIN
  IF p_host IS NULL THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  SELECT id INTO v_id FROM demo_sessions
  WHERE host_auth_user_id = p_host AND status = 'live'
  ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'none');
  END IF;
  v := demo_session_lock(v_id);
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'none');
  END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

CREATE OR REPLACE FUNCTION demo_session_end(p_session_id UUID, p_host UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, 'host', p_host, NULL, NULL) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status = 'live' THEN
    PERFORM demo_session_close(v.id, 'host_ended');
  END IF;
  SELECT * INTO v FROM demo_sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

-- ---------------------------------------------------------------------
-- Visitor actions
-- ---------------------------------------------------------------------

-- Claims a single-use invitation. Every failure (unknown, used, expired,
-- session ended) is the same 'invite_unavailable' answer.
CREATE OR REPLACE FUNCTION demo_session_claim(p_invite_hash TEXT, p_visitor UUID, p_display_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_id   UUID;
  v      demo_sessions;
  v_name TEXT := NULLIF(btrim(p_display_name), '');
BEGIN
  IF p_invite_hash IS NULL OR p_visitor IS NULL OR (v_name IS NOT NULL AND char_length(v_name) > 40) THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  SELECT id INTO v_id FROM demo_sessions WHERE invite_token_hash = p_invite_hash;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'invite_unavailable');
  END IF;
  v := demo_session_lock(v_id);
  IF v.status <> 'live' OR v.invite_token_hash IS DISTINCT FROM p_invite_hash
     OR v.invite_expires_at <= now() OR v.visitor_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'invite_unavailable');
  END IF;
  UPDATE demo_sessions
  SET visitor_id = p_visitor, visitor_epoch = visitor_epoch + 1, visitor_display_name = v_name,
      visitor_joined_at = now(), visitor_last_seen_at = now(),
      invite_token_hash = NULL, invite_expires_at = NULL
  WHERE id = v.id
  RETURNING * INTO v;
  RETURN jsonb_build_object('outcome', 'ok', 'visitor_epoch', v.visitor_epoch, 'session', demo_session_view(v));
END;
$fn$;

-- The visitor leaves: control (if theirs) returns to the host at once.
CREATE OR REPLACE FUNCTION demo_session_leave(p_session_id UUID, p_visitor UUID, p_epoch INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, 'visitor', NULL, p_visitor, p_epoch) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status = 'live' THEN
    UPDATE demo_sessions
    SET visitor_last_seen_at = NULL,
        control_gen = CASE WHEN controller = 'visitor' THEN control_gen + 1 ELSE control_gen END,
        controller = 'host'
    WHERE id = v.id RETURNING * INTO v;
  END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

-- ---------------------------------------------------------------------
-- Both participants
-- ---------------------------------------------------------------------

-- Polling: records the caller as present and returns the session, plus the
-- dataset when it is newer than `p_since`.
CREATE OR REPLACE FUNCTION demo_session_sync(
  p_session_id UUID, p_role TEXT, p_host UUID, p_visitor UUID, p_epoch INTEGER, p_since BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, p_role, p_host, p_visitor, p_epoch) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended', 'session', demo_session_view(v));
  END IF;
  IF p_role = 'host' THEN
    UPDATE demo_sessions SET host_last_seen_at = now() WHERE id = v.id RETURNING * INTO v;
  ELSE
    UPDATE demo_sessions SET visitor_last_seen_at = now() WHERE id = v.id RETURNING * INTO v;
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'ok',
    'session', demo_session_view(v),
    'state', CASE WHEN p_since IS NULL OR p_since < v.state_version THEN v.state ELSE NULL END
  );
END;
$fn$;

-- Applies one data change computed by the server from the dataset at
-- p_base_version. Order of checks: identity, lifecycle, retry (an op that
-- already applied returns its original result), controller, control_gen,
-- version. Any failure writes nothing.
CREATE OR REPLACE FUNCTION demo_session_apply(
  p_session_id      UUID,
  p_role            TEXT,
  p_host            UUID,
  p_visitor         UUID,
  p_epoch           INTEGER,
  p_gen             BIGINT,
  p_base_version    BIGINT,
  p_op_id           UUID,
  p_new_state       JSONB,
  p_response_status INTEGER,
  p_response        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v   demo_sessions;
  op  demo_session_ops;
BEGIN
  IF p_op_id IS NULL OR p_gen IS NULL OR p_base_version IS NULL OR p_new_state IS NULL
     OR jsonb_typeof(p_new_state) <> 'object' OR octet_length(p_new_state::text) > 2000000 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, p_role, p_host, p_visitor, p_epoch) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended', 'session', demo_session_view(v));
  END IF;
  SELECT * INTO op FROM demo_session_ops WHERE session_id = v.id AND op_id = p_op_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'duplicate', 'session', demo_session_view(v),
      'result_version', op.result_version, 'response_status', op.response_status, 'response', op.response);
  END IF;
  IF v.controller <> p_role THEN
    RETURN jsonb_build_object('outcome', 'not_controller', 'session', demo_session_view(v));
  END IF;
  IF p_gen <> v.control_gen THEN
    RETURN jsonb_build_object('outcome', 'stale_control', 'session', demo_session_view(v));
  END IF;
  IF p_base_version <> v.state_version THEN
    RETURN jsonb_build_object('outcome', 'stale_version', 'session', demo_session_view(v));
  END IF;
  UPDATE demo_sessions
  SET state = p_new_state, state_version = state_version + 1,
      host_last_seen_at = CASE WHEN p_role = 'host' THEN now() ELSE host_last_seen_at END,
      visitor_last_seen_at = CASE WHEN p_role = 'visitor' THEN now() ELSE visitor_last_seen_at END
  WHERE id = v.id
  RETURNING * INTO v;
  INSERT INTO demo_session_ops (session_id, op_id, result_version, response_status, response)
  VALUES (v.id, p_op_id, v.state_version, p_response_status, p_response);
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v), 'state', v.state);
END;
$fn$;

-- ---------------------------------------------------------------------
-- Cleanup (daily cron)
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION demo_session_cleanup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  r       RECORD;
  v_ended INTEGER := 0;
  v_purged INTEGER;
BEGIN
  FOR r IN SELECT id FROM demo_sessions
           WHERE status = 'live' AND (expires_at <= now() OR host_last_seen_at < now() - interval '5 minutes') LOOP
    PERFORM demo_session_lock(r.id);
    v_ended := v_ended + 1;
  END LOOP;
  DELETE FROM demo_sessions WHERE status = 'ended' AND ended_at < now() - interval '7 days';
  GET DIAGNOSTICS v_purged = ROW_COUNT;
  RETURN jsonb_build_object('outcome', 'ok', 'ended', v_ended, 'purged', v_purged);
END;
$fn$;

DO $grants$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'demo_session_close(uuid, text)',
    'demo_session_lock(uuid)',
    'demo_session_view(demo_sessions)',
    'demo_session_is_participant(demo_sessions, text, uuid, uuid, integer)',
    'demo_session_create(uuid, jsonb, text)',
    'demo_session_reinvite(uuid, uuid, text)',
    'demo_session_set_controller(uuid, uuid, text)',
    'demo_session_current(uuid)',
    'demo_session_end(uuid, uuid)',
    'demo_session_claim(text, uuid, text)',
    'demo_session_leave(uuid, uuid, integer)',
    'demo_session_sync(uuid, text, uuid, uuid, integer, bigint)',
    'demo_session_apply(uuid, text, uuid, uuid, integer, bigint, bigint, uuid, jsonb, integer, jsonb)',
    'demo_session_cleanup()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$grants$;

COMMIT;
