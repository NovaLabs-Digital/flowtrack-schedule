-- READ-ONLY PREFLIGHT for migration 046 (Guided Demo Session chat). Run in
-- the Supabase SQL Editor BEFORE applying 046. A single SELECT over system
-- catalogs: it cannot write, create, or delete anything, and reads no
-- business data. Send back the one result row.
--
-- VERDICT = READY means production is exactly where 046 expects it:
--   * migration 044 is in place: demo_session_close, demo_session_sync_cursor,
--     demo_session_view and demo_session_put_view have 044's bodies, and
--     demo_session_claim still has 042's; 17 Guided Demo Session functions;
--   * none of 046's column, table, or functions exist yet.
-- Anything else: stop.
WITH fn AS (
  SELECT p.proname, md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'demo\_session%'
),
checks AS (
  SELECT
    (SELECT count(*) FROM fn WHERE (proname, body_md5) IN (
       ('demo_session_close', '4eb46ada41412672fa14b0c8397d423b'),
       ('demo_session_sync_cursor', '36d701badb3ef4043e5685736998cabf'),
       ('demo_session_view', '3ebc91e0dfa3aa2fdebe33fb1c219507'),
       ('demo_session_put_view', 'bd5a92bb0914b8f5d98dea42350fb695'),
       ('demo_session_claim', '538ad56deea2b6683c21bd811bb67ebd'))) AS functions_at_044,
    (SELECT count(*) FROM fn) AS session_functions,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'demo_sessions' AND column_name = 'chat_gen') AS chat_column_present,
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'demo_session_messages') AS chat_table_present,
    (SELECT count(*) FROM fn WHERE proname IN ('demo_session_post_message', 'demo_session_sync_chat', 'demo_session_message_json')) AS chat_functions_present
)
SELECT
  CASE WHEN functions_at_044 = 5 AND session_functions = 17 AND chat_column_present = 0
            AND chat_table_present = 0 AND chat_functions_present = 0
       THEN 'READY' ELSE 'STOP' END AS verdict,
  *
FROM checks;
