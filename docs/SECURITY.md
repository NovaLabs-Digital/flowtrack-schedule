# ScheduleFlowTrack Security Architecture

## Overview

ScheduleFlowTrack uses a small, purpose-built session system rather than a third-party auth provider. This document describes that system as it exists after Security Hardening Sprint 1 (API authorization) and Sprint 2 (session/authentication hardening), so future development stays consistent with it.

**Authentication model.** A single httpOnly cookie, `sft_session`, identifies the caller as one of four roles: `owner`, `employee`, `tester`, or (absent/invalid) `none`. The cookie's contents are cryptographically signed — the server, not the client, is the source of truth for who a session belongs to.

**Authorization model.** Every API route is individually responsible for checking the caller's role before returning data or making a change. `middleware.ts` only gates page navigation (`/dashboard`, `/schedule`); it does not protect `/api/*`. This is a deliberate architectural fact, not an oversight — see [Middleware](#middleware) and [Development Rules](#development-rules).

**Design philosophy.** Simple, dependency-light, and legible over clever. No external auth provider, no session database, no distributed cache — the whole system is a few small files. This matches the project's general engineering philosophy: favor the solution that requires less explanation, appropriate to the scale of a single-owner/small-team business tool.

**Security goals.**
- Real business data (clients, appointments, staff, settings) is reachable only by an authenticated owner, or by a tester strictly scoped to demo data.
- Employees can reach only the narrow slice of functionality the field PWA needs.
- Session cookies cannot be forged, replayed past their expiry, or trusted without server-side verification.
- Failures in configuration (e.g. a missing secret) fail *closed* — toward denying access — never open.

---

## Authentication

All three roles authenticate through the same endpoint, `POST /api/auth/login`, distinguished by the `role` field in the request body (`"employee"` vs. owner/tester, resolved by matching credentials).

### Owner login flow

As of Phase 3 (tenant-foundation auth migration), **Supabase Auth is the sole owner credential verifier**. The temporary `ADMIN_EMAIL` / `ADMIN_PASSWORD` environment-variable fallback that existed briefly during the migration has been removed, after production verification confirmed the Supabase Auth path resolving correctly and consistently.

1. Client submits `email` + `password` (no `role` field, distinguishing it from employee login).
2. An isolated, request-local Supabase client — created fresh per request with the anon key (`SUPABASE_URL` / `SUPABASE_ANON_KEY`), `persistSession: false`, `autoRefreshToken: false`, `detectSessionInUrl: false` — calls `auth.signInWithPassword()`. This client is deliberately separate from the shared service-role `supabaseAdmin` client and holds no elevated database privileges; any session/token it receives is read only long enough to extract the authenticated user's id, then discarded — never stored, never sent to the browser. Only the existing `sft_session` cookie is ever issued.
3. On success, the shared `supabaseAdmin` client (service-role) resolves the caller's workspace by looking up `workspace_memberships` for that user id with `role = "owner"`. Login succeeds only if **both** conditions hold: Supabase Auth verifies the credentials, **and** a matching `workspace_memberships` row is found. Either condition failing produces the same generic error.
4. On success, the server creates a signed session payload `{ role: "owner", workspaceId, exp }` and sets it as the `sft_session` cookie.
5. On failure, the same generic `Invalid email or password` error is returned — the same message used for every other failure case on this endpoint.
6. Server logs record a fixed `OWNER_LOGIN_SUCCESS` tag on success (with no `authPath` distinction now that there is only one path), and fixed tags (`OWNER_AUTH_MEMBERSHIP_MISSING`, `OWNER_AUTH_MEMBERSHIP_QUERY_ERROR`) when Supabase Auth succeeds but workspace resolution fails — never the submitted email, password, profile id, or any Supabase Auth token.

### Employee login flow

