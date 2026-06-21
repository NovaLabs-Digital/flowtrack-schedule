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

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    const mode = body.mode;
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
    if (mode !== "single" && mode !== "future")
      return json({ error: "Invalid mode" }, 400);

    const selectFields = "id, client_id, service_type, scheduled_for, status, series_id";
    let apptRes = await supabaseAdmin
      .from("appointments")
      .select(selectFields)
      .eq("id", appointment_id)
      .maybeSingle();

    if (apptRes.error) {
      apptRes = await supabaseAdmin
        .from("appointments")
        .select("id, client_id, service_type, scheduled_for, status")
        .eq("id", appointment_id)
        .maybeSingle();
    }

    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Appointment not found" }, 404);
    const appt = apptRes.data as any;

    if (mode === "single") {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", appointment_id);
      if (error) throw error;
      return json({ ok: true, cancelled: 1 });
    }

    // mode === "future"
    // Prefer series_id if the appointment belongs to a series
    let query = supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("status", "scheduled")
      .gte("scheduled_for", appt.scheduled_for);

    if (appt.series_id && await hasColumn("series_id")) {
      query = query.eq("series_id", appt.series_id);
    } else {
      query = query.eq("client_id", appt.client_id).eq("service_type", appt.service_type);
    }

    const { data: targets, error: qErr } = await query;
    if (qErr) throw qErr;

    const ids = (targets ?? []).map((t: any) => t.id);
    if (ids.length > 0) {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update({ status: "cancelled" })
        .in("id", ids);
      if (error) throw error;
    }

    return json({ ok: true, cancelled: ids.length });
  } catch (e: any) {
    console.error("DELETE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
