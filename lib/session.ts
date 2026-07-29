import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  signSessionPayload,
  verifySessionCookie,
  newExpiry,
  SESSION_MAX_AGE_SECONDS,
  OWNER_SESSION_SHORT_SECONDS,
  OWNER_SESSION_TRUSTED_SECONDS,
  signMfaPendingPayload,
  verifyMfaPendingCookie,
  MFA_PENDING_MAX_AGE_SECONDS,
  signEmployeeWorkspaceSelectionPayload,
  verifyEmployeeWorkspaceSelectionCookie,
  EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS,
  type EmployeeWorkspaceSelectionCandidate,
} from "@/lib/sessionCrypto";

// workspaceId is present on every non-"none" role — Phase 2 tenant scoping
// requires every route to know which workspace a session belongs to, not
// just its role. Tester sessions always carry DEMO_WORKSPACE_ID, employee
// sessions carry the workspace_id read off their own employees row at
// login. Owner sessions, as of Phase 5.7D (self-service signup + mandatory
// MFA), carry the REAL, individually-provisioned workspace for that owner
// — never a shared or hardcoded constant — plus authUserId (the Supabase
// Auth user this session belongs to) and sessionEpoch (see
// lib/sessionEpoch.ts), both required to safely re-verify the session on
// every protected request (see lib/workspace.ts).
export type Session =
  | { role: "owner"; workspaceId: string; authUserId: string; sessionEpoch: number }
  | { role: "tester"; workspaceId: string }
  | { role: "employee"; employeeId: string; workspaceId: string }
  | { role: "none" };

export { SESSION_MAX_AGE_SECONDS, OWNER_SESSION_SHORT_SECONDS, OWNER_SESSION_TRUSTED_SECONDS };

export async function getSession(): Promise<Session> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_session")?.value ?? "";
  const payload = await verifySessionCookie(value);
  if (!payload) return { role: "none" };
  if (payload.role === "employee") {
    return { role: "employee", employeeId: payload.employeeId, workspaceId: payload.workspaceId };
  }
  if (payload.role === "owner") {
    return { role: "owner", workspaceId: payload.workspaceId, authUserId: payload.authUserId, sessionEpoch: payload.sessionEpoch };
  }
  return { role: "tester", workspaceId: payload.workspaceId };
}

// Produces the signed cookie value for employee/tester sessions — UNCHANGED
// shape and duration from before Phase 5.7D. Owner sessions no longer go
// through this function at all: see createOwnerSessionCookieValue below,
// which requires the additional fields (authUserId, sessionEpoch) and the
// 12h/30d duration choice that a bare "owner" role string can no longer
// represent on its own.
export async function createSessionCookieValue(role: "tester", workspaceId: string): Promise<string>;
export async function createSessionCookieValue(role: "employee", employeeId: string, workspaceId: string): Promise<string>;
export async function createSessionCookieValue(
  role: "tester" | "employee",
  employeeIdOrWorkspaceId: string,
  workspaceIdForEmployee?: string
): Promise<string> {
  const exp = newExpiry();
  if (role === "employee") {
    return signSessionPayload({
      role: "employee",
      employeeId: employeeIdOrWorkspaceId,
      workspaceId: workspaceIdForEmployee as string,
      exp,
    });
  }
  return signSessionPayload({ role: "tester", workspaceId: employeeIdOrWorkspaceId, exp });
}

// Phase 5.7D — the ONLY way an owner sft_session is ever minted. Callers
// must have already independently verified (server-side, against
// Supabase's own response — never a client claim) that this authUserId's
// session reports currentLevel === 'aal2', and must pass the sessionEpoch
// value read fresh from workspace_memberships at the moment of issuance
// (never a stale or client-supplied value). `trusted` controls both the
// signed exp claim's duration (12h vs 30d) and, at the cookie-setting call
// site (setOwnerSessionCookie below), whether Max-Age is present at all.
export async function createOwnerSessionCookieValue(params: {
  workspaceId: string;
  authUserId: string;
  sessionEpoch: number;
  trusted: boolean;
}): Promise<string> {
  const exp = newExpiry(params.trusted ? OWNER_SESSION_TRUSTED_SECONDS : OWNER_SESSION_SHORT_SECONDS);
  return signSessionPayload({
    role: "owner",
    workspaceId: params.workspaceId,
    authUserId: params.authUserId,
    mfa: true,
    sessionEpoch: params.sessionEpoch,
    exp,
  });
}

