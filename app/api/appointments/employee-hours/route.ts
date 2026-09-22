export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;

    const capability = await requireCapability(session, "canUseJobTracking");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    const employee_id = (body.employee_id || "").trim();
    const hours_worked = Number(body.hours_worked);
    const note = (body.note || "").trim();

    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
    if (!employee_id) return json({ error: "Missing employee_id" }, 400);
    if (!Number.isFinite(hours_worked) || hours_worked <= 0) {
      return json({ error: "Hours worked must be a positive number" }, 400);
    }
    if (!note) return json({ error: "A reason is required (e.g. forgot to clock in/out)." }, 400);

    // Migration 030's save_employee_hours performs the whole write in one
    // database call under the shared locking protocol: it locks the PARENT
    // appointment first (FOR SHARE) -- which is what stops a brand-new hours
    // row from slipping past a concurrent recurrence change's recorded-work
    // check -- then re-reads its status, then applies the same rules this
    // route always enforced: the employee must be assigned to THIS
    // appointment within this workspace (never trusting a client-submitted
    // employee_id alone), and a manual entry must never override a genuinely
    // COMPLETE Job Tracking duration (same predicate as lib/payroll.ts's
    // isJobTrackingComplete).
    const { data, error } = await supabaseAdmin.rpc("save_employee_hours", {
      p_workspace_id: workspaceId,
      p_appointment_id: appointment_id,
      p_employee_id: employee_id,
      p_hours_worked: hours_worked,
      p_note: note,
    });
    if (error) throw error;

    switch (data?.outcome) {
      case "ok":
        return json({ ok: true, entry: data.entry });
      case "not_assigned":
        return json({ error: "Employee is not assigned to this appointment." }, 404);
      case "tracked_time_exists":
        return json({ error: "This appointment already has tracked time from Job Tracking, which cannot be overridden." }, 409);
      case "appointment_not_active":
        return json({ error: "This appointment was cancelled or replaced and hours can no longer be added to it.", code: "APPOINTMENT_NOT_ACTIVE" }, 409);
      case "invalid_input":
        return json({ error: "Hours worked must be a positive number" }, 400);
      default:
        return json({ error: "Server error" }, 500);
    }
  } catch (e: any) {
    console.error("EMPLOYEE_HOURS_SAVE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
