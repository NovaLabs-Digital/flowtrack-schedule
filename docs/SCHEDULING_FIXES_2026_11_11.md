# Scheduling fixes — 2026-11-11

Three production reports: **This & future did not carry forward**, **the saved time was an hour later than entered**, and **few visits appear after Jan 1, 2027**.

## What was wrong

| Report | Verified cause | Fix |
|---|---|---|
| Saved time one hour later | Moving a visit **later** with *This and all future* moved the edited visit twice: it matched its own "later visits" query after it was saved. Later visits were correct. | The edited visit is excluded from that query. |
| This & future did not carry | (a) The edit form always resends the visit's staff. If one of them had since been **deactivated**, the save stored the edited visit and then failed before any later visit. (b) After a This & future change, the series' uniformity check included upcoming visits **before** the edited one, so the series was put on hold and never topped up again. | (a) Staff are only re-saved when someone is added or removed; adding an inactive employee is refused before anything is saved. (b) The check covers the edited visit and the later ones only. |
| Partial saves | This & future saved as a chain of separate calls; a failure part-way left some visits moved and the series on hold. | **Migration 047** `apply_future_edit`: the whole edit (visits, staff, hold and re-confirmation, reminder resets) commits in one transaction or not at all. |
| Few visits after Jan 1 | Not a calendar limit: the visits were never created. New series are created 26 weeks ahead, top-ups could not run (fixed in the capacity commit, see below), and top-ups only kept 60 days. | Top-ups now keep a rolling **26 weeks** (top up below 25 weeks, at most 20 visits per series per run). |

## What ships (release branch, in order)

1. **Capacity** (required) -- dashboard pagination, fair top-ups, the top-up time-format fix (top-ups never worked before it), skips recorded on single moves/cancels. The scheduling commit edits the same files and its tests need these fixes.
2. **Scheduling** (this document) -- everything in the table above, plus migration 047.

Left out, not needed by this release: the reminder hand-off re-check (independent; can ship on its own later) and `docs/CAPACITY_PRICING_REPORT.md` (documentation only; a few code comments still name it).

## Separate approvals (none implies another)

1. **Migration approval** -- apply `migrations/047_atomic_future_edit.sql` in production after `test-db/047-preflight.sql` passes; confirm with `test-db/047-postflight.sql`. Prerequisite: migrations 001-046 applied (046 is the latest applied). Additive: one new function, `service_role` only.
2. **Deployment approval** -- deploy the release commit only after 047 is confirmed. The app needs 047 for *This and all future* (without it that save returns "Nothing was saved"). Rolling back the app never requires removing 047.
3. **Live top-ups** -- `REPLENISHMENT_DRY_RUN=false`. Not part of this release. Run the diagnosis and the capacity pre-enable review first: top-ups only extend confirmed (`active`) series.
4. **Appointment repairs** -- per row, from the diagnosis, after Alberto reviews it. Not part of this release.

## What existing data needs

Nothing corrects itself. The read-only diagnosis lists repair candidates for owner review (inferred from the data, each with a proposed time Alberto accepts or rejects) separately from possible intentional exceptions. Series on hold must be re-confirmed in Settings → Recurring Series after their visits are fixed.

## Verification

- `npm run test:db:scheduling` (real PostgreSQL, fictional data): double move, inactive cleaner, governed-tail check, faults injected after the first write (each later visit, staff sync, series update) roll back fully and a retry applies once, stale plans refused, permissions, 26-week horizon (bounded batches, holds, cancelled and moved final visits, repeat runs, reminder state), diagnosis query classification.
- Browser (headless Chrome, real app, fictional data): entered 9:00 AM, This and all future, reload → edited and following visits 9:00–10:15, earlier visit unchanged, series still confirmed.
