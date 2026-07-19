export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

    // Job Tracking is the authoritative source of worked time — a manual entry
    // must never override or reduce it, even via a direct API call. This
    // mirrors the DispatchPanel UI, which hides the manual form entirely once
    // an appointment has a completed tracked duration.
    const apptRes = await supabaseAdmin
      .from("appointments")
      .select("actual_started_at, actual_completed_at")
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Appointment not found" }, 404);
    const appt = apptRes.data;
    const trackedMs = appt?.actual_started_at && appt?.actual_completed_at
      ? new Date(appt.actual_completed_at).getTime() - new Date(appt.actual_started_at).getTime()
      : 0;
    if (trackedMs > 0) {
      return json({ error: "This appointment already has tracked time from Job Tracking, which cannot be overridden." }, 409);
    }

    // employee_id is an assignment target, not the caller's own identity —
    // never trust it alone. Confirm it actually belongs to this workspace
    // before attaching hours to it.
    const empRes = await supabaseAdmin
      .from("employees")
      .select("id")
      .eq("id", employee_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (empRes.error) throw empRes.error;
    if (!empRes.data) return json({ error: "Employee not found" }, 404);

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
