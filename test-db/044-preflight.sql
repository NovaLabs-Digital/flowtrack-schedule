-- READ-ONLY PREFLIGHT for migration 044 (shared screen and cursors).
-- Run in the Supabase SQL Editor BEFORE applying 044. A single SELECT over
-- system catalogs: it cannot write, create, or delete anything, and reads no
-- business data. Send back the one result row.
--
-- VERDICT = READY means production is exactly at migration 043 for what 044
-- touches: demo_session_apply has 043's body, demo_session_find_op exists,
-- demo_session_view and demo_session_close still have 042's bodies, none of
-- 044's columns or functions exist yet, and the two tables are present.
-- Anything else: stop.
WITH fn AS (
  SELECT p.proname, md5(regexp_replace(btrim(p.prosrc), '\s+', ' ', 'g')) AS body_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname LIKE 'demo\_session%'
),
checks AS (
  SELECT
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('demo_sessions', 'demo_session_ops')) AS tables_present,
    (SELECT count(*) FROM fn WHERE (proname, body_md5) IN (
       ('demo_session_apply', '6c9e5dee487bca679ba5ee45569d9b4b'),
       ('demo_session_find_op', '7581e1e0b0380342c4acca235afcd0ff'),
       ('demo_session_view', 'e8f28e7201c8913879d64c81b4f97875'),
       ('demo_session_close', '15b568f78535902f5623b85b205a957c'))) AS functions_at_043,
    (SELECT count(*) FROM fn) AS session_functions,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'demo_sessions'
        AND column_name IN ('view', 'view_version', 'host_cursor', 'visitor_cursor')) AS new_columns_present,
    (SELECT count(*) FROM fn WHERE proname IN ('demo_session_put_view', 'demo_session_sync_cursor')) AS new_functions_present
)
SELECT
  CASE WHEN tables_present = 2 AND functions_at_043 = 4 AND session_functions = 15
            AND new_columns_present = 0 AND new_functions_present = 0
       THEN 'READY' ELSE 'STOP' END AS verdict,
  *
FROM checks;
