-- 046: Guided Demo Sessions -- two-way chat between the host and the guest.
--
-- Plain-text messages, available to both participants for the whole live
-- session -- including while the guest is watch-only (chat never depends on
-- who controls the dashboard). Messages arrive on the existing once-a-second
-- check-in (about 1-2 seconds), so no new connection type is needed.
--
-- Rules, all enforced here under the session row lock (so they hold under
-- simultaneous requests):
--   * only the session's host or its current guest may send or read;
--   * nothing can be sent once the session has ended or expired;
--   * 1-500 characters per message, at most 5 messages per 10 seconds per
--     sender and 300 per conversation;
--   * a retried send (same client message id) returns the original message
--     instead of adding a second one.
--
-- Clearing: ending the session (End, expiry, host absence, replacement)
-- deletes its messages at once, and so does a replacement guest joining (a
-- guest who joins after an earlier guest starts with an empty chat). Each
-- clear increments chat_gen, telling both browsers to drop their copies and
-- start reading from the beginning again.
--
-- Changes from 044, nothing else:
--   * demo_sessions gains chat_gen; new table demo_session_messages;
--   * demo_session_close and demo_session_claim also clear the chat (same
--     signatures and results as before);
--   * new demo_session_post_message, and demo_session_sync_chat (044's
--     demo_session_sync_cursor plus new messages; the 044 function is left
--     unchanged for the code deployed before this migration).
BEGIN;

ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS chat_gen INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS demo_session_messages (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id    UUID NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
  sender_role   TEXT NOT NULL CHECK (sender_role IN ('host', 'visitor')),
  sender_name   TEXT NOT NULL CHECK (char_length(sender_name) BETWEEN 1 AND 40),
  body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  client_msg_id UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, client_msg_id)
);
CREATE INDEX IF NOT EXISTS idx_demo_session_messages_session ON demo_session_messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_demo_session_messages_rate ON demo_session_messages(session_id, sender_role, created_at);

ALTER TABLE demo_session_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE demo_session_messages FROM PUBLIC;
REVOKE ALL ON TABLE demo_session_messages FROM anon;
REVOKE ALL ON TABLE demo_session_messages FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE demo_session_messages TO service_role;

-- 044's close, plus: the conversation is deleted and both browsers told to
-- drop their copies.
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
      view = NULL, host_cursor = NULL, visitor_cursor = NULL, chat_gen = chat_gen + 1
  WHERE id = p_session_id AND status = 'live';
  DELETE FROM demo_session_ops WHERE session_id = p_session_id;
  DELETE FROM demo_session_messages WHERE session_id = p_session_id;
END;
$fn$;

-- 042's claim, plus: a replacement guest (anyone joining after an earlier
-- guest or invitation) starts with an empty chat.
CREATE OR REPLACE FUNCTION demo_session_claim(p_invite_hash TEXT, p_visitor UUID, p_display_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_id      UUID;
  v         demo_sessions;
  v_name    TEXT := NULLIF(btrim(p_display_name), '');
  v_replace BOOLEAN;
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
  v_replace := v.visitor_epoch > 0;
  UPDATE demo_sessions
  SET visitor_id = p_visitor, visitor_epoch = visitor_epoch + 1, visitor_display_name = v_name,
      visitor_joined_at = now(), visitor_last_seen_at = now(),
      invite_token_hash = NULL, invite_expires_at = NULL,
      chat_gen = CASE WHEN v_replace THEN chat_gen + 1 ELSE chat_gen END
  WHERE id = v.id
  RETURNING * INTO v;
  IF v_replace THEN
    DELETE FROM demo_session_messages WHERE session_id = v.id;
  END IF;
  RETURN jsonb_build_object('outcome', 'ok', 'visitor_epoch', v.visitor_epoch, 'session', demo_session_view(v));
END;
$fn$;

-- What a browser receives for one message.
CREATE OR REPLACE FUNCTION demo_session_message_json(m demo_session_messages)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'id', m.id, 'role', m.sender_role, 'name', m.sender_name, 'body', m.body,
    'at', m.created_at, 'clientId', m.client_msg_id
  );
$fn$;

