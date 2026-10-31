# Guided Demo Sessions — operations (milestone 1)

Milestone 1 is a foundation: one host (Alberto) and one visitor share a fresh
**fictional** demo dataset with server-enforced control ownership. Each
person navigates independently; audio (milestone 2) and synchronized
screens (milestone 3) come later. Security model: see
[SECURITY.md › Guided Demo Sessions](SECURITY.md#guided-demo-sessions).

## Configuration

| Setting | Where | Value |
|---|---|---|
| `DEMO_HOST_AUTH_USER_ID` | Vercel environment (server-only) | Alberto's Supabase Auth user id (the owner session's `authUserId`). **Unset = feature off.** |
| Migration 042 | Supabase SQL editor | `migrations/042_add_demo_sessions.sql` (separate approval) |
| Cleanup cron | `vercel.json` | `/api/cron/demo-session-cleanup`, daily at `37 9 * * *` (09:37 UTC) |

## Safe release order

Every stage is safe on its own:

1. **Deploy the code with `DEMO_HOST_AUTH_USER_ID` unset.** The feature is
   off: every session route answers 404 without touching the database,
   `/demo/host` says "Guided Demo Sessions are not available.", and the
   public `/demo` and the real app are unchanged. The cleanup cron reports a
   successful no-op (`skipped: "not_installed"`) until step 2.
2. **Apply migration 042** (separate approval). Nothing is visible yet.
3. **Set `DEMO_HOST_AUTH_USER_ID`** in Vercel and redeploy.

If steps 2 and 3 happen in the other order, session routes answer a clear
503 ("Guided Demo Sessions aren't set up yet.") instead of failing, and the
cron still reports a no-op.

## Cron and the Vercel plan

Vercel's documentation (Cron Jobs › usage and pricing, July 2026): Hobby
projects may only run crons **once per day** — an hourly expression fails
the deployment with "Hobby accounts are limited to daily cron jobs" — while
Pro allows once per minute; both allow 100 crons per project. The new cron
is daily, so it fits either plan. This project already deploys an hourly
cron (`/api/cron/reminders`, `0 * * * *`) successfully, which Hobby would
reject — strong evidence the project is on **Pro**; confirm in the Vercel
dashboard (Settings › Billing). Each cron run is one function invocation.

## Polling usage (not free)

Milestone 1 synchronizes by polling:

- Each open session page calls `/api/demo-session/[id]/sync` about **once a
  second while visible** and **every 4 seconds while hidden**, plus one call
  per data change or control action.
- Each call is one Vercel function invocation and one small Supabase
  function call (a row lock and a presence update).
- A sync answer is under 1 KB; the dataset (~80 KB) is only sent to a
  browser when it changed.

| | Sync calls |
|---|---|
| One session hour, both pages visible | ~7,200 |
| Longest session (2 hours) | ~14,400 |
| Example month: 20 sessions × 45 min | ~108,000 |

On Pro, Vercel bills functions from the first unit against the plan's
$20/month usage credit — there is no separate free function allowance:
invocations from $0.60 per million, Active CPU from $0.128 per hour, and
provisioned memory from $0.0106 per GB-hour (prices vary by region;
vercel.com/pricing, June 2026). For the example month that is about
$0.07 of invocations plus CPU and memory that depend on each call's
duration — likely well under $1 in total, but **this is an estimate**:
check the Vercel usage dashboard after the first real sessions. Supabase
sees the same call volume as small writes. Milestone 2 replaces polling
with pushed updates, which removes almost all of this traffic.
