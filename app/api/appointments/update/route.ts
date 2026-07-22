export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, describeProviderError, recordMessageSent, NotifyChannel } from "@/lib/notify";
import { changeTemplates } from "@/lib/templates";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";

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
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);

    const mode = (body.mode || "single").trim();
    const notify_channel: NotifyChannel = body.notify_channel || "none";

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const existing = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, series_id, scheduled_for, scheduled_end, is_demo")
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (!existing.data) return json({ error: "Appointment not found" }, 404);
    if (isTester && !existing.data.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }

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
    if (body.employee_id !== undefined && await hasColumn("employee_id")) {
      const newEmployeeId = (body.employee_id || "").trim() || null;
      // employee_id is an assignment target, not the caller's own identity —
      // never trust it alone. Confirm it belongs to this workspace before
      // reassigning the appointment to it.
      if (newEmployeeId) {
        const empRes = await supabaseAdmin
          .from("employees")
          .select("id")
          .eq("id", newEmployeeId)
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        if (empRes.error) throw empRes.error;
        if (!empRes.data) return json({ error: "Employee not found" }, 404);
      }
      apptUpdate.employee_id = newEmployeeId;
    }

    if (Object.keys(apptUpdate).length > 0) {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update(apptUpdate)
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    }

    if (mode === "future" && existing.data.series_id) {
      const { data: siblings, error: sibErr } = await supabaseAdmin
        .from("appointments")
        .select("id, scheduled_for, scheduled_end")
        .eq("series_id", existing.data.series_id)
        .eq("workspace_id", workspaceId)
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
              .eq("id", sib.id)
              .eq("workspace_id", workspaceId);
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
        .eq("id", existing.data.client_id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    }

    if (notify_channel !== "none" && !existing.data.is_demo) {
      const apptRes = await supabaseAdmin
        .from("appointments")
        .select("service_type, scheduled_for")
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId)
        .single();
      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone, auto_email, auto_sms")
        .eq("id", existing.data.client_id)
        .eq("workspace_id", workspaceId)
        .single();

      if (!apptRes.error && !clientRes.error) {
        const { name, email, phone, auto_email, auto_sms } = clientRes.data;
        const { service_type, scheduled_for } = apptRes.data;
        const t = changeTemplates(name, service_type, scheduled_for);

        if (email && auto_email && shouldSend(notify_channel, "email")) {
          try {
            const providerId = await sendEmail(email, t.email.subject, t.email.body, workspaceId);
            await recordMessageSent({
              appointment_id, channel: "email", kind: "update", workspace_id: workspaceId,
              to_value: email, body: t.email.body, provider_id: providerId,
            });
          } catch (err) {
            console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
            await recordMessageSent({
              appointment_id, channel: "email", kind: "update", workspace_id: workspaceId,
              to_value: email, body: t.email.body, provider_id: "failed",
            });
          }
        }
        // Runs even if the email attempt above failed — one provider's
        // failure must not block the other channel.
        if (phone && auto_sms && shouldSend(notify_channel, "sms")) {
          try {
            const providerId = await sendSms(phone, t.sms, workspaceId);
            await recordMessageSent({
              appointment_id, channel: "sms", kind: "update", workspace_id: workspaceId,
              to_value: phone, body: t.sms, provider_id: providerId,
            });
          } catch (err) {
            console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
            await recordMessageSent({
              appointment_id, channel: "sms", kind: "update", workspace_id: workspaceId,
              to_value: phone, body: t.sms, provider_id: "failed",
            });
          }
        }
      }
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("UPDATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
