-- READ-ONLY rollout check for migration 049. Run in the Supabase SQL Editor
-- AFTER 049 is applied and RIGHT BEFORE the new app is deployed. A single
-- SELECT: it changes nothing. Counts only -- no names, amounts or numbers.
--
-- Why: 049's one-time backfill marks every job that was paid + Cash + no
-- invoice number at the moment 049 was applied as "Paid directly, no
-- invoice", so those stay closed. Until the new app is deployed, the OLD app
-- still hides any paid + Cash + no-number job from "Missing Invoice #" and
-- Needs Attention. A cash job marked paid in that window is NOT marked
-- (049 never re-applies the old rule), so after the deploy it shows
-- "Needs invoice number" again. The owner closes each one with Billing's
-- "No invoice needed" (one click + confirm), or adds its invoice.
--
-- check                              what it shows
--   cash_paid_in_window             ok = none; otherwise how many jobs will reappear, in how many workspaces
--   window_first_change / last      when those jobs were last saved (to match against the 049 apply time)
--   already_marked                  informational: jobs marked Paid directly, no invoice (backfill + any since)
WITH window_jobs AS (
  SELECT workspace_id, updated_at
  FROM completed_job_billing
  WHERE paid = true AND payment_method = 'cash' AND invoice_number IS NULL AND no_invoice_required = false
),
checks(check_name, ok, detail) AS (
  SELECT 'cash_paid_in_window',
         NOT EXISTS (SELECT 1 FROM window_jobs),
         (SELECT count(*) FROM window_jobs)::text || ' job(s) in '
           || (SELECT count(DISTINCT workspace_id) FROM window_jobs)::text
           || ' workspace(s) will show Needs invoice number after the deploy'
  UNION ALL
  SELECT 'window_first_change', true, coalesce((SELECT min(updated_at) FROM window_jobs)::text, 'none')
  UNION ALL
  SELECT 'window_last_change', true, coalesce((SELECT max(updated_at) FROM window_jobs)::text, 'none')
  UNION ALL
  SELECT 'already_marked', true,
         (SELECT count(*) FROM completed_job_billing WHERE no_invoice_required)::text || ' job(s) marked Paid directly, no invoice'
)
SELECT check_name, ok, detail FROM checks;
