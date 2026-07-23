export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, describeProviderError, recordMessageSent, NotifyChannel } from "@/lib/notify";
import { cancelTemplates } from "@/lib/templates";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability, requireCapabilityForWorkspace } from "@/lib/entitlementServer";

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
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    const mode = body.mode;
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
    if (mode !== "single" && mode !== "future")
      return json({ error: "Invalid mode" }, 400);
    const notify_channel: NotifyChannel = body.notify_channel || "none";

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const selectFields = "id, client_id, service_type, scheduled_for, status, series_id, is_demo";
    let apptRes = await supabaseAdmin
      .from("appointments")
      .select(selectFields)
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (apptRes.error) {
      apptRes = await supabaseAdmin
        .from("appointments")
        .select("id, client_id, service_type, scheduled_for, status, is_demo")
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
    }

    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Appointment not found" }, 404);
    const appt = apptRes.data as any;

    if (isTester && !appt.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }

    async function notifyCancellation() {
      if (notify_channel === "none" || appt.is_demo) return;

      // The cancellation mutation has already completed and succeeded
      // regardless of what happens next -- canSendNotifications is evaluated
      // as an independent follow-up step, using the exact workspaceId this
      // route already established for the authenticated session, never
      // re-derived and never request-supplied. When denied, the client
      // lookup below is skipped entirely -- same pattern as
      // appointments/cancel and cron/reminders.
      const notifyCapability = await requireCapabilityForWorkspace(workspaceId, "canSendNotifications");
      if (!notifyCapability.allowed) return;

      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone, auto_email, auto_sms")
        .eq("id", appt.client_id)
        .eq("workspace_id", workspaceId)
        .single();
      if (clientRes.error) return;

      const { name, email, phone, auto_email, auto_sms } = clientRes.data;
      const t = cancelTemplates(name, appt.service_type);

      if (email && auto_email && shouldSend(notify_channel, "email")) {
        try {
          const providerId = await sendEmail(email, t.email.subject, t.email.body, workspaceId);
          await recordMessageSent({
            appointment_id, channel: "email", kind: "cancel", workspace_id: workspaceId,
            to_value: email, body: t.email.body, provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id, channel: "email", kind: "cancel", workspace_id: workspaceId,
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
            appointment_id, channel: "sms", kind: "cancel", workspace_id: workspaceId,
            to_value: phone, body: t.sms, provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id, channel: "sms", kind: "cancel", workspace_id: workspaceId,
            to_value: phone, body: t.sms, provider_id: "failed",
          });
        }
      }
    }

    if (mode === "single") {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update({ status: "cancelled" })
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
      await notifyCancellation();
      return json({ ok: true, cancelled: 1 });
    }

    // mode === "future"
    // Prefer series_id if the appointment belongs to a series
    let query = supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("status", "scheduled")
      .eq("workspace_id", workspaceId)
      .eq("is_demo", appt.is_demo)
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
        .in("id", ids)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
      await notifyCancellation();
    }

    return json({ ok: true, cancelled: ids.length });
  } catch (e: any) {
    console.error("DELETE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