-- Sends one message. Outcomes: ok (with the message; duplicate = true when
-- this client message id was already sent), invalid_input, unauthorized,
-- ended, rate_limited, chat_full.
CREATE OR REPLACE FUNCTION demo_session_post_message(
  p_session_id UUID, p_role TEXT, p_host UUID, p_visitor UUID, p_epoch INTEGER, p_client_msg_id UUID, p_body TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v      demo_sessions;
  v_body TEXT := btrim(p_body);
  m      demo_session_messages;
BEGIN
  IF p_client_msg_id IS NULL OR v_body IS NULL OR char_length(v_body) < 1 OR char_length(v_body) > 500 THEN
    RETURN jsonb_build_object('outcome', 'invalid_input');
  END IF;
  v := demo_session_lock(p_session_id);
  IF v.id IS NULL OR NOT demo_session_is_participant(v, p_role, p_host, p_visitor, p_epoch) THEN
    RETURN jsonb_build_object('outcome', 'unauthorized');
  END IF;
  IF v.status <> 'live' THEN
    RETURN jsonb_build_object('outcome', 'ended');
  END IF;
  SELECT * INTO m FROM demo_session_messages WHERE session_id = v.id AND client_msg_id = p_client_msg_id;
  IF FOUND THEN
    IF m.sender_role <> p_role THEN
      RETURN jsonb_build_object('outcome', 'invalid_input');
    END IF;
    RETURN jsonb_build_object('outcome', 'ok', 'duplicate', true, 'message', demo_session_message_json(m), 'chat_gen', v.chat_gen);
  END IF;
  IF (SELECT count(*) FROM demo_session_messages
      WHERE session_id = v.id AND sender_role = p_role AND created_at > now() - interval '10 seconds') >= 5 THEN
    RETURN jsonb_build_object('outcome', 'rate_limited');
  END IF;
  IF (SELECT count(*) FROM demo_session_messages WHERE session_id = v.id) >= 300 THEN
    RETURN jsonb_build_object('outcome', 'chat_full');
  END IF;
  INSERT INTO demo_session_messages (session_id, sender_role, sender_name, body, client_msg_id)
  VALUES (v.id, p_role,
          CASE WHEN p_role = 'host' THEN 'Alberto' ELSE COALESCE(v.visitor_display_name, 'Guest') END,
          v_body, p_client_msg_id)
  RETURNING * INTO m;
  RETURN jsonb_build_object('outcome', 'ok', 'duplicate', false, 'message', demo_session_message_json(m), 'chat_gen', v.chat_gen);
END;
$fn$;

-- 044's check-in plus the chat: messages after p_chat_since (from the start
-- when p_chat_gen is not the current chat_gen -- the conversation was
-- cleared), at most 200 at a time with more = true when others remain.
CREATE OR REPLACE FUNCTION demo_session_sync_chat(
  p_session_id UUID, p_role TEXT, p_host UUID, p_visitor UUID, p_epoch INTEGER, p_since BIGINT, p_cursor JSONB,
  p_chat_gen INTEGER, p_chat_since BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  r       JSONB;
  v_gen   INTEGER;
  v_since BIGINT;
  v_msgs  JSONB;
  v_count INTEGER;
BEGIN
  r := demo_session_sync_cursor(p_session_id, p_role, p_host, p_visitor, p_epoch, p_since, p_cursor);
  IF r->>'outcome' IS DISTINCT FROM 'ok' THEN
    RETURN r;
  END IF;
  SELECT chat_gen INTO v_gen FROM demo_sessions WHERE id = p_session_id;
  v_since := CASE WHEN p_chat_gen IS DISTINCT FROM v_gen OR p_chat_since IS NULL OR p_chat_since < 0 THEN 0 ELSE p_chat_since END;
  SELECT COALESCE(jsonb_agg(demo_session_message_json(m) ORDER BY m.id), '[]'::jsonb), count(*)
    INTO v_msgs, v_count
    FROM (SELECT * FROM demo_session_messages WHERE session_id = p_session_id AND id > v_since ORDER BY id LIMIT 201) m;
  IF v_count > 200 THEN
    v_msgs := v_msgs - 200;
  END IF;
  RETURN r || jsonb_build_object('chat', jsonb_build_object('gen', v_gen, 'messages', v_msgs, 'more', v_count > 200));
END;
$fn$;

DO $grants$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'demo_session_close(uuid, text)',
    'demo_session_claim(text, uuid, text)',
    'demo_session_message_json(demo_session_messages)',
    'demo_session_post_message(uuid, text, uuid, uuid, integer, uuid, text)',
    'demo_session_sync_chat(uuid, text, uuid, uuid, integer, bigint, jsonb, integer, bigint)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END;
$grants$;

COMMIT;
