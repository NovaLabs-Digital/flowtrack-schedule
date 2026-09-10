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

    // Phase 5.7D-R18: Job Tracking is now per-assignment, not per-appointment
    // -- resolves the AUTHENTICATED employee's own assignment row directly
    // (employee_id: session.employeeId, never a client-submitted value), so
    // one employee's Start/Complete action can never reach or change
    // another employee's timestamps on a shared appointment. A missing row
    // means either the appointment doesn't exist, doesn't belong to this
    // workspace, or (most commonly) simply isn't assigned to this employee
    // -- all three fail closed identically, with no information disclosed
    // about which case it was.
    const { data: assignment, error: fetchErr } = await supabaseAdmin
      .from("appointment_employees")
      .select("id, actual_started_at, actual_completed_at")
      .eq("appointment_id", appointmentId)
      .eq("employee_id", employeeId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!assignment) return json({ error: "Unauthorized" }, 403);

    if (assignment.actual_completed_at) {
      // Also the enforcement point for "job_notes becomes read-only from
      // the employee workflow" once complete -- this same guard already
      // blocks 'start'/'complete' past completion, so 'save_notes' inherits
      // it for free rather than needing a second, duplicated check.
      return json({ error: "Job already completed" }, 400);
    }

    if (action === "save_notes") {
      if (!assignment.actual_started_at) {
        return json({ error: "Job has not been started" }, 400);
      }
      const { error: notesErr } = await supabaseAdmin
        .from("appointment_employees")
        .update({ job_notes: jobNotes })
        .eq("id", assignment.id)
        .eq("workspace_id", workspaceId);

      if (notesErr) throw notesErr;
      return json({ ok: true, job_notes: jobNotes });
    }

    const now = new Date().toISOString();
    const update: Record<string, string> = {};

    if (action === "start") {
      if (assignment.actual_started_at) {
        return json({ error: "Job already started" }, 400);
      }
      update.actual_started_at = now;
    } else {
      if (!assignment.actual_started_at) {
        update.actual_started_at = now;
      }
      update.actual_completed_at = now;
    }

    const { error: updateErr } = await supabaseAdmin
      .from("appointment_employees")
      .update(update)
      .eq("id", assignment.id)
      .eq("workspace_id", workspaceId);

    if (updateErr) throw updateErr;

    return json({ ok: true, ...update });
  } catch (e: any) {
    console.error("JOB_ACTION_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
