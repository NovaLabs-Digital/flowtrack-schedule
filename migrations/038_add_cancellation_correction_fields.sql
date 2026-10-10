-- 038: cancellation correction audit fields -- fixes a confirmed defect
-- where an owner/admin could not record a cancellation for an appointment
-- once its scheduled time had passed (real case: a client called to cancel
-- the day before, but the owner only got to record it after the
-- appointment's scheduled end had already elapsed, and the app refused the
-- change outright).
--
-- Adds three new, additive, nullable columns to appointments:
--   cancelled_at                -- when this row was actually marked
--                                   cancelled in the system (set by
--                                   app/api/appointments/delete/route.ts on
--                                   every cancellation, live or historical-
--                                   correction alike). Distinct from
--                                   created_at (when the appointment was
--                                   first created) and from scheduled_for
--                                   (when the service itself was booked
--                                   for).
--   cancellation_reported_date  -- the date the client actually reported
--                                   the cancellation to the business, as the
--                                   owner enters it -- separate from
--                                   cancelled_at, since an owner may record
--                                   a cancellation days after the client
--                                   actually called. Nullable: most live,
--                                   in-the-moment cancellations (the client
--                                   cancelling the same day, or via their own
--                                   cancel link) have no separate "reported"
--                                   date worth capturing.
--   cancellation_reason         -- free-text reason, required by
--                                   application logic (not a DB constraint,
--                                   to keep this migration purely additive)
--                                   whenever the owner corrects an
--                                   already-Completed appointment (every
--                                   assigned employee's Job Tracking done)
--                                   to Cancelled -- optional for every other
--                                   cancellation path, past or present.
--
-- Nothing here touches appointment_employees, appointment_employee_hours,
-- or completed_job_billing -- a correction to Cancelled never deletes or
-- resets recorded worked time, job notes, or billing rows; it only adds
-- these three columns and (via the application route) sets status and
-- these fields on the appointments row itself.
BEGIN;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reported_date DATE;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

COMMIT;
