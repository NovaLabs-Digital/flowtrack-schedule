-- 020: Phase 5.7D-R17 — optional service default pricing and appointment
-- price snapshots.
--
-- Adds exactly two nullable, additive columns: services.default_price_cents
-- and appointments.price_cents. No existing column, row, index, policy, or
-- other table is touched. No row is deleted. Safely re-runnable (every
-- statement is IF NOT EXISTS-guarded, and the constraint guard below only
-- adds a constraint that isn't already present).
--
-- Money is stored as integer cents, never floating-point dollars, to avoid
-- rounding error -- the same reason every other precise numeric value in
-- this schema (hours_worked aside, which is intentionally decimal) avoids
-- float. Both columns are nullable with NO default: an existing service or
-- appointment with no price set simply has NULL here, meaning "no price
-- was ever entered," never a fabricated or inferred $0.00. A real $0.00
-- price (explicitly entered) is stored as the integer 0, which is
-- distinguishable from NULL at every layer (SQL, API, and UI) — this
-- migration does not collapse "no price" and "free" into the same value.
--
-- services.default_price_cents:
--   The service's own optional default price, entered in Settings ->
--   Services. Read only at the moment an appointment's service is selected
--   (to propose a price snapshot — see appointments.price_cents below) and
--   for display in the Services table. Changing this value later never
--   rewrites any existing appointment's own price_cents — there is no
--   trigger, no cascading UPDATE, nothing here that would make that happen.
--
-- appointments.price_cents:
--   An independent snapshot taken at create/edit time from whichever
--   service default price was selected (application logic only — this
--   migration does not add a foreign key or generated column tying it back
--   to services.default_price_cents). Freely editable afterward for a
--   negotiated or special price without ever affecting the service's own
--   default. NULL means no price was ever set for this appointment
--   (matches every pre-existing row exactly, and matches a newly created
--   appointment whose selected service also has no default price).
--
-- Both columns get a permissive, safety-net CHECK constraint (NULL or >= 0)
-- — this rejects an accidental negative value at the database layer as a
-- last line of defense, in addition to the application-level validation in
-- app/api/services/route.ts and app/api/appointments/create|update/route.ts.
-- No upper bound is enforced at the database layer (the application layer
-- already rejects an excessively large value before it ever reaches here;
-- see MAX_PRICE_CENTS in lib/money.ts) — a database-level ceiling would be
-- one more thing to keep in sync with that application constant for no
-- added safety.

ALTER TABLE services     ADD COLUMN IF NOT EXISTS default_price_cents integer;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS price_cents integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'services' AND constraint_name = 'services_default_price_cents_nonnegative'
  ) THEN
    ALTER TABLE services
      ADD CONSTRAINT services_default_price_cents_nonnegative
      CHECK (default_price_cents IS NULL OR default_price_cents >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'appointments' AND constraint_name = 'appointments_price_cents_nonnegative'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_price_cents_nonnegative
      CHECK (price_cents IS NULL OR price_cents >= 0);
  END IF;
END $$;

-- =============================================================================
-- Backfill.
--
-- Neither column is backfilled for any existing row. Every existing service
-- and appointment simply has NULL (no price ever set) after this migration
-- — exactly the pre-existing "no price" state this feature is designed to
-- represent, not a value this migration invents or infers.
-- =============================================================================
