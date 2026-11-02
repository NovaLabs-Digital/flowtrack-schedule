-- READ-ONLY POSTFLIGHT for migration 046 (Guided Demo Session chat). Run in
-- the Supabase SQL Editor AFTER applying 046. A single SELECT over system
-- catalogs: it cannot write, create, or delete anything, and reads no
-- business data. Send back the one result row.
--
-- VERDICT = MATCH means 046 was applied exactly as written:
--   * demo_sessions has chat_gen; demo_session_messages exists with the right
--     columns, row-level security on, a unique (session_id, client_msg_id),
--     and no access at all for anon or authenticated;
--   * demo_session_close and demo_session_claim have 046's bodies, and the
--     three new functions exist with 046's bodies and signatures (20 Guided
--     Demo Session functions in all); those five are SECURITY INVOKER with
--     search_path = public, and only service_role may EXECUTE them;
--   * every other Guided Demo Session function (042-044) is unchanged.
WITH expected_fn(proname, args, body_md5) AS (VALUES
    ('demo_session_close', 'p_session_id uuid, p_reason text', 'c33f2fc238ff4dd56613154307f201b8'),
    ('demo_session_claim', 'p_invite_hash text, p_visitor uuid, p_display_name text', '937451ebaa4a03a21058f5ab15d4e8db'),
    ('demo_session_message_json', 'm demo_session_messages', 'cfe8423f4d0b90c0e859479c16d81882'),
    ('demo_session_post_message', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_client_msg_id uuid, p_body text', 'dbb98c6c5d7a8c644920227389cc4bec'),
    ('demo_session_sync_chat', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_since bigint, p_cursor jsonb, p_chat_gen integer, p_chat_since bigint', 'cc4eeb7eebfa535baf25698339e5f5c6'),
    -- unchanged (042 / 043 / 044):
    ('demo_session_apply', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_gen bigint, p_base_version bigint, p_op_id uuid, p_new_state jsonb, p_response_status integer, p_response jsonb', '6c9e5dee487bca679ba5ee45569d9b4b'),
    ('demo_session_cleanup', '', 'fba65a55764fea920901ba701138ab5c'),
    ('demo_session_create', 'p_host uuid, p_state jsonb, p_invite_hash text', 'cc733792f95d50e81704565915d54e61'),
    ('demo_session_current', 'p_host uuid', '1c4046b6488dbea411448fed4a167f16'),
    ('demo_session_end', 'p_session_id uuid, p_host uuid', 'a1069ef75e10aa7a75a116c64d792da9'),
    ('demo_session_find_op', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_op_id uuid', '7581e1e0b0380342c4acca235afcd0ff'),
    ('demo_session_is_participant', 'v demo_sessions, p_role text, p_host uuid, p_visitor uuid, p_epoch integer', '374ae2ba48868b845c64cb066fa9e095'),
    ('demo_session_leave', 'p_session_id uuid, p_visitor uuid, p_epoch integer', '76fb7124d74b3611d2eb0e715fe1fbbf'),
    ('demo_session_lock', 'p_session_id uuid', '7904d7f17e2b5541e5b92d5b690393e3'),
    ('demo_session_put_view', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_gen bigint, p_base_view_version bigint, p_view jsonb', 'bd5a92bb0914b8f5d98dea42350fb695'),
    ('demo_session_reinvite', 'p_session_id uuid, p_host uuid, p_invite_hash text', '14e400aa914da0771c17eb7ccd958761'),
    ('demo_session_set_controller', 'p_session_id uuid, p_host uuid, p_to text', 'ea65894a792fe24afa2190c281434f3f'),
    ('demo_session_sync', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_since bigint', '248a51257d3a18de92aa656af02d884a'),
    ('demo_session_sync_cursor', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_since bigint, p_cursor jsonb', '36d701badb3ef4043e5685736998cabf'),
    ('demo_session_view', 'v demo_sessions', '3ebc91e0dfa3aa2fdebe33fb1c219507')
),
fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5,
         p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'demo\_session%'
),
changed_fn AS (
  SELECT * FROM fn WHERE proname IN ('demo_session_close', 'demo_session_claim', 'demo_session_message_json', 'demo_session_post_message', 'demo_session_sync_chat')
),
checks AS (
  SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
       AND (table_name, column_name, data_type, is_nullable) IN (
         ('demo_sessions', 'chat_gen', 'integer', 'NO'),
         ('demo_session_messages', 'id', 'bigint', 'NO'),
         ('demo_session_messages', 'session_id', 'uuid', 'NO'),
         ('demo_session_messages', 'sender_role', 'text', 'NO'),
         ('demo_session_messages', 'sender_name', 'text', 'NO'),
         ('demo_session_messages', 'body', 'text', 'NO'),
         ('demo_session_messages', 'client_msg_id', 'uuid', 'NO'),
         ('demo_session_messages', 'created_at', 'timestamp with time zone', 'NO'))) AS chat_columns_ok,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'demo_session_messages' AND c.relrowsecurity) AS table_with_rls,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'demo_session_messages'
        AND (has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
             OR has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))) AS table_exposed,
    (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.demo_session_messages'::regclass AND contype = 'u') AS duplicate_guard,
    (SELECT count(*) FROM fn) AS session_functions,
    (SELECT count(*) FROM fn JOIN expected_fn e USING (proname, args, body_md5)) AS functions_body_match,
    (SELECT string_agg(e.proname, ', ' ORDER BY e.proname) FROM expected_fn e
       WHERE NOT EXISTS (SELECT 1 FROM fn WHERE fn.proname = e.proname AND fn.args = e.args AND fn.body_md5 = e.body_md5)) AS mismatched_functions,
    (SELECT count(*) FROM changed_fn WHERE NOT prosecdef AND proconfig = ARRAY['search_path=public']) AS changed_invoker_search_path,
    (SELECT count(*) FROM changed_fn WHERE
       has_function_privilege('anon', changed_fn.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', changed_fn.oid, 'EXECUTE')
       OR proacl IS NULL
       OR EXISTS (SELECT 1 FROM aclexplode(changed_fn.proacl) a WHERE a.grantee = 0)) AS functions_exposed,
    (SELECT count(*) FROM changed_fn WHERE has_function_privilege('service_role', changed_fn.oid, 'EXECUTE')) AS functions_service_role_ok
)
SELECT
  CASE WHEN chat_columns_ok = 8 AND table_with_rls = 1 AND table_exposed = 0 AND duplicate_guard = 1
            AND session_functions = 20 AND functions_body_match = 20 AND mismatched_functions IS NULL
            AND changed_invoker_search_path = 5 AND functions_exposed = 0 AND functions_service_role_ok = 5
       THEN 'MATCH' ELSE 'STOP' END AS verdict,
  *
FROM checks;
