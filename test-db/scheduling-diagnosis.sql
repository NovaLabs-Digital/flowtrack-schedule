-- READ-ONLY production diagnosis for the scheduling issues reported
-- 2026-11-11. Workspace: 3c7d1b2b-9d99-4eb5-80d3-5072ecd56d7a (the current
-- Alberto Cleaning Services workspace) and nothing else.
--
-- Run ONCE in the Supabase SQL Editor and export the result as CSV. It is a
-- single SELECT: it cannot write, send or change anything. It returns only
-- identifiers (first 8 characters of an id), dates/times (New York), statuses
-- and counts -- no client names, contact details, notes, addresses or message
-- text. Clients listed in `reported` below are shown only by their short tag.
--
-- Columns: grp | chk | client | series | appt | at_et | detail
--
-- grp 1  REPAIR CANDIDATES FOR OWNER REVIEW -- patterns that match a known
--        defect. None is a confirmed error: each row carries a proposed
--        change that Alberto accepts or rejects per row.
--   C1 likely_moved_twice  Inferred: a "This & future" move to a later time
--                       may have moved the edited visit a second time. The
--                       visit is exactly as far past the later visits as they
--                       are from the visit before it (same clock period). An
--                       intentional one-off move of that exact size looks the
--                       same. Proposed: the later visits' clock time and
--                       length on its own date.
--   C2 likely_not_carried  Inferred: a "This & future" edit that stopped after the edited
--                       visit (e.g. a deactivated cleaner): the series was put
--                       on hold by an edit (single-visit moves never do that)
--                       and every later visit is still at the earlier visits'
--                       time. Proposed: each later visit at the edited
--                       visit's clock time and length (one row per visit).
--   C3 owner_reported   Same as C2 for a reported client, on the owner's report that
--                       he chose "This and all future" (no hold required).
--   C4 stale_reminder   A visit more than 25 hours away already marked as
--                       reminded: the flag belongs to an earlier time, so it
--                       would NOT be reminded at its current time. Proposed:
--                       clear the reminder flag.
--   C5 held_series      Series left on hold by an edit (confirmed before, no
--                       recorded reason): never topped up until re-confirmed.
--                       Proposed: re-confirm in Settings -> Recurring Series
--                       AFTER fixing its C1/C2 rows; "blocked by" lists what
--                       would still stop re-confirmation.
-- grp 2  POSSIBLE INTENTIONAL EXCEPTIONS -- every other upcoming visit whose
--        clock time differs from the visits after it. Could be a deliberate
--        one-off move, an older daylight-saving shift, or a defect: Alberto
--        decides per row. No change proposed.
-- grp 3  JANUARY GAP -- per series still running: last generated visit,
--        Dec/Jan visits that exist, Jan visits its own rule implies after
--        that, and why it has not been topped up (status, last top-up).
-- grp 4  SUMMARY -- counts.
-- grp 0  REPORTED CLIENTS -- every visit Nov 1 - Mar 31, their series, and
--        message delivery records (kind, channel, accepted/failed, time).
WITH
ws AS (SELECT '3c7d1b2b-9d99-4eb5-80d3-5072ecd56d7a'::uuid AS id),
z  AS (SELECT 'America/New_York'::text AS tz),
-- Clients the owner reported by name: (name pattern, short tag). Only the tag
-- is ever returned. Empty here; the run-ready copy fills it in.
reported(pattern, tag) AS (SELECT NULL::text, NULL::text WHERE false),
cl AS (
  SELECT c.id, left(c.id::text, 8) AS ref,
         (SELECT r.tag FROM reported r WHERE c.name ILIKE r.pattern ORDER BY r.tag LIMIT 1) AS tag
  FROM clients c, ws WHERE c.workspace_id = ws.id AND c.is_demo = false
),
ser AS (SELECT s.* FROM recurring_series s, ws WHERE s.workspace_id = ws.id AND s.is_demo = false),
held AS (SELECT id FROM ser WHERE status = 'review_required' AND reviewed_at IS NOT NULL AND review_reason IS NULL),
appt AS (
  SELECT a.*,
         a.scheduled_for AT TIME ZONE (SELECT tz FROM z) AS loc,
         a.scheduled_end AT TIME ZONE (SELECT tz FROM z) AS loc_end,
         (a.scheduled_for AT TIME ZONE (SELECT tz FROM z)) - (a.scheduled_for AT TIME ZONE 'UTC') AS utc_off,
         (SELECT count(*) FROM appointment_employees ae WHERE ae.appointment_id = a.id) AS staff,
         (SELECT count(*) FROM appointment_employees ae JOIN employees e ON e.id = ae.employee_id
           WHERE ae.appointment_id = a.id AND e.active IS NOT TRUE) AS staff_inactive
  FROM appointments a, ws WHERE a.workspace_id = ws.id AND a.is_demo = false
),
-- Scheduled visits of each series in time order (past ones too: the visit
-- before an edited one shows the time the series had).
seq AS (
  SELECT a.id, a.series_id, a.client_id, a.scheduled_for, a.loc, a.loc_end, a.utc_off, a.staff, a.staff_inactive,
         a.loc::time AS clock, a.scheduled_end - a.scheduled_for AS len,
         lag(a.loc::time) OVER w AS prev_clock, lag(a.utc_off) OVER w AS prev_off,
         lead(a.loc::time) OVER w AS next_clock, lead(a.scheduled_end - a.scheduled_for) OVER w AS next_len
  FROM appt a
  WHERE a.status = 'scheduled' AND a.series_id IS NOT NULL
  WINDOW w AS (PARTITION BY a.series_id ORDER BY a.scheduled_for, a.id)
),
-- Upcoming visits whose clock differs from the next visit while every later
-- visit agrees with that next one.
lone AS (
  SELECT q.*,
         round(extract(epoch FROM (q.clock - q.next_clock)) / 60)::int AS off_next,
         CASE WHEN q.prev_off = q.utc_off THEN round(extract(epoch FROM (q.next_clock - q.prev_clock)) / 60)::int END AS later_moved,
         q.series_id IN (SELECT id FROM held) AS is_held,
         (SELECT count(*) FROM seq x WHERE x.series_id = q.series_id AND x.scheduled_for > q.scheduled_for) AS later_ct
  FROM seq q
  WHERE q.scheduled_for >= now() AND q.next_clock IS NOT NULL AND q.clock <> q.next_clock
    AND NOT EXISTS (SELECT 1 FROM seq x WHERE x.series_id = q.series_id AND x.scheduled_for > q.scheduled_for AND x.clock <> q.next_clock)
),
classified AS (
  SELECT l.*, c.tag,
         CASE
           WHEN l.later_moved IS NOT NULL AND l.later_moved > 0 AND l.off_next = l.later_moved THEN 'C1'
           WHEN c.tag IS NOT NULL THEN 'C3'
           WHEN l.is_held AND l.later_moved = 0 THEN 'C2'
           ELSE 'X'
         END AS cls
  FROM lone l JOIN cl c ON c.id = l.client_id
),
out AS (
  -- ---------------------------------------------------------- 1 C1
  SELECT 1 AS grp, 'C1 likely_moved_twice' AS chk, c.ref AS client, left(k.series_id::text, 8) AS series, left(k.id::text, 8) AS appt,
         to_char(k.loc, 'Dy YYYY-MM-DD HH24:MI') || '-' || to_char(k.loc_end, 'HH24:MI') AS at_et,
         concat_ws(' | ',
           'later visits at ' || to_char(k.next_clock, 'HH24:MI') || ' (moved ' || k.later_moved || ' min)',
           'this visit ' || k.off_next || ' min past them',
           'PROPOSED ' || to_char(k.loc::date + k.next_clock, 'HH24:MI') || '-' || to_char(k.loc::date + k.next_clock + k.next_len, 'HH24:MI'),
           'series ' || (SELECT status FROM ser WHERE id = k.series_id) || CASE WHEN k.is_held THEN ' (held by edit)' ELSE '' END
         ) AS detail,
         k.scheduled_for AS sort_at
  FROM classified k JOIN cl c ON c.id = k.client_id
  WHERE k.cls = 'C1'
  UNION ALL
  -- ---------------------------------------------------------- 1 C2 / C3: one row per later visit
  SELECT 1, CASE k.cls WHEN 'C2' THEN 'C2 likely_not_carried' ELSE 'C3 owner_reported ' || k.tag END,
         c.ref, left(x.series_id::text, 8), left(x.id::text, 8),
         to_char(x.loc, 'Dy YYYY-MM-DD HH24:MI') || '-' || to_char(x.loc_end, 'HH24:MI'),
         concat_ws(' | ',
           'edited visit ' || left(k.id::text, 8) || ' ' || to_char(k.loc, 'MM-DD HH24:MI') || '-' || to_char(k.loc_end, 'HH24:MI'),
           'PROPOSED ' || to_char(x.loc::date + k.clock, 'HH24:MI') || '-' || to_char(x.loc::date + k.clock + k.len, 'HH24:MI'),
           'staff ' || x.staff || ' (inactive ' || x.staff_inactive || ')',
           'series ' || (SELECT status FROM ser WHERE id = x.series_id) || CASE WHEN k.is_held THEN ' (held by edit)' ELSE '' END
         ),
         x.scheduled_for
  FROM classified k
  JOIN cl c ON c.id = k.client_id
  JOIN seq x ON x.series_id = k.series_id AND x.scheduled_for > k.scheduled_for
  WHERE k.cls IN ('C2', 'C3')
  UNION ALL
  -- ---------------------------------------------------------- 1 C4
  SELECT 1, 'C4 stale_reminder', c.ref, coalesce(left(a.series_id::text, 8), '-'), left(a.id::text, 8),
         to_char(a.loc, 'Dy YYYY-MM-DD HH24:MI'),
         concat_ws(' | ',
           'marked reminded ' || to_char(a.reminder_24h_sent_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD HH24:MI'),
           'PROPOSED clear the reminder flag'),
         a.scheduled_for
  FROM appt a JOIN cl c ON c.id = a.client_id
  WHERE a.status = 'scheduled' AND a.reminder_24h_sent_at IS NOT NULL AND a.scheduled_for > now() + interval '25 hours'
  UNION ALL
  -- ---------------------------------------------------------- 1 C5
  SELECT 1, 'C5 held_series', c.ref, left(s.id::text, 8), coalesce(left(s.template_appointment_id::text, 8), '-'),
         to_char(s.updated_at AT TIME ZONE (SELECT tz FROM z), 'Dy YYYY-MM-DD HH24:MI'),
         concat_ws(' | ',
           'held since (last change) above; confirmed ' || to_char(s.reviewed_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD'),
           s.frequency_type || coalesce(' /' || s.repeat_weeks || 'w', '') || coalesce(' /' || s.repeat_months || 'm', '') || ' at ' || to_char(s.anchor_local_time, 'HH24:MI'),
           'upcoming ' || (SELECT count(*) FROM seq x WHERE x.series_id = s.id AND x.scheduled_for >= now())
             || ' to ' || coalesce((SELECT to_char(max(x.loc), 'YYYY-MM-DD') FROM seq x WHERE x.series_id = s.id), '-'),
           'blocked by: ' || coalesce(nullif(concat_ws(', ',
             CASE WHEN EXISTS (SELECT 1 FROM classified k WHERE k.series_id = s.id AND k.cls IN ('C1', 'C2', 'C3')) THEN 'C1/C2/C3 rows' END,
             CASE WHEN EXISTS (SELECT 1 FROM classified k WHERE k.series_id = s.id AND k.cls = 'X') THEN 'a grp-2 row' END,
             CASE WHEN EXISTS (SELECT 1 FROM seq x WHERE x.series_id = s.id AND x.scheduled_for >= now() AND x.staff_inactive > 0) THEN 'inactive staff on upcoming visits' END,
             CASE WHEN (SELECT count(DISTINCT x.clock) FROM seq x WHERE x.series_id = s.id AND x.scheduled_for >= now()) > 1 THEN 'mixed clock times upcoming' END
           ), ''), 'nothing found')
         ),
         s.updated_at
  FROM ser s JOIN held h ON h.id = s.id JOIN cl c ON c.id = s.client_id
  UNION ALL
  -- ---------------------------------------------------------- 2 possible exceptions
  SELECT 2, 'X possible_exception', c.ref, left(k.series_id::text, 8), left(k.id::text, 8),
         to_char(k.loc, 'Dy YYYY-MM-DD HH24:MI') || '-' || to_char(k.loc_end, 'HH24:MI'),
         concat_ws(' | ',
           'later visits (' || k.later_ct || ') at ' || to_char(k.next_clock, 'HH24:MI'),
           'this visit ' || k.off_next || ' min from them',
           'visit before at ' || coalesce(to_char(k.prev_clock, 'HH24:MI'), '-') || CASE WHEN k.prev_off IS DISTINCT FROM k.utc_off THEN ' (other clock period)' ELSE '' END,
           'staff ' || k.staff || ' (inactive ' || k.staff_inactive || ')',
           'series ' || (SELECT status FROM ser WHERE id = k.series_id) || CASE WHEN k.is_held THEN ' (held by edit)' ELSE '' END
         ),
         k.scheduled_for
  FROM classified k JOIN cl c ON c.id = k.client_id
  WHERE k.cls = 'X'
  UNION ALL
  -- ---------------------------------------------------------- 3 January gap
  SELECT 3, 'J jan_gap', c.ref, left(g.id::text, 8), '-', to_char(g.last_loc, 'Dy YYYY-MM-DD HH24:MI'),
         concat_ws(' | ',
           'last generated visit (left)',
           g.status || CASE WHEN g.id IN (SELECT id FROM held) THEN ' (held by edit)' WHEN g.status = 'review_required' THEN ' (never confirmed / held)' ELSE '' END,
           g.frequency_type || coalesce(' /' || g.repeat_weeks || 'w', '') || coalesce(' /' || g.repeat_months || 'm', ''),
           'dec ' || g.dec_rows, 'jan ' || g.jan_rows, 'jan implied ' || g.jan_implied,
           'created ' || to_char(g.created_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD'),
           'last top-up ' || coalesce(to_char(g.last_replenished_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD'), 'never'),
           CASE WHEN EXISTS (SELECT 1 FROM appt o WHERE o.client_id = g.client_id AND o.series_id IS DISTINCT FROM g.id
                             AND o.loc >= '2027-01-01' AND o.loc < '2027-02-01') THEN 'client has other Jan visits' END
         ),
         g.last_loc AT TIME ZONE (SELECT tz FROM z)
  FROM (
    SELECT s.id, s.client_id, s.status, s.frequency_type, s.repeat_weeks, s.repeat_months, s.created_at, s.last_replenished_at,
           max(a.loc) AS last_loc,
           count(*) FILTER (WHERE a.loc >= '2026-12-01' AND a.loc < '2027-01-01') AS dec_rows,
           count(*) FILTER (WHERE a.loc >= '2027-01-01' AND a.loc < '2027-02-01') AS jan_rows,
           (SELECT count(*) FROM generate_series(
               max(a.loc)::date + CASE s.frequency_type WHEN 'weekly' THEN 7 * s.repeat_weeks ELSE 1 END,
               date '2027-01-31',
               CASE s.frequency_type WHEN 'weekly' THEN make_interval(days => 7 * s.repeat_weeks) ELSE interval '1 day' END) d
            WHERE s.frequency_type IN ('weekly', 'daily', 'weekdays') AND d >= date '2027-01-01'
              AND (s.frequency_type <> 'weekdays' OR extract(isodow FROM d) < 6))
           + (SELECT count(*) FROM generate_series(1, 24) n
              WHERE s.frequency_type = 'monthly'
                AND (max(a.loc)::date + make_interval(months => n * s.repeat_months))::date BETWEEN date '2027-01-01' AND date '2027-01-31') AS jan_implied
    FROM ser s JOIN appt a ON a.series_id = s.id
    WHERE s.status <> 'stopped'
    GROUP BY s.id, s.client_id, s.status, s.frequency_type, s.repeat_weeks, s.repeat_months, s.created_at, s.last_replenished_at
    HAVING max(a.loc) >= (now() AT TIME ZONE 'America/New_York')
  ) g JOIN cl c ON c.id = g.client_id
  WHERE g.jan_implied > 0
  UNION ALL
  -- ---------------------------------------------------------- 4 summary
  SELECT 4, 'S summary', '-', '-', '-', to_char(now() AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD HH24:MI'),
         concat_ws(' | ',
           'series active ' || (SELECT count(*) FROM ser WHERE status = 'active'),
           'held by edit ' || (SELECT count(*) FROM held),
           'other review_required ' || (SELECT count(*) FROM ser WHERE status = 'review_required' AND id NOT IN (SELECT id FROM held)),
           'stopped ' || (SELECT count(*) FROM ser WHERE status = 'stopped'),
           'C1 ' || (SELECT count(*) FROM classified WHERE cls = 'C1'),
           'C2 ' || (SELECT count(*) FROM classified WHERE cls = 'C2'),
           'C3 ' || (SELECT count(*) FROM classified WHERE cls = 'C3'),
           'possible exceptions ' || (SELECT count(*) FROM classified WHERE cls = 'X'),
           'stale reminder flags ' || (SELECT count(*) FROM appt WHERE status = 'scheduled' AND reminder_24h_sent_at IS NOT NULL AND scheduled_for > now() + interval '25 hours'),
           'upcoming visits with inactive staff ' || (SELECT count(*) FROM appt WHERE status = 'scheduled' AND scheduled_for >= now() AND staff_inactive > 0),
           'scheduled Jan 2027 visits ' || (SELECT count(*) FROM appt WHERE status = 'scheduled' AND loc >= '2027-01-01' AND loc < '2027-02-01'),
           'series ever topped up ' || (SELECT count(*) FROM ser WHERE last_replenished_at IS NOT NULL)
             || ' (last ' || coalesce((SELECT to_char(max(last_replenished_at) AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD') FROM ser), 'never') || ')',
           'appointments ' || (SELECT count(*) FROM appt),
           'assignments ' || (SELECT count(*) FROM appointment_employees ae, ws WHERE ae.workspace_id = ws.id)
         ),
         now()
  UNION ALL
  -- ---------------------------------------------------------- 0 reported clients
  SELECT 0, 'D visit', c.tag, coalesce(left(a.series_id::text, 8), '-'), left(a.id::text, 8),
         to_char(a.loc, 'Dy YYYY-MM-DD HH24:MI') || coalesce('-' || to_char(a.loc_end, 'HH24:MI'), ''),
         concat_ws(' | ',
           a.status,
           'series ' || coalesce((SELECT status FROM ser WHERE id = a.series_id), CASE WHEN a.series_id IS NULL THEN 'none' ELSE 'NO REGISTRY ROW' END),
           'staff ' || a.staff || ' (inactive ' || a.staff_inactive || ')',
           'created ' || to_char(a.created_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD HH24:MI'),
           'reminded ' || coalesce(to_char(a.reminder_24h_sent_at AT TIME ZONE (SELECT tz FROM z), 'MM-DD HH24:MI'), '-'),
           'claim ' || CASE WHEN a.reminder_24h_claim_token IS NULL THEN '-' ELSE 'held' END),
         a.scheduled_for
  FROM appt a JOIN cl c ON c.id = a.client_id
  WHERE c.tag IS NOT NULL
    AND a.scheduled_for >= timestamptz '2026-11-01 00:00 America/New_York'
    AND a.scheduled_for <  timestamptz '2027-04-01 00:00 America/New_York'
  UNION ALL
  SELECT 0, 'D series', c.tag, left(s.id::text, 8), coalesce(left(s.template_appointment_id::text, 8), '-'),
         to_char(s.anchor_local_date, 'Dy YYYY-MM-DD') || ' ' || to_char(s.anchor_local_time, 'HH24:MI'),
         concat_ws(' | ',
           s.status || ' ' || s.source || CASE WHEN s.id IN (SELECT id FROM held) THEN ' (held by edit)' ELSE '' END,
           s.frequency_type || coalesce(' /' || s.repeat_weeks || 'w', '') || coalesce(' /' || s.repeat_months || 'm', ''),
           'created ' || to_char(s.created_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD HH24:MI'),
           'updated ' || to_char(s.updated_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD HH24:MI'),
           'confirmed ' || coalesce(to_char(s.reviewed_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD'), '-'),
           'stopped ' || coalesce(to_char(s.stopped_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD'), '-'),
           'last top-up ' || coalesce(to_char(s.last_replenished_at AT TIME ZONE (SELECT tz FROM z), 'YYYY-MM-DD'), 'never'),
           'skipped times ' || cardinality(s.excluded_occurrences),
           'superseded ' || coalesce(left(s.superseded_series_id::text, 8), '-'),
           'upcoming ' || (SELECT count(*) FROM seq x WHERE x.series_id = s.id AND x.scheduled_for >= now())
             || ' to ' || coalesce((SELECT to_char(max(x.loc), 'YYYY-MM-DD') FROM seq x WHERE x.series_id = s.id), '-')),
         s.created_at
  FROM ser s JOIN cl c ON c.id = s.client_id
  WHERE c.tag IS NOT NULL
  UNION ALL
  SELECT 0, 'D message', c.tag, '-', left(m.appointment_id::text, 8),
         to_char(m.created_at AT TIME ZONE (SELECT tz FROM z), 'Dy YYYY-MM-DD HH24:MI'),
         concat_ws(' | ',
           m.kind, m.channel,
           CASE WHEN m.provider_id = 'failed' THEN 'failed' WHEN m.provider_id IS NULL THEN 'no provider id' ELSE 'accepted' END,
           'for ' || coalesce(to_char(m.scheduled_for AT TIME ZONE (SELECT tz FROM z), 'MM-DD HH24:MI'), '-')),
         m.created_at
  FROM messages_sent m
  JOIN ws ON m.workspace_id = ws.id
  JOIN appt a ON a.id = m.appointment_id
  JOIN cl c ON c.id = a.client_id
  WHERE c.tag IS NOT NULL AND m.created_at >= timestamptz '2026-10-15 00:00 America/New_York'
)
SELECT grp, chk, client, series, appt, at_et, detail
FROM out
ORDER BY grp, chk, client, series, sort_at;
