-- 037: occurrence-scoped reminder deduplication -- fixes a confirmed defect
-- found during final pre-deployment verification of the reminder claim
-- protocol (migrations/036).
--
-- app/api/cron/reminders/route.ts's alreadyDelivered() check (and the Resend
-- idempotency key it builds for sendEmail) previously identified a "channel
-- already delivered" purely by appointment_id + channel + kind. messages_sent
-- rows are never deleted, so once an appointment's email/SMS reminder had
-- ever succeeded, BOTH the dedup check and the idempotency key treated every
-- later rescheduling of that same appointment row as "already handled" --
-- even though migrations/035/036 correctly reset reminder_24h_sent_at (and
-- the claim columns) on reschedule. The practical effect: a previously-
-- reminded appointment that gets rescheduled silently receives NO new
-- reminder for its new date, while still being marked fully reminded, because
-- emailDone/smsDone both resolved true against the OLD occurrence's audit
-- rows.
--
-- Adds one new, additive, nullable column to messages_sent:
--   scheduled_for -- a snapshot of the appointment's scheduled_for AT THE
--                    MOMENT this message was sent (recorded by
--                    recordMessageSent, never backfilled). alreadyDelivered()
--                    now matches on this exact value (an ordinary SQL `=`,
--                    which never matches a NULL on either side) instead of
--                    matching on appointment_id/channel/kind alone.
--
-- Existing historical rows (written before this migration, or by any other
-- notification kind that never passes scheduled_for) keep scheduled_for =
-- NULL. This is intentional, not an oversight: a NULL never equals any
-- specific timestamp, so a historical row can never be mistaken for "already
-- delivered for the CURRENT occurrence" -- it simply stops being considered
-- for dedup purposes going forward, exactly as it should, while remaining in
-- place for message-history/audit purposes.
--
-- No existing row is modified, no other notification kind's behavior
-- changes, and no index is added here -- migrations/036's existing
-- idx_messages_sent_appt_channel_kind index already serves the leading
-- (appointment_id, channel, kind) columns of alreadyDelivered()'s new query;
-- the added scheduled_for equality filter is evaluated against the small
-- per-appointment result that index already narrows down to.
BEGIN;

ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

COMMIT;
