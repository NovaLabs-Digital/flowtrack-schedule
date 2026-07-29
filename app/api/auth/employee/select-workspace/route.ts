export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  createSessionCookieValue,
  getEmployeeWorkspaceSelectionCandidates,
  clearEmployeeWorkspaceSelectionCookie,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/session";

const GENERIC_ERROR = "Unable to complete sign-in. Please log in again.";

// The second step of the multi-workspace employee login flow (see
// app/api/auth/login/route.ts's employee branch): reached only after a
// password has already matched more than one active employee row for the
// same normalized email. Takes a single opaque `selectionId` -- never a
// workspace or employee id -- and resolves it against the exact candidate
// set embedded in the signed sft_employee_workspace_pending cookie, which
// this route is the only place that reads. A selectionId outside that
// exact set (forged, copied from a different login attempt, or simply
// made up) matches nothing and is rejected the same way an expired or
// missing challenge is -- no distinguishing signal in the response either
// way.
export async function POST(req: Request) {
  try {
    const candidates = await getEmployeeWorkspaceSelectionCandidates();
    if (!candidates) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}) as { selectionId?: unknown });
    const selectionId = typeof body.selectionId === "string" ? body.selectionId : "";
    const chosen = selectionId ? candidates.find((c) => c.selectionId === selectionId) : undefined;

    if (!chosen) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    // Re-verified fresh, not trusted from the (up to five-minute-old)
    // challenge: the employee row must still exist and still be active at
    // the moment of selection, exactly like every other capability check
    // in this codebase re-verifies rather than trusting a cached value.
    const { data: emp, error } = await supabaseAdmin
      .from("employees")
      .select("id, active, workspace_id")
      .eq("id", chosen.employeeId)
      .eq("workspace_id", chosen.workspaceId)
      .maybeSingle();

    if (error) throw error;
    if (!emp || !emp.active) {
      const res = NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
      clearEmployeeWorkspaceSelectionCookie(res);
      return res;
    }

    const res = NextResponse.json({ ok: true, redirect: "/schedule" });
    clearEmployeeWorkspaceSelectionCookie(res);
    res.cookies.set(
      "sft_session",
      await createSessionCookieValue("employee", emp.id, emp.workspace_id),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_SECONDS,
      }
    );
    return res;
  } catch (e) {
    console.error("EMPLOYEE_SELECT_WORKSPACE_ERROR", e);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
