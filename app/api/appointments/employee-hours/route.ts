export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const session = cookieStore.get("sft_session");
    if ((session?.value ?? "") !== "authenticated") {
      return json({ error: "Unauthorized" }, 401);
    }

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
      .maybeSingle();
    if (apptRes.error) throw apptRes.error;
    const appt = apptRes.data;
    const trackedMs = appt?.actual_started_at && appt?.actual_completed_at
      ? new Date(appt.actual_completed_at).getTime() - new Date(appt.actual_started_at).getTime()
      : 0;
    if (trackedMs > 0) {
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
