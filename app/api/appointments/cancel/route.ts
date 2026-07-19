export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, describeProviderError, recordMessageSent } from "@/lib/notify";
import { cancelTemplates } from "@/lib/templates";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const { token } = await req.json();
    if (!token) return json({ error: "Missing token" }, 400);

    const apptRes = await supabaseAdmin
      .from("appointments")
      .select("id, status, client_id, service_type, is_demo, workspace_id")
      .eq("cancel_token", token)
      .maybeSingle();

    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Invalid token" }, 404);

    // cancel_token is globally unique and stays the lookup key — but every
    // downstream step (the update, the client lookup, and which workspace's
    // notification setting applies) uses the workspace_id read off this
    // exact matched appointment, never a global/default row.
    const workspaceId = apptRes.data.workspace_id;

    if (apptRes.data.status === "cancelled") {
      return json({ ok: true, already: true });
    }

    await supabaseAdmin
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", apptRes.data.id)
      .eq("workspace_id", workspaceId);

    if (apptRes.data.is_demo) {
      return json({ ok: true });
    }

    const clientRes = await supabaseAdmin
      .from("clients")
      .select("name, email, phone, auto_email, auto_sms")
      .eq("id", apptRes.data.client_id)
      .eq("workspace_id", workspaceId)
      .single();

    if (clientRes.error) throw clientRes.error;

    const { name, email, phone, auto_email, auto_sms } = clientRes.data;
    const t = cancelTemplates(name, apptRes.data.service_type);

    // The cancellation itself already succeeded above — a notification
    // provider hiccup here must never turn into a 500 that makes a customer
    // think their cancellation failed when it didn't. Each channel is
    // isolated, matching the pattern in create/update/delete.
    if (email && auto_email) {
      try {
        const providerId = await sendEmail(email, t.email.subject, t.email.body, workspaceId);
        await recordMessageSent({
          appointment_id: apptRes.data.id,
          channel: "email",
          kind: "cancel",
          workspace_id: workspaceId,
          to_value: email,
          body: t.email.body,
          provider_id: providerId,
        });
      } catch (err) {
        console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
        await recordMessageSent({
          appointment_id: apptRes.data.id,
          channel: "email",
          kind: "cancel",
          workspace_id: workspaceId,
          to_value: email,
          body: t.email.body,
          provider_id: "failed",
        });
      }
    }

    if (phone && auto_sms) {
      try {
        const providerId = await sendSms(phone, t.sms, workspaceId);
        await recordMessageSent({
          appointment_id: apptRes.data.id,
          channel: "sms",
          kind: "cancel",
          workspace_id: workspaceId,
          to_value: phone,
          body: t.sms,
          provider_id: providerId,
        });
      } catch (err) {
        console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
        await recordMessageSent({
          appointment_id: apptRes.data.id,
          channel: "sms",
          kind: "cancel",
          workspace_id: workspaceId,
          to_value: phone,
          body: t.sms,
          provider_id: "failed",
        });
      }
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("CANCEL_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