// Sets the sft_session cookie for a just-issued owner session. `trusted:
// false` (the "Keep me signed in" checkbox unchecked, the default) omits
// maxAge entirely, producing a genuine browser-session cookie the browser
// itself drops on close — the signed 12h exp claim inside is still the
// real, independent ceiling regardless of how long the browser stays open.
// `trusted: true` sets maxAge to the same 30-day duration baked into the
// signed claim. There is no other cookie and no separate trusted-device
// artifact — this is the only place an owner cookie is written.
export function setOwnerSessionCookie(res: NextResponse, value: string, trusted: boolean): void {
  res.cookies.set("sft_session", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    ...(trusted ? { maxAge: OWNER_SESSION_TRUSTED_SECONDS } : {}),
  });
}

// Phase 5.7D — sft_mfa_pending: the short-lived, single-purpose cookie
// covering the gap between password/email verification and completed
// aal2. Its payload is only an opaque reference (see lib/mfaPending.ts /
// lib/sessionCrypto.ts's MfaPendingPayload) — never a Supabase token, never
// a role, never anything requireRole/requireOwner could mistake for an
// application session.
export async function setMfaPendingCookie(res: NextResponse, token: string): Promise<void> {
  const exp = newExpiry(MFA_PENDING_MAX_AGE_SECONDS);
  const value = await signMfaPendingPayload({ token, exp });
  res.cookies.set("sft_mfa_pending", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MFA_PENDING_MAX_AGE_SECONDS,
  });
}

export function clearMfaPendingCookie(res: NextResponse): void {
  res.cookies.set("sft_mfa_pending", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function getMfaPendingToken(): Promise<string | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_mfa_pending")?.value ?? "";
  const payload = await verifyMfaPendingCookie(value);
  return payload?.token ?? null;
}

// Phase — sft_employee_workspace_pending: the short-lived, single-purpose
// cookie covering the gap between a password verified against more than one
// active employee row (same normalized email, different workspaces) and the
// employee's explicit choice of which workspace to enter. Its payload is
// only opaque selectionId/employeeId/workspaceId candidate identifiers (see
// lib/sessionCrypto.ts's EmployeeWorkspaceSelectionPayload) — never a
// password, password hash, or anything requireRole/requireOwner could
// mistake for an application session.
export async function setEmployeeWorkspaceSelectionCookie(
  res: NextResponse,
  candidates: EmployeeWorkspaceSelectionCandidate[]
): Promise<void> {
  const exp = newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS);
  const value = await signEmployeeWorkspaceSelectionPayload({ purpose: "employee_workspace_selection", candidates, exp });
  res.cookies.set("sft_employee_workspace_pending", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS,
  });
}

export function clearEmployeeWorkspaceSelectionCookie(res: NextResponse): void {
  res.cookies.set("sft_employee_workspace_pending", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

// Returns the verified candidate list, or null for anything missing,
// malformed, tampered, or expired — callers treat null exactly like "no
// pending selection at all," the same fail-closed convention
// getMfaPendingToken already uses.
export async function getEmployeeWorkspaceSelectionCandidates(): Promise<EmployeeWorkspaceSelectionCandidate[] | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_employee_workspace_pending")?.value ?? "";
  const payload = await verifyEmployeeWorkspaceSelectionCookie(value);
  return payload?.candidates ?? null;
}

// Central role gate for API routes — every route in this codebase is
// responsible for its own authorization (middleware.ts only protects page
// routes, not /api/*), so a route that forgets this check silently exposes
// real data. Call right after getSession() and return early if non-null:
//
//   const session = await getSession();
//   const deny = requireRole(session, ["owner", "tester"]);
//   if (deny) return deny;
//
// Callers that need tester requests scoped to is_demo rows still do that
// themselves afterward — this only gates "is this role allowed to call this
// route at all," not per-row ownership. This check alone does NOT prove an
// owner session is still current (session_epoch may have been revoked) —
// every owner-only route must additionally call
// lib/sessionEpoch.ts#requireCurrentOwnerSession before touching business
// data; see that module for why this can't be folded into requireRole
// itself without an unrelated, wider refactor of every call site in this
// codebase.
export function requireRole(session: Session, allowed: Session["role"][]): NextResponse | null {
  if (!allowed.includes(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  return null;
}

export function requireOwner(session: Session): NextResponse | null {
  return requireRole(session, ["owner"]);
}

// requireRole()/requireOwner() return an opaque NextResponse | null, so
// TypeScript can't narrow `session` through them the way it would through an
// inline `if (session.role !== "owner")` check. Call this right after
// `if (deny) return deny;` to get a properly typed session.workspaceId
// without an unsafe cast. Throwing here would mean requireRole/requireOwner
// wasn't actually called first — a programmer error, not a real request path.
export function assertWorkspace(session: Session): asserts session is Extract<Session, { workspaceId: string }> {
  if (session.role === "none") {
    throw new Error("assertWorkspace called on an unauthenticated session — call requireRole/requireOwner first");
  }
}
