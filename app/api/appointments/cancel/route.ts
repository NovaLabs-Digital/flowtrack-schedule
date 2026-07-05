export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms } from "@/lib/notify";
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
      .select("id, status, client_id, service_type, is_demo")
      .eq("cancel_token", token)
      .maybeSingle();

    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Invalid token" }, 404);

    if (apptRes.data.status === "cancelled") {
      return json({ ok: true, already: true });
    }

    await supabaseAdmin
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", apptRes.data.id);

    if (apptRes.data.is_demo) {
      return json({ ok: true });
    }

    const clientRes = await supabaseAdmin
      .from("clients")
      .select("name, email, phone, auto_email, auto_sms")
      .eq("id", apptRes.data.client_id)
      .single();

    if (clientRes.error) throw clientRes.error;

    const { name, email, phone, auto_email, auto_sms } = clientRes.data;
    const t = cancelTemplates(name, apptRes.data.service_type);

    if (email && auto_email) {
      const providerId = await sendEmail(email, t.email.subject, t.email.body);
      await supabaseAdmin.from("messages_sent").insert({
        appointment_id: apptRes.data.id,
        channel: "email",
        kind: "cancel",
        to_value: email,
        body: t.email.body,
        provider_id: providerId,
      });
    }

    if (phone && auto_sms) {
      const providerId = await sendSms(phone, t.sms);
      await supabaseAdmin.from("messages_sent").insert({
        appointment_id: apptRes.data.id,
        channel: "sms",
        kind: "cancel",
        to_value: phone,
        body: t.sms,
        provider_id: providerId,
      });
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("CANCEL_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
