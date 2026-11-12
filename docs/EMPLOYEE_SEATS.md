# Employee seats — 2026-11-12

## Policy

- **5 active employee seats per workspace.** The owner is not an employee and never uses a seat.
- **Inactive employees don't use a seat.** Deactivating someone frees a seat immediately and keeps their past assignments and worked hours.
- **Existing teams above 5** keep a fixed allowance equal to their active headcount at rollout, so they can replace people who leave but not grow.
- **Per-workspace allowance** (`workspaces.employee_seat_allowance`). A future plan (e.g. 10 seats) only changes that number. No plan, price or billing change is part of this release.

## How it works

| Where | What |
|---|---|
| `migrations/048_employee_seat_allowance.sql` | Adds the allowance column (default 5, 0–1000), grandfathers teams above 5 on first apply, adds the owner link, and a trigger that refuses a new or reactivated seat-using employee when seats are full. The trigger locks the workspace row first, so simultaneous requests can't exceed the allowance. |
| `app/api/employees` | A refusal returns **409** `EMPLOYEE_SEATS_FULL` with `{ used, allowance, available }`. Nothing is saved. |
| `app/api/employees/seats` | Owner-only read: `{ used, allowance, available, ownerLinked }`, counted by the database's own rule. |
| `app/api/employees/owner-link` | Owner-only: link / unlink the signed-in owner's own record (see below). |
| Staff settings | "Seats: X of Y used · Z available". **+ Add Employee** and **Reactivate** are disabled while full, with hover text and a screen-reader link to the seat message; the Inactive list says reactivating needs a free seat. Edit and Deactivate always work. Counts update without a reload. |
| Demo | Same rule, 5 seats. Demo rows in the database are never counted or limited. |

## A working owner

The owner never uses a seat, even if they work jobs. An owner who works jobs keeps an employee record (so they can be assigned) and marks it **This is me** in Staff settings, then confirms. From then on that record is shown as "You · owner · no seat" and doesn't count.

- The server links the record to the **signed-in owner's own account** only; the request carries just the record id (`POST/DELETE /api/employees/owner-link`).
- The database re-checks the link against workspace ownership (the account must hold the workspace's owner membership; demo records can't be linked) and allows **at most one** linked record per workspace.
- Nothing is linked by name or email, and the migration links nothing: existing records keep using a seat until the owner confirms.
- Removing the link from an active record needs a free seat; reactivating the owner's own record never does. If the account ever stopped being the workspace's owner, the record would count again.

## Release order (separate approvals)

1. Read-only: `test-db/employee-seat-audit.sql` (done 2026-11-12: 4 workspaces with employees, largest active team 2, none at or above 5, one possible owner match — a hint only) and `test-db/048-preflight.sql` (every row ok).
2. **Migration approval:** apply `migrations/048_employee_seat_allowance.sql` (one migration: seats, rollout protection, owner link). It changes data only when it first creates the allowance: workspaces above 5 active keep their headcount (none today). It links nothing and changes no assignment or worked-hours row. Re-running never changes an allowance. Then `test-db/048-postflight.sql` (every row ok).
3. **Deployment approval:** deploy the release commit. The app **requires 048** (the employee list reads the owner link), so deploy only after the postflight passes. Rolling back the app needs no schema change.

To disable enforcement without a deploy: `DROP TRIGGER employees_seat_allowance ON employees;` (keeps the columns).

## Tests

- `npm run test:db:seats` (real PostgreSQL, data seeded before 048): rollout grandfathering, re-runs right after rollout and after allowances changed (grandfathered team shrunk, raised to 10, deliberately lowered, created after rollout), the audit query, add/reactivate limits, inactive adds, edits while full, deactivation preserving assignments and hours, grandfathered replacement, per-workspace allowance of 10, demo rows unlimited, two-transaction race and 12 simultaneous adds (exactly 5 succeed), simultaneous reactivations, and the seats endpoint.
- `test-db/048-preflight.sql` / `048-postflight.sql` checked on the same database (before / after 048); owner link: owner + 5 active allowed and a 6th blocked, ownership verified in the database (other owner, non-owner, demo refused), one link per workspace (also simultaneous), unlink needs a seat, owner record reactivates when full, assignments and hours kept, nothing auto-linked by email, ownership change counts the record again, server-only functions.
- Unit: employees route (409 mapping, `is_you`), seats and owner-link routes, Staff panel, button explanations, demo interceptor.
- Browser (headless Chrome, real app, fictional data at 5 of 5): seat count, disabled Add/Reactivate with their explanations, deactivate → 4 of 5 and both enabled, reactivate → full again, all without a reload; owner confirms "This is me" and reactivates their own record → owner + 5 active, seats 5 of 5, a 6th employee blocked.
