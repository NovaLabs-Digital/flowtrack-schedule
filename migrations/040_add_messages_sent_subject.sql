-- 040: Message History feature -- captures the actual email subject line at
-- send time, alongside the existing `body` snapshot (messages_sent.body,
-- present since this table's creation).
--
-- Adds one new, additive, nullable column:
--   subject -- the exact rendered email subject AT THE MOMENT this row is
--              written (recordMessageSent, lib/notify.ts), going forward
--              only. Every email call site (create/update/cancel/delete/
--              notifyAppointmentChange/reminders) now passes it. sms rows
--              never set it (no subject concept for sms) and it is never
--              backfilled -- a row written before this migration (or any
--              future sms row) keeps subject = NULL, which the Message
--              History UI shows as "not captured," never guessed from the
--              current template.
--
-- No existing row is modified, no other table or function changes, and no
-- index is added -- this column is display-only, never filtered or joined
-- on.
BEGIN;

ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS subject TEXT;

COMMIT;