1. Client submits `email` + `password` + `role: "employee"`.
2. Server looks up the employee by email and checks their bcrypt-hashed password with `bcrypt.compare`.
3. The account must exist, be active, and have a matching password — any failure of any of those three conditions returns the same generic error (see [Login Protection](#login-protection) for why).
4. On success, the signed session payload is `{ role: "employee", employeeId, exp }`.

### Tester login flow

1. Client submits `email` + `password`.
2. Server compares against `TESTER_EMAIL` / `TESTER_PASSWORD` (constant-time), checked before the owner credentials.
3. On match, the signed session payload is `{ role: "tester", exp }`.
4. Tester sessions behave like a restricted owner: dashboard access, but every route that returns real business data instead scopes to `is_demo = true` rows (see [Authorization](#authorization)).

### Session lifecycle

- **Creation**: the login route signs a payload with `SESSION_SECRET` and sets it as an httpOnly, `sameSite=lax` cookie, `secure` in production, 7-day `maxAge`.
- **Verification**: every subsequent request re-verifies the cookie's signature and expiry — nothing about a session is trusted just because a cookie is present.
- **Expiration**: the signed payload carries its own `exp` claim (also 7 days), independent of the cookie's browser-enforced `maxAge`. A cookie edited to outlive its real expiry is still rejected, because the claim itself is checked and signed.
- **Signed cookies**: see [Session Architecture](#session-architecture) for the exact format.
- **SESSION_SECRET usage**: the sole key used to sign and verify every session. See [Environment Variables](#environment-variables).
- **Middleware validation**: `middleware.ts` verifies the same signed cookie to decide page-level redirects. See [Middleware](#middleware).

### Flow diagram

```
  Browser                      /api/auth/login                  Session
    |                                |                              |
    |--- email + password --------->|                              |
    |                                |-- check credentials -------->|
    |                                |   (constant-time / bcrypt)   |
    |                                |                              |
    |                                |-- sign {role, exp} ---------->
    |                                |     with SESSION_SECRET      |
    |<-- Set-Cookie: sft_session ----|                              |
    |    (signed payload.signature)  |                              |
    |                                |                              |
    |--- request + cookie --------->|  (any protected route)       |
    |                                |-- verify signature ---------->
    |                                |-- check exp ----------------->
    |                                |-- role allowed? ------------->
    |<-- 200 (authorized) or 403 ----|                              |
```

---

## Authorization

### Anonymous (no valid session)

May reach: the public booking page, the client-facing self-service appointment cancellation link (a separate, possession-based token — not a session, see [API Security](#api-security)), and the login page itself. May not reach any API route that returns or modifies business data — every such route returns `403 Unauthorized`.

### Owner

Full access to real business data: clients, appointments, employees, services, company settings, archived clients. The only role permitted to modify real (non-demo) records.

### Employee

Scoped to the field PWA's actual surface: `/schedule` (their own upcoming jobs), job start/complete tracking (`/api/appointments/job`), and logout. Employees are **flatly denied** on every owner-facing API route — there is no partial or demo-scoped access for employees, unlike testers. This reflects that an employee account represents a real staff member with no legitimate reason to reach owner tooling, demo or otherwise.

### Tester

Exists to power the Interactive Business Experience (a self-serve demo of the product). Tester sessions can reach the same dashboard UI as an owner, but every underlying route scopes reads and writes to rows flagged `is_demo = true`. A tester requesting a real (non-demo) resource by ID receives a `404`, not a `403` — from the tester's perspective, real data simply doesn't exist. One route, company settings, denies testers entirely (owner-only, no demo carve-out), since company identity isn't something the demo experience needs to simulate per-tester.

### Demo-data isolation

Every table that testers can touch carries an `is_demo` boolean. Tester-scoped queries always filter `.eq("is_demo", true)`; owner queries filter `.eq("is_demo", false)` or read unconditionally depending on the route. This is the single mechanism that keeps the public-facing demo experience from ever reading or writing real client data — it is enforced per-query, not by a separate database or schema.

### Owner-only routes

Routes that touch identity, staff records, or settings (`/api/employees` writes, `/api/settings/company`, archived-client visibility, and all appointment/client mutation routes) require `role === "owner"` (or, where a demo carve-out is intended, `owner` or `tester`). See [API Security](#api-security) for the full Sprint 1 list.

---

## Session Architecture

### Cookie format

`sft_session` holds a two-part string: `<base64url-encoded JSON payload>.<base64url-encoded HMAC signature>`. The payload contains the role, a `workspaceId` (required on every role since Phase 2 tenant scoping), (for employees) the employee ID, and an expiry timestamp. Nothing in the payload is encrypted — it isn't secret data, only tamper-evident data — but it is not human-guessable either without the signature also matching. A payload missing `workspaceId` (i.e. one signed before Phase 2) fails validation and is treated as no session at all.

### Signature

HMAC-SHA256 over the payload, computed with `SESSION_SECRET`. Verification recomputes the same HMAC and compares it against the signature on the cookie. Any difference — from a single flipped byte to a full forgery attempt — fails verification.

### Expiration

The payload carries its own `exp` (Unix timestamp), checked on every verification independently of the cookie's own `maxAge`. Both are set to the same 7-day window at login, but the signed claim is the one that actually matters for security — the cookie's browser-side expiry is a courtesy, not a control.

### Verification process

1. Split the cookie value on the last `.`.
2. Recompute the HMAC over the payload portion and compare to the signature portion.
3. If the signature doesn't match, or the value doesn't parse as `payload.signature` at all, treat the session as absent.
4. If the signature matches, decode and parse the payload; check `exp` against the current time.
5. If everything checks out, the caller's role and (if applicable) employee ID are trusted for that request.

### Tampered cookie handling

Any tampering — payload or signature — fails signature verification and the request is treated exactly as if no cookie were present at all (role: none). No partial trust, no distinct error message that would help an attacker tell "close" from "wrong."

### Expired cookie handling

A cookie that verifies correctly (real signature, real payload) but whose `exp` has passed is also treated as no session. API routes return `403`; page routes redirect to `/login`.

### Logout behavior

`POST /api/auth/logout` clears the cookie (`maxAge: 0`, empty value). There is no server-side session store to invalidate — sessions are self-contained and stateless, so logout is purely a client-side cookie clear. A signed cookie remains cryptographically valid until its `exp` passes, even after "logout," if somehow replayed from a copy saved before the clear — this is an accepted tradeoff of a stateless design (see [Known Limitations](#known-limitations)).

---

## Middleware

`middleware.ts` runs at the edge and governs **page navigation only** — it does not run for `/api/*` requests (see its `matcher` config). Its job is redirect UX, not the authorization boundary.

- **Route protection**: `/dashboard/:path*` requires `owner` or `tester`; `/schedule` requires `employee`.
- **Redirect behavior**: an employee hitting `/dashboard` is redirected to `/schedule`; an owner hitting `/schedule` is redirected to `/dashboard`; anyone without a valid session for the route they requested is redirected to `/login`.
- **API protection**: none, by design. Every `/api/*` route must independently verify the session and authorize the role — middleware is not a substitute for that check.
- **Role validation**: performed by verifying the signed `sft_session` cookie the same way any API route would (via the shared signing/verification logic), so a tampered or expired cookie is redirected exactly as an API route would reject it.

---

## API Security

*(Security Hardening Sprint 1 — see also [Security History](#security-history).)*

Before Sprint 1, several routes assumed that if a caller wasn't a `tester`, it was safe to serve them real data — with no corresponding check that the caller was actually the `owner`. That let anonymous requests and employee sessions silently fall through to full access.

- **Why owner routes are protected**: because middleware does not cover `/api/*`, every route that touches real business data now explicitly checks the caller's role via a shared `requireRole()` / `requireOwner()` helper before doing anything else.
- **Employee restrictions**: employees are denied outright on every owner-facing route (clients, archived clients, employees, services, company settings, appointment mutation) — no demo carve-out, since there's no legitimate reason for an employee session to reach any of it.
- **Tester restrictions**: testers may read/write only `is_demo = true` rows on the routes where a demo experience makes sense, and are denied outright on company settings.
- **Deleted public route**: `app/api/appointments/page.tsx` served a public, unauthenticated HTML dump of real appointment and client data (name, email, phone) with zero access control. It was unreferenced dead code and was removed outright rather than protected.

---

## Login Protection

*(Security Hardening Sprint 2 — see also [Security History](#security-history).)*

- **SESSION_SECRET**: the login route signs every new session with `SESSION_SECRET`; nothing else can produce a cookie the server will accept. See [Session Architecture](#session-architecture) and [Environment Variables](#environment-variables).
- **Rate limiting**: repeated failed login attempts from the same IP trigger a temporary lockout on `/api/auth/login`, covering both owner and employee login (they share the endpoint). This is an in-memory, per-server-instance limiter — a reasonable deterrent against casual brute force at this application's scale, not a distributed guarantee (see [Known Limitations](#known-limitations)).
- **Generic login errors**: employee login never reveals whether the failure was "no such account," "inactive account," or "wrong password" — all three return the same generic message, including matching response timing, so the login endpoint cannot be used to enumerate valid employee emails. Owner login follows the same principle.
- **Constant-time comparisons**: every secret comparison in the authentication path (owner/tester credentials, the cron endpoint's secret) uses a constant-time comparison rather than `===`, so response timing cannot leak how many leading characters of a guess were correct. Employee passwords go through bcrypt, which is constant-time by construction.
- **Startup logging removal**: diagnostic logging that printed Supabase connection details (URL prefix, key length) at process startup was removed — informational output like that has no operational purpose and unnecessarily broadens what an attacker with log access could learn.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | The sole key used to sign and verify `sft_session` cookies. Must be set in every environment (local, Preview, Production) before that environment can create or accept any session. Not shared with, or derived from, any database or third-party provider credential. |
| `TESTER_EMAIL` / `TESTER_PASSWORD` | Tester (demo experience) login credentials. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Server-side database access (bypasses row-level security — the app enforces authorization in code, not in the database). Used only for data access, never for session signing or credential verification. |
| `SUPABASE_ANON_KEY` | Used only by the isolated, request-local client created for owner Supabase Auth verification (`auth.signInWithPassword`). Never used for database access — that's `supabaseAdmin`'s job. Not `NEXT_PUBLIC_`-prefixed because this client is created and used entirely server-side and is never bundled into browser code. |
| `CRON_SECRET` | Authorizes the scheduled reminder-sending endpoint; compared with the same constant-time comparison used elsewhere in the auth path. |

No example values are included here by design — see each variable's own configuration source for its actual value.

---

## Security Assumptions

- HTTPS is used in production (cookies are marked `secure` whenever `NODE_ENV === "production"`).
- The hosting platform (Vercel) keeps configured environment variables confidential and injects them only into the app's own runtime.
- `SESSION_SECRET` is configured in every environment before that environment serves traffic — if it's missing, the app fails closed (no sessions can be created or accepted) rather than falling back to something weaker.
- The owner's workstation and credentials are reasonably trusted — there is currently no MFA layer defending the owner account beyond the password itself.
- The Supabase service-role key is only ever used server-side; it is never sent to the browser.
- `is_demo` flags are set correctly and consistently by application code — the isolation between demo and real data depends on every write path setting this flag correctly, not on a database-level constraint.

---

## Known Limitations

These are documented as **future enhancements**, not current defects — each was explicitly scoped out of Sprint 1/2 rather than overlooked.

- **Distributed rate limiting**: the current login rate limiter is in-memory per server instance. A determined attacker spread across many serverless instances could exceed the intended limit. A durable version would need an external store (e.g. Redis/Upstash).
- **MFA**: no second factor exists for the owner account today.
- **OAuth**: no third-party identity provider integration.
- **Signup flow**: there is no self-service account creation; owner and employee accounts are provisioned directly.
- **Password reset improvements**: no self-service password reset flow currently exists.
- **Stateless logout**: because sessions are not tracked server-side, a copied cookie remains valid until its own expiry even after the original browser logs out (see [Session Architecture](#session-architecture)). A server-side revocation list would close this gap if ever needed.
- **Employee email uniqueness is global, not per-workspace**: `employees.email` is enforced unique across the entire table (`idx_employees_email`), not scoped to `workspace_id`. Two different real workspaces cannot each have an employee with the same email address today — the second insert fails at the database level. This is an accepted, temporary limitation, not an oversight: the employee-email constraint, workspace identification at login, and the login UI itself will be redesigned together when true multi-workspace customer onboarding is built. It is out of scope for the current single-real-workspace phase (see [Security History](#security-history)).

---

## Incident Recovery

### If SESSION_SECRET is compromised

1. Generate a new, cryptographically strong value (e.g. 32 random bytes, hex-encoded) and update it in every environment (local `.env.local`, Vercel Production, Vercel Preview).
2. Redeploy. Because sessions are stateless and signature-verified, rotating the secret **immediately invalidates every existing session** — every owner, employee, and tester will be signed out and must log in again. This is the correct and expected recovery mechanism; no separate revocation step is needed.
3. Confirm the old value is removed everywhere it was set, and that no code path still references it.

### If owner credentials are compromised

1. Reset the owner's Supabase Auth password immediately (via the Supabase dashboard or the Admin API — never by re-entering the old password anywhere).
2. Rotate `SESSION_SECRET` as well (see above) — this ensures any session already issued to an attacker using the compromised credentials is invalidated, not just future login attempts.
3. Review recent activity in the database for any changes made during the suspected compromise window.

### After discovering an API vulnerability

1. Assess whether the vulnerable route exposes or allows modification of real (non-demo) data, and whether it's currently live in production.
2. Apply the smallest safe fix — prefer adding an explicit role check over broader refactors, consistent with how Sprint 1 was scoped.
3. Verify the fix with a role-by-role access-matrix test (anonymous / owner / employee / tester) before deploying, the same methodology used throughout Sprints 1 and 2.
4. Deploy, then confirm in production with the same safe, non-destructive verification approach (no-op payloads, real-but-harmless reads) rather than exercising the vulnerability against real data.
5. Document the finding and fix, and check whether the same pattern (e.g. a missing role check) exists elsewhere in the codebase.

---

## Security History

### Security Sprint 1 — API Authorization

Closed a class of unauthorized-access vulnerabilities where API routes lacked an explicit owner/role check, letting anonymous or employee sessions reach real business data. Removed one fully public, unauthenticated data-leaking route outright. Introduced the shared `requireRole()` / `requireOwner()` authorization helper now used across the codebase.

### Security Sprint 2 — Session & Login Hardening

Replaced the previous unsigned, forgeable session cookie with a signed, expiring, tamper-evident one (`SESSION_SECRET`-based HMAC). Added login rate limiting, generic authentication error messages to prevent account enumeration, constant-time comparisons on all sensitive credential checks, and removed diagnostic startup logging that exposed infrastructure details.

### Tenant Foundation Phase 3 — Owner Auth Migration

Migrated owner login from a purely environment-variable credential check to Supabase Auth (via an isolated, request-local, token-discarding client), resolving the owner's workspace from a `profiles`/`workspace_memberships` backfill instead of a hardcoded workspace constant. `ADMIN_EMAIL` / `ADMIN_PASSWORD` were kept as a temporary fallback for one deployment cycle so a bug in the new path couldn't lock the owner out. Employee login, tester login, public booking, and every business-data route were explicitly left unchanged in this phase. The known global (non-per-workspace) uniqueness of `employees.email` was left in place and documented as a deferred limitation (see [Known Limitations](#known-limitations)) rather than addressed here, since fixing it requires a coordinated redesign of the employee-email constraint, workspace identification, and login UI together — out of scope while only one real workspace exists.

### Tenant Foundation Phase 3 — Fallback Removal

After the Supabase Auth path was confirmed working in production (verified via runtime logs showing `OWNER_LOGIN_SUCCESS` with no membership-resolution errors, on the correct deployed commit, with no credentials or tokens appearing in logs), the temporary `ADMIN_EMAIL` / `ADMIN_PASSWORD` fallback was removed from `app/api/auth/login/route.ts`. Owner login now succeeds only when Supabase Auth verifies the credentials **and** `workspace_memberships` resolves an owner workspace — there is no other path. The `ADMIN_EMAIL` / `ADMIN_PASSWORD` environment variables themselves were intentionally left in place in Vercel/local environments at this step; removing the now-unused variables is a separate, later cleanup action.

---

## Development Rules

Permanent rules for all future development on this codebase:

- Never expose owner APIs publicly. Every route that touches real business data must check the caller's role before doing anything else.
- Never trust client-side role information. The server-verified signed session is the only source of truth for who is making a request.
- Always verify signed sessions server-side — never assume a cookie's presence implies validity.
- Every new API route must explicitly authorize access (via `requireRole()` / `requireOwner()` or equivalent) — do not rely on middleware, which does not cover `/api/*`.
- Demo data must remain isolated from production data. Any new table or route a tester can reach must respect `is_demo` scoping exactly like existing routes do.
- Never reuse infrastructure secrets (database keys, provider credentials) for unrelated purposes such as session signing. Each secret should have exactly one job.
- Verify security-relevant changes before deployment: a role-by-role access-matrix test, plus `tsc`/`eslint`/`build`, before anything touching authentication or authorization ships.
