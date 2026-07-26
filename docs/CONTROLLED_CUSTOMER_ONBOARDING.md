# Controlled Customer Onboarding Runbook

**Phase 5.7B.** Manual, operator-run procedure for provisioning ScheduleFlowTrack's first 1–3 external paying customers as fully isolated workspaces.

This document is written so Alberto can follow it step by step without reading the application source code. Every SQL statement, route, and behavior described here is grounded in specific files in this repository, cited in parentheses. Where the repository does not provide enough evidence to state something as fact, that gap is called out explicitly rather than guessed.

**Why this process is manual.** ScheduleFlowTrack has no self-service signup flow today — this is a deliberate, documented decision (`docs/SECURITY.md`, "Known Limitations": *"there is no self-service account creation; owner and employee accounts are provisioned directly"*). Nothing in this runbook works around that; it formalizes the manual process the application already assumes.

**Guiding principle.** Wherever the application itself provides a tested, safe way to create a piece of data (the owner filling out Settings, the owner adding an employee through Staff, the owner completing Stripe Checkout), this runbook prefers that path over hand-written SQL. Manual SQL is used only for the identity records that have no self-service equivalent: the workspace row itself, the Supabase Auth user, and the membership linking them.

---

## 0. Read-only schema preflight (run before any write, every time)

Three tables central to this runbook — `workspaces`, `profiles`, `workspace_memberships` — are **not defined in this repository's tracked migrations** (`migrations/001` through `016`). They predate migration tracking (see `lib/workspace.ts`'s comment referencing "the Phase 1 tenant-foundation migration," which is not a file in this repo) and are known to this runbook only through how existing application code reads and writes them. Do not assume any column beyond what is listed below exists, and do not assume one does *not* exist without checking.

Run this first, every time, and compare the output against the "Known columns" note under each table before writing anything:

```sql
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name in ('workspaces', 'profiles', 'workspace_memberships', 'company_settings', 'subscriptions', 'employees')
order by table_name, ordinal_position;
```

