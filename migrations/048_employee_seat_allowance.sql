-- 048: employee seats -- at most N ACTIVE employees per workspace, and a
-- working owner who does not use one.
--
-- Policy (approved 2026-11-12): 5 active employee seats per workspace.
-- Inactive employees and demo rows (is_demo = true) never use a seat:
-- deactivating someone frees one and keeps their assignments and worked
-- hours untouched. The owner never uses a seat. An owner who also works jobs
-- keeps an employee record so they can be assigned; that record is exempt
-- ONLY when explicitly linked to the owner's own account:
--
--   * employees.owner_profile_id -- set only by the server from the signed-in
--     owner, after the owner confirms "This is me" in Staff settings
--     (app/api/employees/owner-link). Never set from a name or email match,
--     and this migration links nothing: every existing record stays unlinked
--     (and uses a seat) until the owner confirms.
--   * The link is verified HERE against workspace ownership: the profile must
--     hold the 'owner' membership of the record's workspace, and the record
--     must not be demo data. Otherwise SQLSTATE 'SL002' and nothing is saved.
--   * At most one linked record per workspace (unique index).
--   * A linked record is exempt only while that profile is still the
--     workspace's owner (employee_uses_seat).
--
-- 1. workspaces.employee_seat_allowance: seats per workspace, default 5,
--    stored per workspace so a future plan (e.g. 10 seats) only changes this
--    value; no plan or price is introduced here.
-- 2. Rollout (first apply only): a workspace that already has MORE than 5
--    active employees keeps a fixed allowance equal to that headcount, so it
--    can replace people who leave. Re-running never changes an allowance.
-- 3. Enforcement in the database, for every write path: a trigger refuses an
--    INSERT of a seat-using employee, or an UPDATE that makes a record use a
--    seat (reactivation, removing the owner link, moving workspace), when all
--    seats are in use. It locks the workspace row first (FOR NO KEY UPDATE),
--    so simultaneous requests can never exceed the allowance. Refusal:
--    SQLSTATE 'SL001', DETAIL {"used": n, "allowance": n}.
--
-- Changes no assignment or worked-hours row. Additive and safe to re-run (a
-- re-run only re-creates functions, the index and the trigger). To remove
-- enforcement: DROP TRIGGER employees_seat_allowance ON employees.

-- 1 + 2 run together, ONLY the first time (when the column does not exist
-- yet): re-running this migration never touches an allowance again, so a
-- grandfathered allowance, or one changed later for a workspace (raised for
-- a larger plan, or lowered on purpose), is always preserved.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'employee_seat_allowance'
  ) THEN
    ALTER TABLE workspaces ADD COLUMN employee_seat_allowance INTEGER NOT NULL DEFAULT 5;

    -- Grandfather existing teams above the default (only ever raises).
    UPDATE workspaces w
    SET employee_seat_allowance = c.active_count
    FROM (
      SELECT workspace_id, count(*)::integer AS active_count
      FROM employees
      WHERE active = true AND is_demo = false
      GROUP BY workspace_id
    ) c
    WHERE c.workspace_id = w.id
      AND c.active_count > w.employee_seat_allowance;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_employee_seat_allowance_range') THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_employee_seat_allowance_range
      CHECK (employee_seat_allowance BETWEEN 0 AND 1000);
  END IF;
END $$;

-- 4. The owner link and seat enforcement.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS owner_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_one_owner_link_per_workspace
  ON employees (workspace_id) WHERE owner_profile_id IS NOT NULL;

-- Is this profile the owner of this workspace right now?
CREATE OR REPLACE FUNCTION is_workspace_owner(p_workspace_id UUID, p_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT p_profile_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM workspace_memberships
    WHERE workspace_id = p_workspace_id AND profile_id = p_profile_id AND role = 'owner'
  );
$fn$;

-- The one rule for "does this record use a seat".
CREATE OR REPLACE FUNCTION employee_uses_seat(p_active BOOLEAN, p_is_demo BOOLEAN, p_workspace_id UUID, p_owner_profile_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT p_active IS TRUE AND p_is_demo IS NOT TRUE
     AND NOT is_workspace_owner(p_workspace_id, p_owner_profile_id);
$fn$;

CREATE OR REPLACE FUNCTION enforce_employee_seat_allowance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_allowance INTEGER;
  v_used      INTEGER;
BEGIN
  -- A link must point at this workspace's owner, on a real (non-demo) record.
  IF NEW.owner_profile_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.owner_profile_id IS DISTINCT FROM OLD.owner_profile_id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.is_demo IS DISTINCT FROM OLD.is_demo) THEN
    IF NEW.is_demo IS TRUE OR NOT is_workspace_owner(NEW.workspace_id, NEW.owner_profile_id) THEN
      RAISE EXCEPTION 'Only the owner of this workspace can be linked to an employee record.'
        USING ERRCODE = 'SL002';
    END IF;
  END IF;

  -- Only a record that will use a seat needs one.
  IF NOT employee_uses_seat(NEW.active, NEW.is_demo, NEW.workspace_id, NEW.owner_profile_id) THEN
    RETURN NEW;
  END IF;
  -- Already using a seat in this workspace (name/phone/colour edits etc.).
  IF TG_OP = 'UPDATE' AND OLD.workspace_id = NEW.workspace_id
     AND employee_uses_seat(OLD.active, OLD.is_demo, OLD.workspace_id, OLD.owner_profile_id) THEN
    RETURN NEW;
  END IF;

  SELECT employee_seat_allowance INTO v_allowance
  FROM workspaces WHERE id = NEW.workspace_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- the workspace foreign key rejects the row
  END IF;

  SELECT count(*) INTO v_used
  FROM employees e
  WHERE e.workspace_id = NEW.workspace_id AND e.id <> NEW.id
    AND employee_uses_seat(e.active, e.is_demo, e.workspace_id, e.owner_profile_id);

  IF v_used >= v_allowance THEN
    RAISE EXCEPTION 'All % employee seats are in use.', v_allowance
      USING ERRCODE = 'SL001',
            DETAIL = json_build_object('used', v_used, 'allowance', v_allowance)::text;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS employees_seat_allowance ON employees;
CREATE TRIGGER employees_seat_allowance
  BEFORE INSERT OR UPDATE OF active, workspace_id, is_demo, owner_profile_id ON employees
  FOR EACH ROW EXECUTE FUNCTION enforce_employee_seat_allowance();

-- Seats for one workspace, by the same rule: { used, allowance, available }.
CREATE OR REPLACE FUNCTION employee_seat_usage(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT jsonb_build_object(
    'used', u.used,
    'allowance', w.employee_seat_allowance,
    'available', greatest(0, w.employee_seat_allowance - u.used),
    'owner_linked', u.owner_linked)
  FROM workspaces w
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE employee_uses_seat(e.active, e.is_demo, e.workspace_id, e.owner_profile_id))::int AS used,
           bool_or(e.owner_profile_id IS NOT NULL AND is_workspace_owner(e.workspace_id, e.owner_profile_id)) IS TRUE AS owner_linked
    FROM employees e WHERE e.workspace_id = w.id
  ) u
  WHERE w.id = p_workspace_id;
$fn$;

REVOKE ALL ON FUNCTION is_workspace_owner(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION employee_uses_seat(BOOLEAN, BOOLEAN, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION enforce_employee_seat_allowance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION employee_seat_usage(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION is_workspace_owner(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION employee_uses_seat(BOOLEAN, BOOLEAN, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION employee_seat_usage(UUID) TO service_role;
