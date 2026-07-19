import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { signSessionPayload, verifySessionCookie, newExpiry, SESSION_MAX_AGE_SECONDS } from "@/lib/sessionCrypto";

// workspaceId is present on every non-"none" role — Phase 2 tenant scoping
// requires every route to know which workspace a session belongs to, not
// just its role. There is currently no lookup for this: owner sessions
// always carry REAL_WORKSPACE_ID, tester sessions always carry
// DEMO_WORKSPACE_ID, and employee sessions carry the workspace_id read off
// their own employees row at login (see lib/workspace.ts).
export type Session =
  | { role: "owner"; workspaceId: string }
  | { role: "tester"; workspaceId: string }
  | { role: "employee"; employeeId: string; workspaceId: string }
  | { role: "none" };

export { SESSION_MAX_AGE_SECONDS };

export async function getSession(): Promise<Session> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_session")?.value ?? "";
  const payload = await verifySessionCookie(value);
  if (!payload) return { role: "none" };
  if (payload.role === "employee") {
    return { role: "employee", employeeId: payload.employeeId, workspaceId: payload.workspaceId };
  }
  return { role: payload.role, workspaceId: payload.workspaceId };
}

// Produces the signed cookie value to hand to res.cookies.set("sft_session", ...).
// Callers should pair this with maxAge: SESSION_MAX_AGE_SECONDS so the cookie's
// own expiry matches the `exp` claim baked into the signed payload.
export async function createSessionCookieValue(role: "owner" | "tester", workspaceId: string): Promise<string>;
export async function createSessionCookieValue(role: "employee", employeeId: string, workspaceId: string): Promise<string>;
export async function createSessionCookieValue(
  role: "owner" | "tester" | "employee",
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
  return signSessionPayload({ role, workspaceId: employeeIdOrWorkspaceId, exp });
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
// route at all," not per-row ownership.
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