**Known columns, from verified code evidence only:**
- `workspaces` — has at least `id` (uuid). Referenced only as a foreign-key target (`subscriptions.workspace_id references workspaces(id)`, `migrations/015_create_billing_schema.sql:41`). No application code ever `SELECT`s or `INSERT`s into `workspaces` directly — its full column list is unverified. **Confirm via the preflight query above before inserting anything beyond `id`.**
- `profiles` — existence confirmed only by `migrations/014_enable_rls_no_policies.sql:63` (RLS enablement) and `docs/SECURITY.md:282` (prose reference). **No code path in this repository ever queries or writes `profiles`.** Whether Supabase Auth auto-populates a row here on user creation (a common Supabase convention, via a database trigger) is **not verified** from this repository. This runbook does not require a `profiles` row to exist for login to work — see §5.
- `workspace_memberships` — confirmed columns, from the one query that reads it (`app/api/auth/login/route.ts:125-130`): `profile_id`, `workspace_id`, `role`. Whether `role` is a free-text column or a constrained enum, and whether any other column is `NOT NULL` without a default, is **not verified**. Confirm via the preflight query before inserting.
- `company_settings` — confirmed columns, from `app/api/settings/company/route.ts`: `id`, `workspace_id`, `company_name`, `phone`, `email`, `address`, `city`, `state`, `zip`, `booking_enabled`, `notifications_enabled`, `updated_at`.
- `subscriptions` — fully defined in `migrations/015_create_billing_schema.sql:39-80` and widened by `migrations/016_add_trial_and_access_lifecycle.sql`. Full column list: `id`, `workspace_id` (unique), `billing_mode`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_status`, `trial_start`, `trial_end`, `current_period_end`, `grace_until`, `cancel_at_period_end`, `canceled_at`, `last_event_created_at`, `created_at`, `updated_at`, `trial_consumed_at`, `access_ended_at`.
- `employees` — fully defined across `migrations/006_create_employees.sql`, `008_add_employee_auth.sql`, `011_add_employee_position.sql`, `013_add_is_demo.sql`, plus a `workspace_id` column added outside tracked migrations (same Phase-1 gap as above — confirm via preflight). Known columns: `id`, `name`, `phone`, `color`, `active`, `created_at`, `email`, `password_hash`, `position`, `is_demo`, `workspace_id`.

If the preflight query reveals a `NOT NULL` column without a default on `workspaces`, `profiles`, or `workspace_memberships` that isn't listed above, **stop and treat that as missing evidence** — do not guess a value. Supply it manually based on what the column name plainly indicates (e.g. a `created_at timestamptz not null default now()` needs no value), and if its purpose isn't self-evident, stop and get it confirmed before writing.

---

## 1. Information collected from the customer

Before starting any provisioning step, collect and record:

| Field | Notes |
|---|---|
| Business (company) name | Goes into `company_settings.company_name` |
| Owner's legal/contact name | For your own records; not a distinct application field |
| Owner's login email | **Trim and lowercase before use anywhere** (safety requirement). This becomes the Supabase Auth email. |
| Owner's phone (optional) | `company_settings.phone` |
| Business address (optional) | `company_settings.address` / `city` / `state` / `zip` |
| Business contact email/phone for clients (optional) | `company_settings.email` / `phone` — may differ from the owner's login email |
| Whether they want public online booking | Default is **disabled**; see §6's important limitation before agreeing to enable it |
| Whether they want client email/SMS reminders on from day one | Default is **disabled**; see §6 |
| Initial employees to create (name, phone, position, login email if they need PWA access) | Each login email must be checked for collisions — see §7 |
| Agreement that billing is via Stripe Checkout with a 30-day trial | Confirms `billing_mode = 'stripe'`, not `'internal'` (internal mode is reserved for Nova Labs' own workspaces — `migrations/015_create_billing_schema.sql:60-61`) |

---

## 2. Read-only preflight checks

Run all of these before writing anything. All are `SELECT`-only.

**2.1 — Confirm the schema preflight from §0** has been run and reviewed.

**2.2 — Confirm the intended new workspace ID doesn't already exist:**
```sql
select id from workspaces where id = '<NEW_WORKSPACE_ID>';
```
Expect zero rows. If it returns a row, generate a different UUID — never reuse an ID that already exists, and never reuse the two reserved IDs below under any circumstance:
- Internal (Alberto's own) workspace: `c6053b32-8c71-498f-8f13-218579805d4d` (`lib/workspace.ts:7`)
- Demo/tester workspace: `e3e8f3a7-c114-4d4c-9f15-590188a654b6` (`lib/workspace.ts:8`)

**2.3 — Confirm the owner's email doesn't already exist in Supabase Auth** (Supabase Dashboard → Authentication → Users → search). Auth email uniqueness is enforced by Supabase itself, not by this app.

**2.4 — Run the employee-email collision inventory (§7) for every planned employee email** before creating any of them.

**2.5 — Confirm current production baseline is undisturbed** (for Alberto's own confidence, not required by the app): the internal workspace's `subscriptions` row should still show `billing_mode = 'internal'` with every Stripe/trial/lifecycle column `NULL`:
```sql
select billing_mode, stripe_customer_id, stripe_status, trial_consumed_at, access_ended_at
from subscriptions
where workspace_id = 'c6053b32-8c71-498f-8f13-218579805d4d';
```
Expect `billing_mode = 'internal'` and every other listed column `NULL`.

---

## 3. Database provisioning — the new workspace row

**Purpose:** the root identity every other record (subscription, company settings, employees, membership) references.
**Prerequisite:** §2 preflight checks passed; a fresh UUID generated for `<NEW_WORKSPACE_ID>`.
**Table:** `workspaces`
**Fields supplied:** `id = <NEW_WORKSPACE_ID>` only, unless §0's preflight reveals additional required columns.
**Fields generated:** none known beyond defaults the preflight reveals (e.g. a `created_at` with `default now()` needs no value).
**Fields left null/untouched:** any column not required by the preflight.

```sql
begin;
insert into workspaces (id) values ('<NEW_WORKSPACE_ID>');
-- If §0's preflight revealed additional NOT NULL columns with no default,
-- add them to the insert above before running. Do not guess a value for
-- an unexplained column — stop and confirm first.
commit;
```

**Verify immediately:**
```sql
select id from workspaces where id = '<NEW_WORKSPACE_ID>';
```
Expect exactly one row.

**If this step fails:** nothing downstream references this row yet — simply fix the error and retry. No recovery beyond correcting the statement is needed.

---

## 4. Supabase Auth owner creation

**Which should be created first — the workspace row or the Auth user?** Evidence from `app/api/auth/login/route.ts:118-141` shows the two are connected only through `workspace_memberships` at login time; neither table references the other directly. **Order does not matter for correctness**, but this runbook creates the workspace row first (§3) so that `workspace_memberships` (§5) can be written in one pass immediately after the Auth user exists, minimizing the window where an Auth user exists with no membership.

**Purpose:** the credential-verification identity for the new owner. ScheduleFlowTrack owner login is verified exclusively through Supabase Auth (`docs/SECURITY.md:27`, `app/api/auth/login/route.ts:118-119`) — there is no separate password field on any app-level table for owners.

**Procedure (Supabase Dashboard → Authentication → Users → "Add user"):**
1. Email: `<OWNER_EMAIL_LOWERCASE>` — trim and lowercase before entering (safety requirement).
2. Password: set a strong, unique password **directly in the dashboard's password field**. Do not type it into any SQL statement, shell command, chat message, or file. Communicate it to the customer through a channel that isn't this session or this document (e.g. verbally, or a password manager's secure share).
3. Confirm the user's email as verified if the dashboard offers that option (avoids a confirmation-email dependency that isn't part of this app's flow).
4. **Record the generated Auth user's UUID** — this is `<OWNER_AUTH_USER_ID>`, needed immediately in §5. It is not a secret (it's an identifier, not a credential), but treat the password as fully secret and never write it anywhere persistent.

**Verify immediately:** confirm the new user appears in Authentication → Users with the correct, lowercased email and the UUID you recorded matches.

**If this step fails partway** (e.g. the dashboard errors after partially creating the user): check Authentication → Users for a partial/duplicate entry before retrying. Supabase Auth enforces its own email uniqueness, so a genuine duplicate attempt will simply be rejected, not silently create two accounts.

**If Auth user creation succeeds but §5 (membership) fails or is not yet done:** the Auth user is safe to leave as-is — it grants no application access on its own (see §5's isolation proof). Simply retry §5 with the same `<OWNER_AUTH_USER_ID>`. Do not delete and recreate the Auth user; that only risks losing track of which UUID was actually issued.

---

## 5. Workspace membership creation

**Purpose:** the *only* record that actually connects a verified Auth identity to a workspace and a role. Until this row exists, the new Auth user can authenticate against Supabase but `app/api/auth/login/route.ts:136-140` finds no matching membership and returns the same generic "Invalid email or password" error as a wrong password — **an Auth user with no membership row cannot log into ScheduleFlowTrack at all.** This is the structural reason a partially-provisioned owner (§4 done, §5 not yet done) is safe: they simply cannot get in.

**Prerequisite:** §3 (workspace row exists) and §4 (Auth user exists, `<OWNER_AUTH_USER_ID>` recorded).
**Table:** `workspace_memberships`
**Fields supplied:** `profile_id = <OWNER_AUTH_USER_ID>`, `workspace_id = <NEW_WORKSPACE_ID>`, `role = 'owner'`.
**Which role value is valid:** the only role value this repository's code ever checks for is the literal string `'owner'` (`app/api/auth/login/route.ts:129`). No other role value has any verified meaning to the login route.
**Which ID connects the Auth user to this table:** `profile_id`, compared directly against `authData.user.id` from Supabase Auth's own `signInWithPassword` response (`route.ts:124,128`) — **not** a separate `profiles.id` lookup; no code path queries `profiles` at all (see §0). Use the Auth user's own UUID as `profile_id` directly.
**Fields left null/untouched:** any column not required by §0's preflight.

**Before inserting, check for an existing membership for this Auth user** (avoids creating a second `role='owner'` row for the same person, which would break the login route's `.maybeSingle()` call — see §11):
```sql
select profile_id, workspace_id, role from workspace_memberships where profile_id = '<OWNER_AUTH_USER_ID>';
```
Expect zero rows before your first insert for this person.

```sql
begin;
insert into workspace_memberships (profile_id, workspace_id, role)
values ('<OWNER_AUTH_USER_ID>', '<NEW_WORKSPACE_ID>', 'owner');
-- If §0's preflight revealed additional NOT NULL columns with no default,
-- add them here before running.
commit;
```

**Verify immediately:**
```sql
select profile_id, workspace_id, role from workspace_memberships where profile_id = '<OWNER_AUTH_USER_ID>';
```
Expect exactly one row, `workspace_id = '<NEW_WORKSPACE_ID>'`, `role = 'owner'` — never the internal or demo workspace ID.

**How owner login resolves the workspace (for your understanding, not a step to run):** on successful password verification, the login route looks up exactly this row by `profile_id` + `role='owner'`, takes its `workspace_id`, and signs it into the session cookie (`sft_session`) — every subsequent request trusts that signed value, never re-querying `workspace_memberships` again for the life of that session (`lib/session.ts`, `lib/sessionCrypto.ts`).

**How to verify the new owner cannot access the internal or demo workspace:** this is structural, not something to configure separately — it follows entirely from this row containing `<NEW_WORKSPACE_ID>` and nothing else. Practical proof (done in §10, Production Verification): log in as the new owner and confirm the dashboard shows **zero** clients, employees, appointments, and services. Seeing *any* existing data (especially anything resembling Alberto's real business) is the single clearest sign this step was misconfigured — most likely `<NEW_WORKSPACE_ID>` was mistyped as `c6053b32-8c71-498f-8f13-218579805d4d` by accident. If that happens, stop immediately, do not let the customer proceed, and fix the membership row's `workspace_id`.

**If this step fails partway:** re-run the "before inserting" check above before retrying — it tells you definitively whether the insert already landed.

---

## 6. Company settings initialization

**Recommended procedure: let the owner do this themselves.** `POST /api/settings/company` (`app/api/settings/company/route.ts:66-119`) already safely creates the `company_settings` row on first save (insert-if-missing, update-otherwise) with correct trimming and null-handling, exactly matching this table's real shape — this is safer than hand-written SQL because the owner's own use of Settings → Company Info exercises the same tested code path every existing customer uses.

**Sequencing note:** `company_settings` writes require the `canMutateOperationalData` capability, which depends on a `subscriptions` row existing with full-access status (`lib/entitlementServer.ts`, `lib/entitlement.ts`). A brand-new workspace has **no** `subscriptions` row yet at this point — so the owner cannot save Company Info until **after** §9 (Stripe trial activation) grants full access. Tell the customer's owner: *log in, you'll see a "start your subscription" prompt first — complete that, then fill in Company Info.* Do §9 before asking the owner to do this step.

**One setting needs explicit operator attention before the owner's first save, because it cannot currently be made to work at all — not merely because its default is unsafe:**

- **Public booking (`booking_enabled`)** — **must remain disabled for every new customer workspace, and cannot currently be safely enabled at all**, regardless of what the customer requests. This is a hard architectural limitation, not a policy choice: `app/api/book/availability/route.ts:11,28,34,59,73`, `app/api/appointments/create/route.ts:12`, and `app/book/page.tsx:4,14,18` are **all hardcoded to the single constant `REAL_WORKSPACE_ID`** (Alberto's own workspace). A new customer's `booking_enabled` toggle has no effect on any public-facing route — the public booking page and API will only ever read and write Alberto's own workspace's data, never the new customer's. **Do not enable this for a new customer under any circumstance until the public booking routes are made workspace-aware** (see §12). If a customer explicitly requests public booking, tell them it isn't available yet rather than turning the toggle on and having it silently do nothing (or worse, be misunderstood as working).

**Notifications (`notifications_enabled`) — resolved, Phase 5.7C.** Both the stored default (no row yet, or a `false` row) and the Company Info panel's own in-browser form state now default to `false` consistently (`app/components/dashboard/CompanyInfoPanel.tsx:75-91`; both `notificationsEnabled` and `notificationsSaved` initialize `false`, matching `bookingEnabled`/`bookingSaved`). A brand-new workspace, or any Settings save that doesn't touch this toggle, can no longer silently persist a never-loaded `true`. This does not remove the operator's own responsibility, though: **before customer handoff, explicitly open Settings → Automation as the new owner and confirm the "Enable Client Notifications" toggle reflects what the customer actually wants** (still `false`/off by default until the owner deliberately turns it on) — record that confirmation in §10's verification matrix (#13) as before. The fix removes the *accidental* path to `true`; it does not remove the need to check what the customer intends.

---

## 7. Employee-email collision gate

Run this **before every single employee creation**, not just once per workspace.

**7.1 — Collision check for one proposed email** (copy-ready; replace `<PROPOSED_EMAIL_LOWERCASE>` with the trimmed, lowercased candidate):
```sql
select
  workspace_id,
  is_demo,
  (email = '<PROPOSED_EMAIL_LOWERCASE>')          as exact_match,
  (lower(trim(email)) = '<PROPOSED_EMAIL_LOWERCASE>') as case_or_whitespace_match
