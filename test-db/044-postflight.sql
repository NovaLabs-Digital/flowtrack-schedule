-- READ-ONLY POSTFLIGHT for migration 044 (shared screen and cursors).
-- Run in the Supabase SQL Editor AFTER applying 044. A single SELECT over
-- system catalogs: it cannot write, create, or delete anything, and reads no
-- business data. Send back the one result row.
--
-- VERDICT = MATCH means 044 was applied exactly as written:
--   * demo_sessions has the four new columns with the right types;
--   * demo_session_view and demo_session_close have 044's bodies, and
--     demo_session_put_view and demo_session_sync_cursor exist with 044's
--     bodies and signatures (17 session functions in all);
--   * those four are SECURITY INVOKER with search_path = public, and only
--     service_role may EXECUTE them (not PUBLIC, anon, or authenticated);
--   * every other session function (042/043) is unchanged.
WITH expected_fn(proname, args, body_md5) AS (VALUES
    ('demo_session_view', 'v demo_sessions', '3ebc91e0dfa3aa2fdebe33fb1c219507'),
    ('demo_session_close', 'p_session_id uuid, p_reason text', '4eb46ada41412672fa14b0c8397d423b'),
    ('demo_session_put_view', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_gen bigint, p_base_view_version bigint, p_view jsonb', 'bd5a92bb0914b8f5d98dea42350fb695'),
    ('demo_session_sync_cursor', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_since bigint, p_cursor jsonb', '36d701badb3ef4043e5685736998cabf'),
    -- unchanged (042 / 043):
    ('demo_session_apply', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_gen bigint, p_base_version bigint, p_op_id uuid, p_new_state jsonb, p_response_status integer, p_response jsonb', '6c9e5dee487bca679ba5ee45569d9b4b'),
    ('demo_session_find_op', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_op_id uuid', '7581e1e0b0380342c4acca235afcd0ff'),
    ('demo_session_claim', 'p_invite_hash text, p_visitor uuid, p_display_name text', '538ad56deea2b6683c21bd811bb67ebd'),
    ('demo_session_cleanup', '', 'fba65a55764fea920901ba701138ab5c'),
    ('demo_session_create', 'p_host uuid, p_state jsonb, p_invite_hash text', 'cc733792f95d50e81704565915d54e61'),
    ('demo_session_current', 'p_host uuid', '1c4046b6488dbea411448fed4a167f16'),
    ('demo_session_end', 'p_session_id uuid, p_host uuid', 'a1069ef75e10aa7a75a116c64d792da9'),
    ('demo_session_is_participant', 'v demo_sessions, p_role text, p_host uuid, p_visitor uuid, p_epoch integer', '374ae2ba48868b845c64cb066fa9e095'),
    ('demo_session_leave', 'p_session_id uuid, p_visitor uuid, p_epoch integer', '76fb7124d74b3611d2eb0e715fe1fbbf'),
    ('demo_session_lock', 'p_session_id uuid', '7904d7f17e2b5541e5b92d5b690393e3'),
    ('demo_session_reinvite', 'p_session_id uuid, p_host uuid, p_invite_hash text', '14e400aa914da0771c17eb7ccd958761'),
    ('demo_session_set_controller', 'p_session_id uuid, p_host uuid, p_to text', 'ea65894a792fe24afa2190c281434f3f'),
    ('demo_session_sync', 'p_session_id uuid, p_role text, p_host uuid, p_visitor uuid, p_epoch integer, p_since bigint', '248a51257d3a18de92aa656af02d884a')
),
fn AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5,
         p.prosecdef, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'demo\_session%'
),
changed_fn AS (SELECT * FROM fn WHERE proname IN ('demo_session_view', 'demo_session_close', 'demo_session_put_view', 'demo_session_sync_cursor')),
checks AS (
  SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'demo_sessions'
       AND (column_name, data_type, is_nullable) IN (('view', 'jsonb', 'YES'), ('view_version', 'bigint', 'NO'), ('host_cursor', 'jsonb', 'YES'), ('visitor_cursor', 'jsonb', 'YES'))) AS new_columns_ok,
    (SELECT count(*) FROM fn) AS functions_present,
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
  CASE WHEN new_columns_ok = 4 AND functions_present = 17 AND functions_body_match = 17 AND mismatched_functions IS NULL
            AND changed_invoker_search_path = 4 AND functions_exposed = 0 AND functions_service_role_ok = 4
       THEN 'MATCH' ELSE 'STOP' END AS verdict,
  *
FROM checks;
