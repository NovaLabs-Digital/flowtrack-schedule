-- READ-ONLY. Capacity check for the two defects found in
-- docs/CAPACITY_PRICING_REPORT.md. Run in the Supabase SQL editor.
-- SELECTs only; changes nothing.

-- 1. Dashboard assignment truncation: app/dashboard/page.tsx reads
--    appointment_employees for a workspace WITHOUT pagination. If PostgREST
--    max-rows is 1000 (the default), any workspace over 1000 here is already
--    missing its NEWEST assignments on the owner dashboard.
SELECT w.name, ae.workspace_id, count(*) AS assignment_rows
FROM appointment_employees ae
JOIN workspaces w ON w.id = ae.workspace_id
GROUP BY w.name, ae.workspace_id
ORDER BY assignment_rows DESC;

-- Other unpaginated dashboard reads (same 1000-row risk).
SELECT 'clients' AS t, workspace_id, count(*) FROM clients GROUP BY workspace_id
UNION ALL
SELECT 'appointment_employee_hours', workspace_id, count(*) FROM appointment_employee_hours GROUP BY workspace_id
ORDER BY 3 DESC;

-- 2. Replenishment starvation: the daily cron examines only the first 100
--    active series by (last_replenished_at NULLS FIRST, id), and skipped
--    series never advance last_replenished_at. Anything past position 100
--    is never topped up.
SELECT count(*) AS active_series,
       count(*) FILTER (WHERE last_replenished_at IS NULL) AS never_replenished
FROM recurring_series
WHERE status = 'active' AND is_demo = false;

-- Series whose live future tail is under 175 days (25 weeks): would be topped up now (rolling 26-week window).
SELECT rs.workspace_id, count(*) AS series_under_175_days
FROM recurring_series rs
WHERE rs.status = 'active' AND rs.is_demo = false
  AND COALESCE((SELECT max(a.scheduled_for) FROM appointments a
                WHERE a.series_id = rs.id AND a.status = 'scheduled'), now()) < now() + interval '175 days'
GROUP BY rs.workspace_id;

-- 3. PostgREST max-rows setting is a project setting, not SQL-visible:
--    check Supabase Dashboard > Project Settings > API > "Max rows".

-- 4. BEFORE turning live top-ups on (REPLENISHMENT_DRY_RUN=false): every slot
--    a live run would create in the next 182 days (26 weeks), per series, flagged when
--    the same series has an off-pattern job nearby -- the signature of a
--    single-occurrence move made before 2026-11-03, whose original slot was
--    never recorded as skipped and WOULD be recreated (a duplicate visit).
--    Weekly/daily/weekdays series only (monthly: review by hand). Read-only.
WITH s AS (
  SELECT rs.*, w.name AS workspace_name,
         COALESCE((SELECT max(a.scheduled_for) FROM appointments a
                   WHERE a.series_id = rs.id AND a.status = 'scheduled'), now()) AS live_tail
  FROM recurring_series rs JOIN workspaces w ON w.id = rs.workspace_id
  WHERE rs.status = 'active' AND rs.is_demo = false
    AND rs.frequency_type IN ('weekly', 'daily', 'weekdays')
),
slots AS (
  SELECT s.id AS series_id, s.workspace_name, s.anchor_timezone, s.live_tail,
         ((s.anchor_local_date + g.d) + s.anchor_local_time) AT TIME ZONE s.anchor_timezone AS slot
  FROM s CROSS JOIN LATERAL generate_series(0, 4000) g(d)
  WHERE (s.frequency_type = 'daily')
     OR (s.frequency_type = 'weekdays' AND extract(isodow FROM s.anchor_local_date + g.d) < 6)
     OR (s.frequency_type = 'weekly' AND g.d % (7 * s.repeat_weeks) = 0)
)
SELECT sl.workspace_name, sl.series_id,
       (sl.slot AT TIME ZONE sl.anchor_timezone) AS would_create_local,
       (SELECT string_agg(to_char(a.scheduled_for AT TIME ZONE sl.anchor_timezone, 'Dy YYYY-MM-DD HH24:MI') || ' ' || a.status, ', ')
        FROM appointments a
        WHERE a.series_id = sl.series_id
          AND a.scheduled_for > sl.slot - interval '7 days'
          AND a.scheduled_for < sl.slot + interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM slots p WHERE p.series_id = a.series_id AND p.slot = a.scheduled_for)
       ) AS nearby_off_pattern_jobs_review
FROM slots sl
JOIN recurring_series rs ON rs.id = sl.series_id
WHERE sl.slot > sl.live_tail
  AND sl.slot > now()
  AND sl.slot <= now() + interval '182 days'
  AND sl.slot <> ALL (rs.excluded_occurrences)
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.series_id = sl.series_id AND a.scheduled_for = sl.slot)
-- Flagged rows (column 4 not null) first.
ORDER BY 4 NULLS LAST, 1, 2, 3;
