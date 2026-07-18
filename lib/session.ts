import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export type Session =
  | { role: "owner" }
  | { role: "tester" }
  | { role: "employee"; employeeId: string }
  | { role: "none" };

export async function getSession(): Promise<Session> {
  const cookieStore = await cookies();
  const value = cookieStore.get("sft_session")?.value ?? "";
  if (value === "authenticated") return { role: "owner" };
  if (value === "tester") return { role: "tester" };
  if (value.startsWith("employee:")) return { role: "employee", employeeId: value.slice("employee:".length) };
  return { role: "none" };
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
