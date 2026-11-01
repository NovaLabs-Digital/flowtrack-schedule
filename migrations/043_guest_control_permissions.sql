-- 043: Guided Demo Sessions -- the host can always edit; guest editing is a
-- permission the host turns on and off.
--
-- Migration 042 treated control as exclusive: only the current controller
-- could change data, and every change of control invalidated the previous
-- controller's pending requests. Now:
--   * the host's changes are always accepted (identity, lifecycle, the
--     compare-and-swap version check, and op_id idempotency still apply);
--   * the guest's changes are accepted only while guest editing is allowed
--     (controller = 'visitor') and only with the current control_gen, so
--     Stop Guest Control -- which increments control_gen -- rejects every
--     guest request already on its way, even if editing is allowed again.
-- The `controller` column keeps its values: 'visitor' now means "guest may
-- edit too", 'host' means "guest watches". Nothing else in 042 changes
-- (presence, the 20-second guest timeout, expiry, invitations, cleanup).
--
-- demo_session_find_op lets the server recognise a retried request (same
-- op_id) that already applied, before it reports an edit conflict.
--
-- Safe with the code deployed before this migration: that code only sends a
-- change from the participant who holds control, which 043 still accepts.
BEGIN;

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
  -- The host may always edit; the guest only while allowed, and only with
  -- the permission grant the request was made under.
  IF p_role = 'visitor' THEN
    IF v.controller <> 'visitor' THEN
      RETURN jsonb_build_object('outcome', 'not_controller', 'session', demo_session_view(v));
    END IF;
    IF p_gen <> v.control_gen THEN
      RETURN jsonb_build_object('outcome', 'stale_control', 'session', demo_session_view(v));
    END IF;
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

-- The recorded result of an op_id that already applied in this session, if
-- any. Same identity and lifecycle rules as every other session function.
CREATE OR REPLACE FUNCTION demo_session_find_op(
  p_session_id UUID, p_role TEXT, p_host UUID, p_visitor UUID, p_epoch INTEGER, p_op_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v  demo_sessions;
  op demo_session_ops;
BEGIN
  IF p_op_id IS NULL THEN
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
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'none', 'session', demo_session_view(v));
  END IF;
  RETURN jsonb_build_object('outcome', 'duplicate', 'session', demo_session_view(v),
    'result_version', op.result_version, 'response_status', op.response_status, 'response', op.response);
END;
$fn$;

DO $grants$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'demo_session_apply(uuid, text, uuid, uuid, integer, bigint, bigint, uuid, jsonb, integer, jsonb)',
    'demo_session_find_op(uuid, text, uuid, uuid, integer, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$grants$;

COMMIT;
