export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

async function hasColumn(col: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("appointments")
    .select(col)
    .limit(0);
  return !error;
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);

    const existing = await supabaseAdmin
      .from("appointments")
      .select("id, client_id")
      .eq("id", appointment_id)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (!existing.data) return json({ error: "Appointment not found" }, 404);

    const apptUpdate: Record<string, any> = {};
    if (body.service_type !== undefined)
      apptUpdate.service_type = body.service_type.trim();
    if (body.scheduled_for !== undefined)
      apptUpdate.scheduled_for = body.scheduled_for.trim();
    if (body.status !== undefined) apptUpdate.status = body.status.trim();
    if (body.notes !== undefined) apptUpdate.notes = body.notes.trim() || null;
    if (body.scheduled_end !== undefined && await hasColumn("scheduled_end"))
      apptUpdate.scheduled_end = body.scheduled_end;
    if (typeof body.duration_minutes === "number" && await hasColumn("duration_minutes"))
      apptUpdate.duration_minutes = body.duration_minutes;
    if (body.employee_id !== undefined && await hasColumn("employee_id"))
      apptUpdate.employee_id = body.employee_id || null;

    if (Object.keys(apptUpdate).length > 0) {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update(apptUpdate)
        .eq("id", appointment_id);
      if (error) throw error;
    }

    const clientUpdate: Record<string, any> = {};
    if (body.email !== undefined) clientUpdate.email = body.email.trim() || null;
    if (body.phone !== undefined) clientUpdate.phone = body.phone.trim() || null;
    if (body.name !== undefined) clientUpdate.name = body.name.trim();

    if (Object.keys(clientUpdate).length > 0) {
      const { error } = await supabaseAdmin
        .from("clients")
        .update(clientUpdate)
        .eq("id", existing.data.client_id);
      if (error) throw error;
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("UPDATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
