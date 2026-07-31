export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isJobTrackingComplete } from "@/lib/payroll";
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

    // Phase 5.7D-R18: a single lookup against the employee's own
    // appointment_employees assignment row both (a) proves this exact
    // employee is actually assigned to this exact appointment within this
    // workspace -- never trusting a client-submitted employee_id alone --
    // and (b) supplies that assignment's own Job Tracking timestamps for
    // the override guard below. Job Tracking is the authoritative source of
    // worked time for THIS employee's assignment -- a manual entry must
    // never override or reduce a genuinely COMPLETE tracked duration, even
    // via a direct API call. isJobTrackingComplete (lib/payroll.ts) is the
    // same predicate the warning triangle, payroll, and both UI cards use
    // -- a zero/negative/sub-one-minute gap between started and completed
    // does NOT count as complete, so a manual correction is allowed even
    // though both timestamp fields are present.
    const assignmentRes = await supabaseAdmin
      .from("appointment_employees")
      .select("id, actual_started_at, actual_completed_at")
      .eq("appointment_id", appointment_id)
      .eq("employee_id", employee_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (assignmentRes.error) throw assignmentRes.error;
    if (!assignmentRes.data) return json({ error: "Employee is not assigned to this appointment." }, 404);
    if (isJobTrackingComplete(assignmentRes.data)) {
      return json({ error: "This appointment already has tracked time from Job Tracking, which cannot be overridden." }, 409);
    }

    const { data, error } = await supabaseAdmin
      .from("appointment_employee_hours")
      .upsert(
        {
          appointment_id,
          employee_id,
          hours_worked,
          note: note || null,
          updated_at: new Date().toISOString(),
          workspace_id: workspaceId,
        },
        { onConflict: "appointment_id,employee_id" }
      )
      .select("id, appointment_id, employee_id, hours_worked, note, created_at, updated_at")
      .single();

    if (error) throw error;

    return json({ ok: true, entry: data });
  } catch (e: any) {
    console.error("EMPLOYEE_HOURS_SAVE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
