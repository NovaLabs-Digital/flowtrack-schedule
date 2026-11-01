-- 044: Guided Demo Sessions -- shared screen and labelled cursors.
--
-- Both participants follow one shared view of the fictional demo: calendar
-- mode and date, selection, Settings section, the open dialog or edit form
-- and its draft, and the calendar's scroll position. The server computes
-- each change (lib/demoSession/sharedView.ts) and stores the result here by
-- compare-and-swap on view_version, so changes are applied one at a time in
-- a single order. The view holds only navigation and fictional form drafts --
-- never real business data -- and is cleared when the session ends.
--
-- Each participant's pointer position (relative to the part of the screen
-- it is over, so it lands in the same place at any window size) rides along
-- on the once-a-second check-in. The host's cursor is always shown to the
-- guest; the guest's only while guest control is allowed. A cursor older
-- than 5 seconds is not returned at all, so a disconnected participant's
-- cursor disappears.
--
-- Changes from 043, nothing else:
--   * demo_sessions gains `view`, `view_version`, `host_cursor`,
--     `visitor_cursor`;
--   * demo_session_view also returns view, view_version, and fresh cursors
--     (callers that don't know them ignore them);
--   * demo_session_close also clears the view and cursors;
--   * new demo_session_sync_cursor: demo_session_sync plus recording the
--     caller's cursor (the guest's only while guest control is allowed);
--   * new demo_session_put_view: the host may always change the view; the
--     guest only while guest control is allowed and with the current
--     control_gen (so Stop Guest Control also rejects a guest view change
--     already on its way).
-- Safe with the code deployed before this migration: it never reads or
-- writes the new columns.
BEGIN;

ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS view JSONB;
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS view_version BIGINT NOT NULL DEFAULT 0;
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS host_cursor JSONB;
ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS visitor_cursor JSONB;

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
    'host_online', v.host_last_seen_at >= now() - interval '20 seconds',
    'view', v.view,
    'view_version', v.view_version,
    'host_cursor', CASE WHEN (v.host_cursor->>'at')::timestamptz >= now() - interval '5 seconds' THEN v.host_cursor - 'at' END,
    'visitor_cursor', CASE WHEN v.controller = 'visitor' AND (v.visitor_cursor->>'at')::timestamptz >= now() - interval '5 seconds' THEN v.visitor_cursor - 'at' END
  );
$fn$;

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
      visitor_display_name = NULL, controller = 'host', control_gen = control_gen + 1,
      view = NULL, host_cursor = NULL, visitor_cursor = NULL
  WHERE id = p_session_id AND status = 'live';
  DELETE FROM demo_session_ops WHERE session_id = p_session_id;
END;
$fn$;

-- Stores a new shared view computed from view_version p_base_view_version.
CREATE OR REPLACE FUNCTION demo_session_put_view(
  p_session_id        UUID,
  p_role              TEXT,
  p_host              UUID,
  p_visitor           UUID,
  p_epoch             INTEGER,
  p_gen               BIGINT,
  p_base_view_version BIGINT,
  p_view              JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v demo_sessions;
BEGIN
  IF p_gen IS NULL OR p_base_view_version IS NULL OR p_view IS NULL
     OR jsonb_typeof(p_view) <> 'object' OR octet_length(p_view::text) > 65536 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, p_role, p_host, p_visitor, p_epoch) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended', 'session', demo_session_view(v));
  END IF;
  IF p_role = 'visitor' THEN
    IF v.controller <> 'visitor' THEN
      RETURN jsonb_build_object('outcome', 'not_controller', 'session', demo_session_view(v));
    END IF;
    IF p_gen <> v.control_gen THEN
      RETURN jsonb_build_object('outcome', 'stale_control', 'session', demo_session_view(v));
    END IF;
  END IF;
  IF p_base_view_version <> v.view_version THEN
    RETURN jsonb_build_object('outcome', 'stale_view', 'session', demo_session_view(v));
  END IF;
  UPDATE demo_sessions
  SET view = p_view, view_version = view_version + 1,
      host_last_seen_at = CASE WHEN p_role = 'host' THEN now() ELSE host_last_seen_at END,
      visitor_last_seen_at = CASE WHEN p_role = 'visitor' THEN now() ELSE visitor_last_seen_at END
  WHERE id = v.id
  RETURNING * INTO v;
  RETURN jsonb_build_object('outcome', 'ok', 'session', demo_session_view(v));
END;
$fn$;

-- The once-a-second check-in, also recording the caller's cursor: a small
-- object ({anchor, x, y}, fractions within the anchored part of the screen)
-- or NULL when the pointer is off the dashboard.
CREATE OR REPLACE FUNCTION demo_session_sync_cursor(
  p_session_id UUID, p_role TEXT, p_host UUID, p_visitor UUID, p_epoch INTEGER, p_since BIGINT, p_cursor JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v        demo_sessions;
  v_cursor JSONB;
BEGIN
  IF p_cursor IS NOT NULL AND (jsonb_typeof(p_cursor) <> 'object' OR octet_length(p_cursor::text) > 300) THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, p_role, p_host, p_visitor, p_epoch) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended', 'session', demo_session_view(v));
  END IF;
  v_cursor := CASE WHEN p_cursor IS NULL THEN NULL ELSE p_cursor || jsonb_build_object('at', now()) END;
  IF p_role = 'host' THEN
    UPDATE demo_sessions SET host_last_seen_at = now(), host_cursor = v_cursor WHERE id = v.id RETURNING * INTO v;
  ELSE
    -- The guest's cursor is only kept while guest control is allowed.
    UPDATE demo_sessions SET visitor_last_seen_at = now(),
      visitor_cursor = CASE WHEN controller = 'visitor' THEN v_cursor ELSE NULL END
    WHERE id = v.id RETURNING * INTO v;
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'ok',
    'session', demo_session_view(v),
    'state', CASE WHEN p_since IS NULL OR p_since < v.state_version THEN v.state ELSE NULL END
  );
END;
$fn$;

DO $grants$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'demo_session_view(demo_sessions)',
    'demo_session_close(uuid, text)',
    'demo_session_put_view(uuid, text, uuid, uuid, integer, bigint, bigint, jsonb)',
    'demo_session_sync_cursor(uuid, text, uuid, uuid, integer, bigint, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$grants$;

COMMIT;
