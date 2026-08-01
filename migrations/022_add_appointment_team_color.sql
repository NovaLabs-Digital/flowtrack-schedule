-- 022: Phase 5.7D-R19 -- optional shared Team Color for appointments with
-- two or more assigned employees.
--
-- Adds exactly one new, additive, nullable column: appointments.team_color.
-- No existing column, row, index, policy, or other table is touched. No row
-- is deleted or rewritten. Safely re-runnable (ADD COLUMN IF NOT EXISTS; the
-- constraint guard below only adds a constraint that isn't already present).
--
-- NULL means "no team color explicitly selected" -- every existing
-- appointment (single-employee, multi-employee, or unassigned) simply has
-- NULL after this migration, matching its exact pre-migration appearance:
-- application logic (lib/teamColor.ts) only ever consumes team_color when
-- an appointment currently has two or more assigned employees, and falls
-- back to the first-assigned employee's own color (by stable assignment
-- order) when it's null -- the same accent color every multi-employee
-- appointment already showed before this column existed. No backfill is
-- performed or needed.
--
-- Employee colors (employees.color, migration 006) are free-form hex
-- values, not drawn from a fixed palette -- so unlike price_cents' simple
-- nonnegative check (migration 020), team_color cannot be constrained to a
-- fixed allowlist of values. Instead the CHECK constraint enforces the
-- general *shape* every valid color must have: NULL, or exactly "#"
-- followed by six hexadecimal digits -- no shorthand #RGB, no alpha
-- channel, no CSS color names/functions/variables, no arbitrary string.
-- Application-level validation (lib/teamColor.ts's normalizeHexColor, used
-- by every create/update/manage-recurrence route before this column is
-- ever written) enforces the identical rule before a write is attempted;
-- this constraint is the database-level last line of defense, exactly the
-- same division of responsibility already established for price_cents in
-- migration 020.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS team_color TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'appointments' AND constraint_name = 'appointments_team_color_hex_format'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_team_color_hex_format
      CHECK (team_color IS NULL OR team_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- =============================================================================
-- Backfill.
--
-- None. Every existing appointment simply has team_color = NULL after this
-- migration -- exactly the pre-existing "no explicit team color" state this
-- feature is designed to represent, not a value this migration invents or
-- infers. See lib/teamColor.ts for the deterministic fallback rendering
-- uses when team_color is null on a two-or-more-employee appointment.
-- =============================================================================
