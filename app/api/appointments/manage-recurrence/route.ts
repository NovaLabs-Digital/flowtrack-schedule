export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateFutureDates } from "@/lib/recurrence";
import { getSession, requireRole } from "@/lib/session";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const appointmentId = (body.appointment_id || "").trim();
    const newFrequency: string = (body.frequency_type || "one_time").trim();
    const newRepeatWeeks: number = typeof body.repeat_weeks === "number" ? body.repeat_weeks : 1;

    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
    if (!["one_time", "daily", "weekdays", "weekly"].includes(newFrequency)) {
      return json({ error: "Invalid frequency_type" }, 400);
    }

    const { data: appt, error: fetchErr } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, service_type, scheduled_for, scheduled_end, notes, duration_minutes, employee_id, series_id, frequency_type, repeat_weeks, status, is_demo")
      .eq("id", appointmentId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!appt) return json({ error: "Appointment not found" }, 404);

    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    const isTester = session.role === "tester";
    if (isTester && !appt.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }

    let cancelled = 0;

    if (appt.series_id) {
      const { data: siblings, error: sibErr } = await supabaseAdmin
        .from("appointments")
        .select("id")
        .eq("series_id", appt.series_id)
        .eq("status", "scheduled")
        .eq("is_demo", appt.is_demo)
        .gt("scheduled_for", appt.scheduled_for);

      if (sibErr) throw sibErr;

      const sibIds = (siblings ?? []).map((s: any) => s.id);
      if (sibIds.length > 0) {
        const { error } = await supabaseAdmin
          .from("appointments")
          .update({ status: "cancelled" })
          .in("id", sibIds);
        if (error) throw error;
        cancelled = sibIds.length;
      }
    }

    const isNewRecurring = newFrequency !== "one_time";
    const newSeriesId = isNewRecurring ? crypto.randomUUID() : null;

    const { error: updateErr } = await supabaseAdmin
      .from("appointments")
      .update({
        frequency_type: newFrequency,
        repeat_weeks: newRepeatWeeks,
        series_id: newSeriesId,
      })
      .eq("id", appointmentId);

    if (updateErr) throw updateErr;

    let created = 0;

    if (isNewRecurring) {
      const startDate = new Date(appt.scheduled_for);
      const futureDates = generateFutureDates(startDate, newFrequency, newRepeatWeeks);

      let endOffsetMs = 0;
      if (appt.scheduled_end) {
        endOffsetMs = new Date(appt.scheduled_end).getTime() - startDate.getTime();
      }

      const rows = futureDates.map((d) => ({
        client_id: appt.client_id,
        service_type: appt.service_type,
        scheduled_for: d.toISOString(),
        scheduled_end: endOffsetMs ? new Date(d.getTime() + endOffsetMs).toISOString() : null,
        notes: appt.notes,
        duration_minutes: appt.duration_minutes,
        employee_id: appt.employee_id,
        cancel_token: crypto.randomBytes(24).toString("hex"),
        status: "scheduled",
        series_id: newSeriesId,
        frequency_type: newFrequency,
        repeat_weeks: newRepeatWeeks,
        is_demo: appt.is_demo,
      }));

      if (rows.length > 0) {
        const { error: insErr } = await supabaseAdmin
          .from("appointments")
          .insert(rows);
        if (insErr) throw insErr;
        created = rows.length;
      }
    }

    return json({ ok: true, cancelled, created });
  } catch (e: any) {
    console.error("MANAGE_RECURRENCE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
