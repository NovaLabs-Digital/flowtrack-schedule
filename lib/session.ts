import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { signSessionPayload, verifySessionCookie, newExpiry, SESSION_MAX_AGE_SECONDS } from "@/lib/sessionCrypto";

export type Session =
  | { role: "owner" }
  | { role: "tester" }
  | { role: "employee"; employeeId: string }
  | { role: "none" };

export { SESSION_MAX_AGE_SECONDS };

export async function getSession(): Promise<Session> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_session")?.value ?? "";
  const payload = await verifySessionCookie(value);
  if (!payload) return { role: "none" };
  if (payload.role === "employee") return { role: "employee", employeeId: payload.employeeId };
  return { role: payload.role };
}

// Produces the signed cookie value to hand to res.cookies.set("sft_session", ...).
// Callers should pair this with maxAge: SESSION_MAX_AGE_SECONDS so the cookie's
// own expiry matches the `exp` claim baked into the signed payload.
export async function createSessionCookieValue(role: "owner" | "tester"): Promise<string>;
export async function createSessionCookieValue(role: "employee", employeeId: string): Promise<string>;
export async function createSessionCookieValue(role: "owner" | "tester" | "employee", employeeId?: string): Promise<string> {
  const exp = newExpiry();
  if (role === "employee") {
    return signSessionPayload({ role: "employee", employeeId: employeeId as string, exp });
  }
  return signSessionPayload({ role, exp });
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
