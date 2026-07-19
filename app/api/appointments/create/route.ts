export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession } from "@/lib/session";
import { sendEmail, sendSms, shouldSend, describeProviderError, NotifyChannel } from "@/lib/notify";
import { confirmationTemplates } from "@/lib/templates";
import { generateFutureDates } from "@/lib/recurrence";
import { isSlotAvailable, isWithinBusinessHours, businessDayBounds, businessDateStringFromInstant, type BusyRange } from "@/lib/availability";

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
    const isOwner = session.role === "owner";
    const isTester = session.role === "tester";
    const isEmployee = session.role === "employee";

    // Employees have no legitimate reason to create appointments — same
    // flat-deny treatment as every other owner-facing mutation route.
    if (isEmployee) {
      return json({ error: "Unauthorized" }, 403);
    }

    // Anyone left (role: "none") is the public /book flow — never owner or
    // tester, since both were already excluded above.
    const isPublic = !isOwner && !isTester;

    if (isPublic) {
      const { data: settings } = await supabaseAdmin
        .from("company_settings")
        .select("booking_enabled")
        .limit(1)
        .maybeSingle();
      if (!settings?.booking_enabled) {
        return json({ error: "Online booking is currently unavailable." }, 403);
      }
    }

    const body = await req.json();

    const service_type = (body.service_type || "").trim();
    const scheduled_for = (body.scheduled_for || "").trim();
    const notes = (body.notes || "").trim();
    let duration_minutes = typeof body.duration_minutes === "number" ? body.duration_minutes : 60;
    let scheduled_end = (body.scheduled_end || "").trim() || null;

    // Recurrence and staff assignment are owner/tester-only capabilities —
    // a public booking is always a single, unassigned appointment; the
    // owner triages staff assignment afterward.
    const frequency_type: string = isPublic ? "one_time" : (body.frequency_type || "one_time").trim();
    const repeat_weeks: number = isPublic ? 1 : (typeof body.repeat_weeks === "number" ? body.repeat_weeks : 1);
    const employee_id: string | null = isPublic ? null : ((body.employee_id || "").trim() || null);
    // Defaults to "both" so the public /book self-booking page (no staff choice) keeps sending a confirmation.
    const notify_channel: NotifyChannel = body.notify_channel || "both";

    if (!service_type || !scheduled_for) {
      return json({ error: "Missing required fields" }, 400);
    }

    if (isPublic) {
      // The service must be a real, active, non-demo offering — duration
      // comes from the service record, never trusted from the request body,
      // since it directly drives the availability/conflict check below.
      const { data: svc } = await supabaseAdmin
        .from("services")
        .select("name, duration_minutes")
        .eq("name", service_type)
        .eq("is_demo", false)
        .eq("active", true)
        .maybeSingle();
      if (!svc) return json({ error: "Please choose a valid service." }, 400);
      duration_minutes = svc.duration_minutes || 60;
      scheduled_end = null;

      // Validate the time slot before touching the clients table at all —
      // a rejected booking (bad hours, already taken) must not leave behind
      // a client row created for a booking that never actually happened.
      const startDate = new Date(scheduled_for);
      if (isNaN(startDate.getTime())) {
        return json({ error: "Invalid date/time." }, 400);
      }
      const endDate = new Date(startDate.getTime() + duration_minutes * 60000);

      if (!isWithinBusinessHours(startDate, endDate)) {
        return json({ error: "That time is outside business hours. Please choose another time." }, 400);
      }

      // Defense-in-depth: re-check the exact slot server-side, independent
      // of whatever the availability endpoint showed the browser — a direct
      // API request can't be trusted to have honored it.
      const dayStr = businessDateStringFromInstant(startDate);
      const { start: dayStart, end: dayEnd } = businessDayBounds(dayStr);
      const { data: dayAppts, error: dayApptsErr } = await supabaseAdmin
        .from("appointments")
        .select("scheduled_for, scheduled_end, duration_minutes")
        .eq("status", "scheduled")
        .eq("is_demo", false)
        .gte("scheduled_for", dayStart.toISOString())
        .lt("scheduled_for", dayEnd.toISOString());
      if (dayApptsErr) throw dayApptsErr;

      const busy: BusyRange[] = (dayAppts ?? []).map((a) => {
        const bStart = new Date(a.scheduled_for);
        const bEnd = a.scheduled_end
          ? new Date(a.scheduled_end)
          : new Date(bStart.getTime() + (a.duration_minutes || 60) * 60000);
        return { start: bStart, end: bEnd };
      });

      if (!isSlotAvailable(startDate, endDate, busy)) {
        return json({ error: "That time is no longer available. Please choose another time." }, 409);
      }
    }

    // Never trust a client-supplied client_id from the public form — a
    // public caller resolves strictly by matching name/email/phone below,
    // same as any other new booking. Owner/tester may still pass one to
    // attach to a specific existing (or, for tester, demo) client.
    let clientId: string | null = isPublic ? null : ((body.client_id || "").trim() || null);

    if (clientId) {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("id", clientId)
        .eq("is_demo", isTester)
        .maybeSingle();
      if (!data) return json({ error: "Client not found" }, 404);
    } else {
      const name = (body.name || "").trim();
      const email = (body.email || "").trim();
      const phone = (body.phone || "").trim();
      const address = (body.address || "").trim();

      if (!name) return json({ error: "Client name is required" }, 400);
      if (!email && !phone) return json({ error: "Provide at least email or phone" }, 400);
      if (isPublic && !phone) return json({ error: "Phone is required" }, 400);
      if (isPublic && !address) return json({ error: "Address is required" }, 400);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: "Please enter a valid email address." }, 400);
      }

      if (email) {
        const { data } = await supabaseAdmin
          .from("clients").select("id").eq("email", email).eq("is_demo", isTester).maybeSingle();
        clientId = data?.id ?? null;
      }
      if (!clientId && phone) {
        const { data } = await supabaseAdmin
          .from("clients").select("id").eq("phone", phone).eq("is_demo", isTester).maybeSingle();
        clientId = data?.id ?? null;
      }
      if (!clientId) {
        const ins = await supabaseAdmin
          .from("clients")
          .insert({ name, email: email || null, phone: phone || null, address: address || null, is_demo: isTester })
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
    const hasEmployee = await hasColumn("employee_id");

    const startDate = new Date(scheduled_for);
    const dates: Date[] = [startDate, ...generateFutureDates(startDate, frequency_type, repeat_weeks)];

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
        is_demo: isTester,
      };
      if (hasDuration) row.duration_minutes = duration_minutes;
      if (hasEnd && endOffsetMs) row.scheduled_end = new Date(d.getTime() + endOffsetMs).toISOString();
      if (hasSeries) row.series_id = seriesId;
      if (hasFrequency) {
        row.frequency_type = frequency_type;
        row.repeat_weeks = repeat_weeks;
      }
      if (hasEmployee && employee_id) {
        row.employee_id = employee_id;
      }
      return row;
    });

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("appointments")
      .insert(rows)
      .select("id");

    if (insErr) throw insErr;

    const firstId = inserted?.[0]?.id;

    // Send confirmation for the first occurrence only — never for demo
    // bookings, regardless of DISABLE_MESSAGES or the client's auto_email/sms.
    const clientRes = await supabaseAdmin
      .from("clients")
      .select("name, email, phone, auto_email, auto_sms")
      .eq("id", clientId)
      .single();

    if (!isTester && !clientRes.error && clientRes.data && firstId) {
      const { name: cName, email: cEmail, phone: cPhone, auto_email, auto_sms } = clientRes.data;
      const cancelUrl = `${process.env.NEXT_PUBLIC_APP_URL}/cancel?token=${rows[0].cancel_token}`;
      const t = confirmationTemplates(cName, service_type, scheduled_for, cancelUrl);

      if (cEmail && auto_email && shouldSend(notify_channel, "email")) {
        try {
          const providerId = await sendEmail(cEmail, t.email.subject, t.email.body);
          await supabaseAdmin.from("messages_sent").insert({
            appointment_id: firstId,
            channel: "email", kind: "confirmation",
            to_value: cEmail, body: t.email.body, provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
          await supabaseAdmin.from("messages_sent").insert({
            appointment_id: firstId,
            channel: "email", kind: "confirmation",
            to_value: cEmail, body: t.email.body, provider_id: "failed",
          });
        }
      }
      // Runs even if the email attempt above failed — one provider's
      // failure must not block the other channel.
      if (cPhone && auto_sms && shouldSend(notify_channel, "sms")) {
        try {
          const providerId = await sendSms(cPhone, t.sms);
          await supabaseAdmin.from("messages_sent").insert({
            appointment_id: firstId,
            channel: "sms", kind: "confirmation",
            to_value: cPhone, body: t.sms, provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
          await supabaseAdmin.from("messages_sent").insert({
            appointment_id: firstId,
            channel: "sms", kind: "confirmation",
            to_value: cPhone, body: t.sms, provider_id: "failed",
          });
        }
      }
    }

    return json({ ok: true, appointmentId: firstId, created: inserted?.length ?? 1 });
  } catch (e: any) {
    console.error("CREATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