from employees
where email is not null
  and lower(trim(email)) = '<PROPOSED_EMAIL_LOWERCASE>';
```
This returns only `workspace_id` (an identifier, not personal information), `is_demo`, and two booleans — no employee name, phone, or password hash. It detects, in one query: exact duplicates, case-only duplicates, and leading/trailing-whitespace equivalents (via `lower(trim(...))`), and shows whether the match is in *this* new workspace, a *different* workspace, or the demo workspace (`is_demo = true`, which should never match — see §7.3).

**Decision rule (mandatory):**
- **Zero rows returned:** proceed — create the employee (see below).
- **One or more rows returned:** **stop.** Do not insert the employee. Do not change `idx_employees_email` or any index to work around this — that decision was already made and is final for this phase (Phase 5.7A: keep the current global unique index; migration 017 is deferred). Resolve manually: ask the customer for a different login email for this employee, or — if the collision is with an employee who has since left another business and the email is safe to hand off — that is a judgment call for Alberto, not something this runbook automates. If neither is acceptable right now, defer that employee's login access until workspace-aware employee authentication exists (Phase 5.7A, §9/§10 of that audit).

**7.2 — Full-table normalized-duplicate inventory** (run periodically, or before a batch of employee creations, to catch anything the per-email check above might have been run too late for):
```sql
select lower(trim(email)) as normalized_email, count(*) as row_count, count(distinct workspace_id) as workspace_count
from employees
where email is not null and trim(email) <> ''
group by lower(trim(email))
having count(*) > 1;
```
Expect zero rows (the existing global unique index should already prevent this — a non-empty result here indicates a case/whitespace near-duplicate the index didn't catch, since the index is case-sensitive and not trimmed; see Phase 5.7A finding).

**7.3 — Demo collision check** (should always return zero — included for defense-in-depth, not because it's expected to ever fire):
```sql
select count(*) as demo_real_collisions
from (select lower(trim(email)) as h from employees where is_demo = true  and email is not null and trim(email) <> '') d
join (select lower(trim(email)) as h from employees where is_demo = false and email is not null and trim(email) <> '') r on d.h = r.h;
```
Demo employees are seeded with no email at all (`scripts/seed-demo-data.cjs:16-20`), so this should always be `0`.

**7.4 — Malformed/blank email inventory:**
```sql
select
  count(*) filter (where email is not null and trim(email) = '')                                         as blank_email_count,
  count(*) filter (where email is not null and trim(email) <> '' and email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') as malformed_email_count
from employees;
```

**Creating the employee, once §7.1 returns zero rows:** use the owner's own Staff panel (which calls `POST /api/employees`, `app/api/employees/route.ts:42-83`) with `<OWNER_EMAIL_LOWERCASE>`'s session. This is the **only verified supported procedure for setting an employee's password** — the route hashes it server-side with `bcrypt.hash(pw, 10)` (`route.ts:69`). **Never compute or paste a bcrypt hash manually into a `password_hash` column.** If an employee must be created directly via SQL for some operational reason, leave `password_hash` and `email` as they are supplied (email lowercased/trimmed) but **leave `password_hash` NULL** — the employee simply cannot log in (the login route requires `!!emp.password_hash`, `app/api/auth/login/route.ts:86`) until the owner sets a password for them through the app's own Staff panel edit form afterward.

---

## 8. Subscription/billing initialization

**Recommended procedure: do not pre-create a `subscriptions` row at all.** `claimSubscriptionRow` (`lib/stripeCheckout.ts:26-48`) — invoked automatically the first time the owner clicks "Start subscription" / opens billing from the dashboard — safely creates the row itself: `insert into subscriptions (workspace_id, billing_mode) values (<workspace_id>, 'stripe')`, with every other column left at its schema default (`NULL` / `false`). This is the exact, already-tested path every real Checkout attempt uses, including its own race-safety handling (a concurrent duplicate insert loses to the unique `workspace_id` constraint and simply re-reads the winning row). Letting the app do this avoids hand-typing a row that must exactly match what the app itself expects.

**If Alberto ever needs to pre-create it anyway** (e.g. to confirm the workspace is ready before handing off to the customer), the exact equivalent statement is:
```sql
insert into subscriptions (workspace_id, billing_mode) values ('<NEW_WORKSPACE_ID>', 'stripe');
```
Do **not** set `billing_mode = 'internal'` for a paying external customer — `internal` mode grants unconditional full access with no Stripe billing at all (`lib/entitlement.ts:385-387`) and is reserved for Nova Labs' own workspaces; a `CHECK` constraint (`subscriptions_internal_mode_has_no_stripe_data`, `migrations/015_create_billing_schema.sql:66-79`) additionally forbids an `internal` row from ever carrying Stripe/trial data, so the two modes cannot be mixed even by mistake.

**Before Stripe Checkout — the minimum safe state:** either no `subscriptions` row at all, or exactly the bare row above (`billing_mode='stripe'`, every other column `NULL`/`false`). In this state, the entitlement resolver reports `no_subscription` (no row) or `malformed_missing_status` (bare row, no `stripe_status` yet) — both resolve to locked capabilities with billing/reactivation still reachable (`lib/entitlement.ts:44-49,385-509`). This is expected and correct: the new owner will see a "start your subscription" prompt, not the dashboard, until Checkout completes. This is not a broken state — it's the same state a bare-row workspace sits in for the seconds between claiming the row and being redirected to Stripe.

---

## 9. Stripe trial activation

This section is where a live, operator/customer action is genuinely required — it cannot be completed by editing this document or running SQL. Steps marked **[LIVE ACTION]** are for the actual onboarding day, not for this documentation phase.

**9.1 — [LIVE ACTION] The new owner logs in** (§4/§5 must be complete) and clicks whatever "Start subscription" / "Start free trial" control the locked dashboard state presents (this reuses the existing `recoveryAction: "checkout"` path already built for the `no_subscription` state — no new UI is needed).

**9.2 — How to verify the correct workspace is attached:** `POST /api/stripe/checkout` (`app/api/stripe/checkout/route.ts:16-21`) takes **no request body** — it resolves `workspaceId` exclusively from the caller's signed session. There is no way for the wrong workspace to be attached as long as §5 was done correctly; there is nothing to separately configure on the Stripe side for this.

**9.3 — How the trial is granted exactly once:** `trialEligible = row.trial_consumed_at === null` (`app/api/stripe/checkout/route.ts:52`), read fresh from this workspace's own `subscriptions` row at the moment Checkout is created — never a client-supplied value (the route takes no body at all). For a brand-new workspace, this is always `true` on the first Checkout attempt.

**9.4 — [LIVE ACTION] The owner completes Checkout** (enters payment details; per your already-verified Stripe Customer Portal configuration, cancellation is end-of-billing-period, and the live price is $24.99/month with a 30-day trial).

**9.5 — How to verify Stripe identifiers land in the correct workspace row after Checkout:**
```sql
select workspace_id, billing_mode, stripe_customer_id, stripe_subscription_id, stripe_status, trial_start, trial_end, trial_consumed_at
from subscriptions
where workspace_id = '<NEW_WORKSPACE_ID>';
```
Expect `stripe_customer_id` and `stripe_subscription_id` both populated, `stripe_status = 'trialing'`, `trial_consumed_at` populated (see 9.6), and no other workspace's row changed.

**9.6 — `trial_consumed_at` is set only after Stripe confirms the trial, never merely because Checkout was opened.** This is enforced by the webhook handler, not by Checkout itself: `handleCheckoutSessionCompleted` (`lib/stripeWebhook.ts:517-...`) only runs on the `checkout.session.completed` **event Stripe sends**, re-fetches the live subscription from Stripe directly (never trusting the session payload's own snapshot), and only then computes `trial_consumed_at` from the live subscription's own `trial_start` field (`computeTrialConsumedPatchField`, first-write-wins, never cleared afterward). **Do not manually set `trial_consumed_at`** for any reason — if Checkout is opened but abandoned, no `checkout.session.completed` event is ever sent, and this column correctly stays `NULL`, preserving trial eligibility for a genuine retry. **Do not manually invoke the Stripe webhook** — its correctness depends on Stripe's own signature (`STRIPE_WEBHOOK_SECRET`) and the real event payload; nothing in this runbook substitutes for a real Stripe delivery.

**9.7 — How to verify the entitlement resolver grants the expected access after the webhook lands:** `stripe_status = 'trialing'` resolves to full operational access (`lib/entitlement.ts:14`, "Full operational access ... Stripe status = trialing"). Practical check: log in as the new owner and confirm the dashboard renders normally (no locked/read-only banner), and Settings/Employees/Clients are all reachable.

**9.8 — A previously consumed trial is not offered again:** once `trial_consumed_at` is non-null, `trialEligible` is `false` on every future Checkout attempt for this workspace (`app/api/stripe/checkout/route.ts:52`), so `trial_period_days` is omitted entirely from the session — Stripe bills immediately (`lib/stripeCheckout.ts:127-155`). This holds regardless of cancellation or reactivation in between, by design (`lib/entitlement.ts:76-80`, "one 30-day trial per workspace, ever").

**9.9 — A canceled trial does not restore access merely because nominal trial time remains:** cancellation is driven by Stripe's own `stripe_status` transition (to `canceled`), not by comparing the current time against `trial_end`. The resolver only grants full access while `stripe_status` is literally `trialing` or `active` (or `past_due` inside its 3-day grace) — the moment Stripe reports `canceled`, the workspace immediately moves to the `canceled` read-only/locked lifecycle (§ next section), regardless of how many nominal trial days were left on the clock.

**No live payment or webhook test was performed during this documentation phase**, per the phase's constraints — §9.1, 9.4, and any real trial verification are explicitly future, operator-day actions.

---

## 10. Production verification (final pass/fail matrix)

Run this in full for every new customer, after §9 completes. All checks are either a real login (owner/employee credentials the customer/operator already has) or a read-only query — nothing here mutates data.

| # | Check | How | Pass condition |
|---|---|---|---|
| 1 | Owner login succeeds | Log in as the new owner | `200`, redirected to `/dashboard` |
| 2 | Owner session contains the new workspace ID | Inspect the signed session cookie is opaque by design; instead confirm behaviorally via #3 | N/A directly — proven by #3 |
| 3 | Owner sees only the new workspace's records | View Clients/Employees/Appointments/Services after login | All lists start empty (or contain only what was deliberately entered) — zero rows resembling Alberto's real business |
| 4 | Owner cannot see internal or demo data | Same view as #3 | No cross-workspace data visible anywhere |
| 5 | Employee login succeeds with the normalized email | Log in as an employee using the exact lowercased email stored | `200`, redirected to `/schedule` |
| 6 | Employee session contains both the correct employee ID and workspace ID | Structural — session is signed with both at login (`lib/session.ts:41-49`) | Confirmed by #7 |
| 7 | Employee sees only appointments assigned within that workspace | View `/schedule` as the employee | Only this workspace's own appointments appear |
| 8 | Company information is correct | Owner reviews Settings → Company Info | Matches what was collected in §1 |
| 9 | Public booking remains in the approved state | Confirm `booking_enabled` is `false` for this workspace, and that it was **not** enabled per §6's hard limitation | `false`, and customer informed it isn't available yet |
| 10 | Subscription belongs to the correct workspace | Run §9.5's query | `workspace_id` matches `<NEW_WORKSPACE_ID>` exactly |
| 11 | Trial eligibility is correct | `trial_consumed_at` populated once, `stripe_status = 'trialing'` | As in §9.5/9.6 |
| 12 | Entitlements match Stripe status | Dashboard renders full access, no locked/read-only banner | Confirmed visually |
| 13 | No test email or SMS was sent unintentionally | Check Resend/Twilio dashboards for unexpected sends during onboarding, and confirm §6's `notifications_enabled` review happened | No unexpected sends |
| 14 | No existing workspace was altered | Re-run §2.5's internal-workspace query | Unchanged from the pre-onboarding baseline |
| 15 | Audit/log evidence contains no secrets | Review any screenshots/logs kept from this onboarding | No password, service-role key, Stripe secret, webhook secret, or session secret visible anywhere |
| 16 | Logout works for owner and employee | `POST /api/auth/logout` for each | Cookie cleared, redirected to `/login` |

---

## 11. Failure handling and rollback

General principle for this entire runbook: **recovery preserves evidence and isolates incomplete provisioning; it never deletes.** No step in this document uses an unscoped `UPDATE` or `DELETE`, and none is provided below either.

- **Workspace row created, nothing else done, and onboarding is abandoned:** leave it. An orphaned `workspaces` row with no membership, no subscription, and no data is inert — nothing can reach it (no login path resolves to it without a `workspace_memberships` row). Note it in your own records as abandoned; do not attempt to delete it as part of this runbook (deletion isn't covered here and isn't needed for safety).
- **Auth user created, membership step failed or skipped:** see §4's recovery note — retry §5 with the same recorded `<OWNER_AUTH_USER_ID>`.
- **Membership created pointing at the wrong workspace ID (the most consequential realistic mistake):** stop customer access immediately (do not let them log in again until fixed). Correct with a precisely scoped update, never a broad one:
  ```sql
  update workspace_memberships
  set workspace_id = '<CORRECT_NEW_WORKSPACE_ID>'
  where profile_id = '<OWNER_AUTH_USER_ID>' and role = 'owner';
  ```
  Verify with §5's own verification query afterward, and re-run Production Verification #3/#4 before allowing the customer back in.
- **Checkout completed but the webhook appears not to have landed** (dashboard still shows locked/no-subscription after a few minutes): do not manually set any `subscriptions` column. Check Stripe Dashboard → Developers → Webhooks → your endpoint's recent delivery attempts for this event; if it shows a failed delivery, Stripe will retry automatically per its own schedule. Do not manually invoke the webhook route. If it's still not resolved after Stripe's own retries are exhausted, that's an engineering incident, not something this runbook's manual steps should paper over.
- **An employee was created with a colliding email despite §7** (should not happen if followed): do not attempt an in-place fix that touches the unique index. Deactivate the employee (`active = false`) through the owner's own Staff panel (uses the tested `PATCH /api/employees` path, workspace-scoped) while the collision is resolved, rather than a manual SQL `UPDATE`.

---

## 12. Remaining hardcoded workspace assumptions (found during this investigation)

- **Public booking is fully single-tenant** — `REAL_WORKSPACE_ID` is hardcoded in `app/api/book/availability/route.ts`, `app/api/appointments/create/route.ts` (public branch), and `app/book/page.tsx`. This is the most consequential finding of this phase: a new customer's `booking_enabled` toggle is currently inert. See §6.
- **`lib/workspace.ts`** itself documents this pattern is intentional-for-now: *"Phase 3+ (real multi-tenant signup) will replace fixed constants like this with a real resolution step."* Five files reference `REAL_WORKSPACE_ID` directly (confirmed by search); this runbook's manual process is the correct workaround for the workspace-identity/login/settings/subscription flow, but does **not** and cannot work around the public-booking limitation, because that limitation is in code paths this runbook has no authority to change (this phase is documentation-only).
- **No workspace-provisioning API exists** — confirmed by search: nothing in this repository ever `INSERT`s into `workspaces`, and no signup/registration route exists anywhere. This runbook's manual SQL in §3/§5 is not a workaround for a hidden feature — it is currently the *only* way a second real workspace can come into existence.

---

## 13. Customer handoff

- Provide the owner their login email (already lowercased) and confirm they've received their password through a secure channel (never this document, never chat, never a screenshot).
- Walk them through: logging in, starting their subscription/trial (§9.1), completing Company Info (§6, after §9 grants access), adding employees themselves via Staff (preferred over Alberto doing it for them, so they see the real product experience — though Alberto may run the §7 collision check on their behalf first if they're adding employees while Alberto is still present).
- Explicitly tell them public online booking is not available yet (§6/§12) if they ask, rather than leaving it ambiguous.
- Point them at `/terms` and `/privacy` (already linked from the login page footer) if they ask about data handling — see §14 below for exactly what those documents currently say.

---

## 14. Post-onboarding monitoring

- Watch Resend/Twilio dashboards for this customer's first real notification sends once `notifications_enabled` is turned on, to confirm delivery is working as expected.
- Watch the hourly `/api/cron/reminders` run (already live in production) for this workspace's first real appointment reminder — no action needed, just confirm via provider logs that it succeeded, not via manually invoking the cron endpoint.
- Confirm the customer's first Stripe invoice (after the 30-day trial ends) processes normally in the Stripe Dashboard.
- Re-run §2.5's internal-workspace and demo-workspace snapshots periodically as a cheap "nothing bled across workspaces" sanity check, especially after onboarding each additional customer.

---

## Cancellation and retained-data policy

This section documents behavior, it does not change it — no code or schema is touched by this runbook.

- **Canceling during the free trial ends operational access at that point** — Stripe's own trial-cancellation behavior (there is no "remaining paid period" to run out during a trial), reflected the moment the webhook reports `stripe_status = 'canceled'`.
- **Canceling after paid service continues normal access through the paid billing period** — your already-verified Stripe Customer Portal configuration cancels "at end of billing period"; the resolver grants full access for as long as `stripe_status` remains `'active'` (`cancel_at_period_end` being `true` does not by itself restrict access — only the eventual `stripe_status` transition to `'canceled'` does).
- **After paid access ends, the account becomes read-only for 30 calendar days from `canceled_at`**, then locked (view/export also denied) after that — `lib/entitlement.ts:18-36`. Billing/reactivation remains reachable throughout both phases.
- **Data is not automatically deleted** when a trial or paid subscription ends, at any point in this lifecycle — confirmed by direct code reading: the only `.delete()` call against real business-data tables in this repository is in `app/api/services/route.ts`, and it is scoped exclusively to `is_demo = true` rows (line 154 checks `if (!data?.is_demo) return ... 404` before deleting) — a normal owner action on sandbox data, never triggered by subscription or entitlement state, and never reachable against a real (`is_demo = false`) row. No route or cron job deletes real `clients`, `appointments`, `employees`, or `services` rows for any reason tied to subscription lifecycle. The entitlement model only ever changes what's *shown*, never what's *stored* (`lib/entitlement.ts:70-74`).
- **Existing entries remain stored in case the customer returns** — matches the above; reactivation (a fresh Checkout / subscription resuming `active`) restores full access to the same, untouched data.
- **Any future annual inactivity assessment and deletion process is separate, unbuilt work** and is explicitly not performed or implied by this runbook — no such job exists in this repository today (confirmed by search: no scheduled or cron-invoked deletion logic exists anywhere).

**Discrepancy check against Terms/Privacy — none found.** I read both documents in full for this phase specifically to check for contradictions with the policy above:
- `app/terms/page.tsx:196-200` — *"nothing is deleted, altered, or lost during the read-only or [locked] period... We do not promise that your data will be retained indefinitely. Any future deletion of a long-inactive [account]..."* — matches.
- `app/privacy/page.tsx:147-171` (sections 13–14, "Data Retention" and "Read-Only Access and Retention After Cancellation") — explicitly states no automated deletion system exists today, that any future policy would require advance notice and a reactivation opportunity, and that this section "describes our administrative policy, not a [live system]." — matches exactly.
- `app/privacy/page.tsx:209-218` (section 18) — describes a manual, contact-us deletion request process, consistent with "no automated deletion exists."

No promise of indefinite retention appears in either document, and none is made by this runbook. **No discrepancy found between the approved policy, the current code, and the Terms/Privacy Policy.**
