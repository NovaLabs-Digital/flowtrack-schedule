export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const session = await getSession();

    if (session.role !== "employee") {
      return json({ error: "Unauthorized" }, 401);
    }

    const employeeId = session.employeeId;
    const workspaceId = session.workspaceId;

    const capability = await requireCapability(session, "canUseJobTracking");
    if (!capability.allowed) return capability.response;

    const body = await req.json();
    const appointmentId = (body.appointment_id || "").trim();
    const action = (body.action || "").trim();

    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
    if (action !== "start" && action !== "complete") {
      return json({ error: "Action must be 'start' or 'complete'" }, 400);
    }

    const { data: appt, error: fetchErr } = await supabaseAdmin
      .from("appointments")
      .select("id, employee_id, actual_started_at, actual_completed_at")
      .eq("id", appointmentId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!appt) return json({ error: "Appointment not found" }, 404);
    // Both checks required: the appointment must be assigned to this exact
    // employee AND belong to their workspace — either alone isn't enough
    // once employee IDs could ever collide or be guessed across workspaces.
    if (appt.employee_id !== employeeId) {
      return json({ error: "Unauthorized" }, 403);
    }

    if (appt.actual_completed_at) {
      return json({ error: "Job already completed" }, 400);
    }

    const now = new Date().toISOString();
    const update: Record<string, string> = {};

    if (action === "start") {
      if (appt.actual_started_at) {
        return json({ error: "Job already started" }, 400);
      }
      update.actual_started_at = now;
    } else {
      if (!appt.actual_started_at) {
        update.actual_started_at = now;
      }
      update.actual_completed_at = now;
    }

    const { error: updateErr } = await supabaseAdmin
      .from("appointments")
      .update(update)
      .eq("id", appointmentId)
      .eq("workspace_id", workspaceId);

    if (updateErr) throw updateErr;

    return json({ ok: true, ...update });
  } catch (e: any) {
    console.error("JOB_ACTION_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
