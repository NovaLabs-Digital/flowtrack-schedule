# Guided Demo Sessions — operations (milestone 1)

One host (Alberto) and one visitor share a fresh **fictional** demo dataset
with server-enforced permissions, on one **shared screen** with each
other's labelled cursor. Audio and pushed (instant) updates come later.
Security model: see
[SECURITY.md › Guided Demo Sessions](SECURITY.md#guided-demo-sessions).

## Permissions

The host can **always** use the demo. The guest starts out watching:

- **Allow Guest Control** lets the guest edit alongside the host. The host
  keeps full use of the demo the whole time.
- **Stop Guest Control** blocks the guest again at once. The server also
  refuses any guest change that was already on its way when Stop was
  clicked (migration 043), so a slow connection can't sneak one in.
- **End Session** is always available to the host; **Leave** always to the
  guest. If the guest's page stops checking in for about 20 seconds, guest
  control turns off by itself; the host can allow it again.

The host's bar says whether the guest is watching or can edit ("Dana is
watching" / "Dana can edit with you"); the guest's bar says "Watching —
the host is in control" or "You can edit alongside the host".

## Watch-only mode (guest)

While the guest is watching, the whole demo dashboard stays visible but
takes no input: navigation, appointment cards, forms and dialogs, Settings,
scrolling, dragging, and keyboard actions are all blocked, and a note reads
"You're watching. The host can give you control." Leave is never blocked.
The host is never placed behind this layer. Normal use returns the moment
guest control is allowed. The server still refuses every change from a
watching guest, so this is a convenience on top of the real rule.

## Editing at the same time

When both people can edit, the server makes sure nobody's work is silently
undone:

- Each edit remembers when it **began** (the form opened, or Edit was
  clicked). If someone else changed the **same record** after that, the save
  is refused with: "Someone else changed this while you were editing, so
  your changes weren't saved. They're still here: check the latest details,
  then save again to apply them." The form keeps what was typed; saving
  again is a deliberate choice, never an automatic retry.
- Changes to **other** records never conflict: the host can edit one
  appointment while the guest edits a different client.
- Two saves at the same instant are applied one after the other, each
  checked against what the other just did.

## Shared screen

Both people follow one screen (migration 044): calendar mode and date,
selected client and appointment, Settings section, the open dialog or edit
form and the draft inside it, and scrolling -- the calendar, open dialogs,
Settings, and the client details form. Panel sizes, the session bar, and
(later) chat stay each person's own. Menus, history filters, and similar
small view toggles inside panels are not shared.

- **Who moves the screen.** The host always; the guest while guest control
  is allowed. A watching guest's screen follows but can't change it.
- **Order.** The server applies changes one at a time in a single order.
  Calendar date, selection, and dialog change together as one block, so two
  people clicking at once can never produce a mixed-up view. If the guest
  acts on a view the host has just changed, the host's change wins and the
  guest's screen shows it.
- **One person types at a time.** Whoever opens a form is its editor; the
  other person sees their typing appear, read-only, with "… is editing
  this." The host can always **Take over editing**; an allowed guest can
  **Start editing** when the host isn't typing. The draft carries over --
  nothing typed is lost -- and so does its original edit version, so the
  conflict protection above still applies.
- **Unsaved input is never thrown away silently.** If someone tries to move
  the screen while a form holds unsaved changes, the move waits and both
  screens show it in the session bar ("… wants to open Settings, but you
  have unsaved changes in …"). The person editing chooses **Keep editing**
  or **Discard my changes and continue** (or saves). The host may instead
  **Continue and keep the guest's draft**: the screen moves on and the
  draft is set aside, then comes back when that form is opened again.
- **Joining and reconnecting** open straight to the current shared screen,
  including an open form and its draft.
- **Following someone's place in a form.** While someone is editing, the
  other person's dialog or Settings panel scrolls with theirs, and the
  field they're in is outlined and kept in view. This comes back after a
  reload too.
- **Window sizes.** The calendar is shared by time of day at the top, not
  pixels; dialogs and Settings by which part of the form is at the top; and
  cursors by position within the part of the screen they're over -- so all
  line up on different desktop window sizes. Below 768 px
  wide the page asks the person to widen their window instead of showing a
  screen that can't match.
- **Cursors.** Your cursor appears on the other screen with your name. The
  host's is always shown; the guest's only while guest control is allowed.
  Cursors never block clicks and disappear about 5 seconds after their owner
  disconnects. **Cursor movement is not instant: it currently trails the
  real pointer by roughly 1–2 seconds**, because positions travel with the
  once-a-second check-in and glide between reports.
- **Speed (estimates, not guarantees).** Your own screen changes at once.
  The other screen follows on the next once-a-second check-in -- typically
  about 0.5–2 seconds behind -- and cursors glide between check-ins, so
  they trail the real pointer by about 1–2 seconds. Pushed updates (a later
  milestone) would bring this close to instant.

Guided sessions are designed for desktop browsers. On a phone-sized screen
the dashboard switches to the mobile layout, which has no session bar and no
watch-only blocking (the server still refuses changes from a watching guest).

## Configuration

| Setting | Where | Value |
|---|---|---|
| `DEMO_HOST_AUTH_USER_ID` | Vercel environment (server-only) | Alberto's Supabase Auth user id (the owner session's `authUserId`). **Unset = feature off.** |
| Migration 042 | Supabase SQL editor | `migrations/042_add_demo_sessions.sql` (applied 2026-10-31) |
| Migration 043 | Supabase SQL editor | `migrations/043_guest_control_permissions.sql` (applied 2026-11-01) |
| Migration 044 | Supabase SQL editor | `migrations/044_shared_session_view.sql` (separate approval; checks: `test-db/044-preflight.sql`, `test-db/044-postflight.sql`) |
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

**Guest permissions (migration 043): apply 043 first, then deploy the code.**
043 only changes who the database accepts changes from; the code deployed
before it only ever sends a change from the person holding control, which
043 still accepts, so nothing changes until the new code arrives. Deployed
the other way round, the new code would see the host's saves refused while
guest control is on (safe, but confusing) until 043 is applied.

**Shared screen and cursors (migration 044): apply 044 first, then deploy
the code.** 044 only adds columns and functions the earlier code never
uses. Deployed the other way round, sessions still work (the check-in falls
back to the pre-044 one) but screens aren't shared and there are no cursors
until 044 is applied.

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
- A sync answer is under 1 KB; the dataset (~80 KB) and the shared screen
  are only sent to a browser when they changed. Cursor positions ride along
  on the same check-in (no extra calls).
- Shared-screen changes (navigation, form typing at most every 0.3 s,
  calendar scrolling at most every 0.25 s) are one extra call each while
  someone is actively doing them -- an estimate of a few hundred calls per
  session hour on top of the check-ins.

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
