export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, NotifyChannel } from "@/lib/notify";
import { changeTemplates } from "@/lib/templates";

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

    const mode = (body.mode || "single").trim();
    const notify_channel: NotifyChannel = body.notify_channel || "none";

    const existing = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, series_id, scheduled_for, scheduled_end")
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

    if (mode === "future" && existing.data.series_id) {
      const { data: siblings, error: sibErr } = await supabaseAdmin
        .from("appointments")
        .select("id, scheduled_for, scheduled_end")
        .eq("series_id", existing.data.series_id)
        .eq("status", "scheduled")
        .gt("scheduled_for", existing.data.scheduled_for)
        .order("scheduled_for", { ascending: true });

      if (sibErr) throw sibErr;

      if (siblings && siblings.length > 0) {
        const newStart = body.scheduled_for ? new Date(body.scheduled_for) : null;
        const newEnd = body.scheduled_end ? new Date(body.scheduled_end) : null;
        const oldStart = new Date(existing.data.scheduled_for);

        const newStartHours = newStart ? newStart.getHours() : null;
        const newStartMins = newStart ? newStart.getMinutes() : null;
        const newEndHours = newEnd ? newEnd.getHours() : null;
        const newEndMins = newEnd ? newEnd.getMinutes() : null;

        const timeChanged = newStart && (
          newStartHours !== oldStart.getHours() || newStartMins !== oldStart.getMinutes()
        );

        for (const sib of siblings) {
          const sibUpdate: Record<string, any> = {};

          if (apptUpdate.service_type !== undefined) sibUpdate.service_type = apptUpdate.service_type;
          if (apptUpdate.notes !== undefined) sibUpdate.notes = apptUpdate.notes;
          if (apptUpdate.duration_minutes !== undefined) sibUpdate.duration_minutes = apptUpdate.duration_minutes;
          if (apptUpdate.employee_id !== undefined) sibUpdate.employee_id = apptUpdate.employee_id;

          if (timeChanged && newStartHours !== null && newStartMins !== null) {
            const sibDate = new Date(sib.scheduled_for);
            sibDate.setHours(newStartHours, newStartMins, 0, 0);
            sibUpdate.scheduled_for = sibDate.toISOString();

            if (newEndHours !== null && newEndMins !== null) {
              const sibEnd = new Date(sib.scheduled_for);
              sibEnd.setHours(newEndHours, newEndMins, 0, 0);
              sibUpdate.scheduled_end = sibEnd.toISOString();
            }
          }

          if (Object.keys(sibUpdate).length > 0) {
            const { error } = await supabaseAdmin
              .from("appointments")
              .update(sibUpdate)
              .eq("id", sib.id);
            if (error) throw error;
          }
        }
      }
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

    if (notify_channel !== "none") {
      const apptRes = await supabaseAdmin
        .from("appointments")
        .select("service_type, scheduled_for")
        .eq("id", appointment_id)
        .single();
      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone")
        .eq("id", existing.data.client_id)
        .single();

      if (!apptRes.error && !clientRes.error) {
        const { name, email, phone } = clientRes.data;
        const { service_type, scheduled_for } = apptRes.data;
        const t = changeTemplates(name, service_type, scheduled_for);

        if (email && shouldSend(notify_channel, "email")) {
          const providerId = await sendEmail(email, t.email.subject, t.email.body);
          await supabaseAdmin.from("messages_sent").insert({
            appointment_id, channel: "email", kind: "update",
            to_value: email, body: t.email.body, provider_id: providerId,
          });
        }
        if (phone && shouldSend(notify_channel, "sms")) {
          const providerId = await sendSms(phone, t.sms);
          await supabaseAdmin.from("messages_sent").insert({
            appointment_id, channel: "sms", kind: "update",
            to_value: phone, body: t.sms, provider_id: providerId,
          });
        }
      }
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("UPDATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
