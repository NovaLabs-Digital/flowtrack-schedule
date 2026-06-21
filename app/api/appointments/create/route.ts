export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms } from "@/lib/notify";
import { confirmationTemplates } from "@/lib/templates";

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

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const MAX_HORIZON_DAYS = 182; // ~26 weeks

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const service_type = (body.service_type || "").trim();
    const scheduled_for = (body.scheduled_for || "").trim();
    const notes = (body.notes || "").trim();
    const duration_minutes = typeof body.duration_minutes === "number" ? body.duration_minutes : 60;
    const scheduled_end = (body.scheduled_end || "").trim() || null;

    const frequency_type: string = (body.frequency_type || "one_time").trim();
    const repeat_weeks: number = typeof body.repeat_weeks === "number" ? body.repeat_weeks : 1;

    if (!service_type || !scheduled_for) {
      return json({ error: "Missing required fields" }, 400);
    }

    // Resolve client
    let clientId: string | null = (body.client_id || "").trim() || null;

    if (clientId) {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("id", clientId)
        .maybeSingle();
      if (!data) return json({ error: "Client not found" }, 404);
    } else {
      const name = (body.name || "").trim();
      const email = (body.email || "").trim();
      const phone = (body.phone || "").trim();

      if (!name) return json({ error: "Client name is required" }, 400);
      if (!email && !phone) return json({ error: "Provide at least email or phone" }, 400);

      if (email) {
        const { data } = await supabaseAdmin
          .from("clients").select("id").eq("email", email).maybeSingle();
        clientId = data?.id ?? null;
      }
      if (!clientId && phone) {
        const { data } = await supabaseAdmin
          .from("clients").select("id").eq("phone", phone).maybeSingle();
        clientId = data?.id ?? null;
      }
      if (!clientId) {
        const ins = await supabaseAdmin
          .from("clients")
          .insert({ name, email: email || null, phone: phone || null })
          .select("id").single();
        if (ins.error) throw ins.error;
        clientId = ins.data.id;
      }
    }

    // Check column support
    const hasDuration = await hasColumn("duration_minutes");
    const hasEnd = await hasColumn("scheduled_end");
    const hasSeries = await hasColumn("series_id");
    const hasFrequency = await hasColumn("frequency_type");

    // Build list of occurrence dates
    const startDate = new Date(scheduled_for);
    const dates: Date[] = [startDate];

    if (frequency_type === "daily") {
      for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
        dates.push(addDays(startDate, d));
      }
    } else if (frequency_type === "weekly" && repeat_weeks >= 1) {
      const intervalDays = repeat_weeks * 7;
      for (let d = intervalDays; d <= MAX_HORIZON_DAYS; d += intervalDays) {
        dates.push(addDays(startDate, d));
      }
    }

    const isRecurring = dates.length > 1;
    const seriesId = isRecurring ? crypto.randomUUID() : null;

    // Compute time-of-day offset for scheduled_end
    let endOffsetMs = 0;
    if (scheduled_end) {
      endOffsetMs = new Date(scheduled_end).getTime() - startDate.getTime();
    }

    // Build rows
    const rows: Record<string, any>[] = dates.map((d) => {
      const row: Record<string, any> = {
        client_id: clientId,
        service_type,
        scheduled_for: d.toISOString(),
        notes: notes || null,
        cancel_token: crypto.randomBytes(24).toString("hex"),
        status: "scheduled",
      };
      if (hasDuration) row.duration_minutes = duration_minutes;
      if (hasEnd && endOffsetMs) row.scheduled_end = new Date(d.getTime() + endOffsetMs).toISOString();
      if (hasSeries) row.series_id = seriesId;
      if (hasFrequency) {
        row.frequency_type = frequency_type;
        row.repeat_weeks = repeat_weeks;
      }
      return row;
    });

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("appointments")
      .insert(rows)
      .select("id");

    if (insErr) throw insErr;

    const firstId = inserted?.[0]?.id;

    // Send confirmation for the first occurrence only
    const clientRes = await supabaseAdmin
      .from("clients")
      .select("name, email, phone")
      .eq("id", clientId)
      .single();

    if (!clientRes.error && clientRes.data && firstId) {
      const { name: cName, email: cEmail, phone: cPhone } = clientRes.data;
      const cancelUrl = `${process.env.APP_URL}/cancel?token=${rows[0].cancel_token}`;
      const t = confirmationTemplates(cName, service_type, scheduled_for, cancelUrl);

      if (cEmail) {
        const providerId = await sendEmail(cEmail, t.email.subject, t.email.body);
        await supabaseAdmin.from("messages_sent").insert({
          appointment_id: firstId,
          channel: "email", kind: "confirmation",
          to_value: cEmail, body: t.email.body, provider_id: providerId,
        });
      }
      if (cPhone) {
        const providerId = await sendSms(cPhone, t.sms);
        await supabaseAdmin.from("messages_sent").insert({
          appointment_id: firstId,
          channel: "sms", kind: "confirmation",
          to_value: cPhone, body: t.sms, provider_id: providerId,
        });
      }
    }

    return json({ ok: true, appointmentId: firstId, created: inserted?.length ?? 1 });
  } catch (e: any) {
    console.error("CREATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
