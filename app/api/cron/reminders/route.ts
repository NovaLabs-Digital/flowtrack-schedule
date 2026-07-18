export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms } from "@/lib/notify";
import { reminder24hTemplates } from "@/lib/templates";
import { safeEqual } from "@/lib/safeEqual";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const secret = url.searchParams.get("secret");
    const cronSecret = process.env.CRON_SECRET;
    if (!secret || !cronSecret || !safeEqual(secret, cronSecret)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const now = DateTime.now().setZone("America/New_York");
    const start = now.plus({ hours: 23 }).toUTC().toISO();
    const end = now.plus({ hours: 25 }).toUTC().toISO();

    const appts = await supabaseAdmin
      .from("appointments")
      .select("id, scheduled_for, service_type, client_id")
      .eq("status", "scheduled")
      .is("reminder_24h_sent_at", null)
      .gte("scheduled_for", start!)
      .lte("scheduled_for", end!);

    if (appts.error) throw appts.error;

    let sent = 0;

    for (const a of appts.data || []) {
      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone, auto_email, auto_sms")
        .eq("id", a.client_id)
        .single();

      if (clientRes.error) continue;

      const { name, email, phone, auto_email, auto_sms } = clientRes.data;
      const t = reminder24hTemplates(name, a.service_type, a.scheduled_for);

      if (email && auto_email) {
        const providerId = await sendEmail(email, t.email.subject, t.email.body);
        await supabaseAdmin.from("messages_sent").insert({
          appointment_id: a.id,
          channel: "email",
          kind: "reminder_24h",
          to_value: email,
          body: t.email.body,
          provider_id: providerId,
        });
      }

      if (phone && auto_sms) {
        const providerId = await sendSms(phone, t.sms);
        await supabaseAdmin.from("messages_sent").insert({
          appointment_id: a.id,
          channel: "sms",
          kind: "reminder_24h",
          to_value: phone,
          body: t.sms,
          provider_id: providerId,
        });
      }

      await supabaseAdmin
        .from("appointments")
        .update({ reminder_24h_sent_at: new Date().toISOString() })
        .eq("id", a.id);

      sent++;
    }

    return json({ ok: true, checked: appts.data?.length || 0, sent });
  } catch (e: any) {
    console.error("CRON_REMINDERS_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
