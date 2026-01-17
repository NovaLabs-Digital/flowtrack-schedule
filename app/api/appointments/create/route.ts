export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms } from "@/lib/notify";
import { confirmationTemplates } from "@/lib/templates";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

function normalizePhone(p: string) {
  return (p || "").trim();
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const phone = normalizePhone(body.phone || "");
    const service_type = (body.service_type || "").trim();
    const scheduled_for = (body.scheduled_for || "").trim(); // ISO string
    const notes = (body.notes || "").trim();

    if (!name || !service_type || !scheduled_for) {
      return json({ error: "Missing required fields" }, 400);
    }
    if (!email && !phone) {
      return json({ error: "Provide at least email or phone" }, 400);
    }

    // Find existing client
    let clientId: string | null = null;

    if (email) {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("email", email)
        .maybeSingle();
      clientId = data?.id ?? null;
    }

    if (!clientId && phone) {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("phone", phone)
        .maybeSingle();
      clientId = data?.id ?? null;
    }

    if (!clientId) {
      const ins = await supabaseAdmin
        .from("clients")
        .insert({ name, email: email || null, phone: phone || null })
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      clientId = ins.data.id;
    } else {
      await supabaseAdmin
        .from("clients")
        .update({ name, email: email || null, phone: phone || null })
        .eq("id", clientId);
    }

    const cancel_token = crypto.randomBytes(24).toString("hex");

    const apptIns = await supabaseAdmin
      .from("appointments")
      .insert({
        client_id: clientId,
        service_type,
        scheduled_for,
        notes: notes || null,
        cancel_token,
        status: "scheduled",
      })
      .select("id")
      .single();

    if (apptIns.error) throw apptIns.error;

    const appointmentId = apptIns.data.id;
    const cancelUrl = `${process.env.APP_URL}/cancel?token=${cancel_token}`;

    const t = confirmationTemplates(name, service_type, scheduled_for, cancelUrl);

    if (email) {
      const providerId = await sendEmail(email, t.email.subject, t.email.body);
      await supabaseAdmin.from("messages_sent").insert({
        appointment_id: appointmentId,
        channel: "email",
        kind: "confirmation",
        to_value: email,
        body: t.email.body,
        provider_id: providerId,
      });
    }

    if (phone) {
      const providerId = await sendSms(phone, t.sms);
      await supabaseAdmin.from("messages_sent").insert({
        appointment_id: appointmentId,
        channel: "sms",
        kind: "confirmation",
        to_value: phone,
        body: t.sms,
        provider_id: providerId,
      });
    }


    
    return json({ ok: true, appointmentId });
  } catch (e: any) {
    console.error("CREATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }


  
}
