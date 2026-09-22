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
    if (action !== "start" && action !== "complete" && action !== "save_notes") {
      return json({ error: "Action must be 'start', 'complete', or 'save_notes'" }, 400);
    }

    // Employee Job Notes: validated before the assignment lookup below so a
    // malformed request never reaches the database at all -- matches the
    // "mutation-specific validation runs only after auth/role/entitlement"
    // ordering already established for appointment_id/action above. Trimmed
    // server-side (never trusts client-side trimming); NULL, not "", is the
    // stored representation of "no note" -- consistent with
    // apptUpdate.notes's existing `body.notes.trim() || null` convention in
    // app/api/appointments/update/route.ts.
    let jobNotes: string | null = null;
    if (action === "save_notes") {
      const rawNotes = typeof body.notes === "string" ? body.notes : "";
      const trimmedNotes = rawNotes.trim();
      if (trimmedNotes.length > 2000) {
        return json({ error: "Job notes must be 2000 characters or fewer" }, 400);
      }
      jobNotes = trimmedNotes || null;
    }

    // Migration 030's record_job_action does the whole write in one
    // database call: it locks the PARENT appointment first (FOR SHARE), then
    // this employee's own assignment row (employee_id: session.employeeId,
    // never a client-submitted value -- one employee can never touch another's
    // timestamps), and re-reads the appointment's status AFTER the lock. A
    // plain read-then-update here (the previous implementation) could not see
    // that a concurrent recurrence change had just cancelled the appointment,
    // and could not stop it from being replaced underneath a job that had
    // just started. Missing appointment / wrong workspace / not assigned all
    // fail closed identically (403), disclosing nothing about which.
    const { data, error } = await supabaseAdmin.rpc("record_job_action", {
      p_workspace_id: workspaceId,
      p_employee_id: employeeId,
      p_appointment_id: appointmentId,
      p_action: action,
      p_notes: jobNotes,
    });
    if (error) throw error;

    switch (data?.outcome) {
      case "ok": {
        const { outcome: _outcome, ...fields } = data;
        void _outcome;
        return json({ ok: true, ...fields });
      }
      case "unauthorized":
        return json({ error: "Unauthorized" }, 403);
      // Also the enforcement point for "job_notes becomes read-only from the
      // employee workflow" once complete.
      case "already_completed":
        return json({ error: "Job already completed" }, 400);
      case "already_started":
        return json({ error: "Job already started" }, 400);
      case "not_started":
        return json({ error: "Job has not been started" }, 400);
      case "appointment_not_active":
        return json({ error: "This appointment was cancelled or replaced and can no longer be updated.", code: "APPOINTMENT_NOT_ACTIVE" }, 409);
      case "invalid_input":
        return json({ error: "Invalid request" }, 400);
      default:
        return json({ error: "Server error" }, 500);
    }
  } catch (e: any) {
    console.error("JOB_ACTION_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
