export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession } from "@/lib/session";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const session = await getSession();
    if (session.role === "tester") {
      return json({ error: "Unauthorized" }, 403);
    }

    const { data, error } = await supabaseAdmin
      .from("company_settings")
      .select("*")
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    // Real-only signals for the Company Status strip — booleans derived from
    // actual provider config / DB counts, never a placeholder value. Only
    // booleans and counts leave this route, never the underlying credentials.
    const { count: totalStaff } = await supabaseAdmin
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("is_demo", false);
    const { count: activeStaff } = await supabaseAdmin
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("is_demo", false)
      .eq("active", true);

    const status = {
      emailConfigured: !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL,
      smsConfigured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_FROM_NUMBER,
      activeStaff: activeStaff ?? 0,
      totalStaff: totalStaff ?? 0,
      // Mirrors BUSINESS_TZ in lib/timezone.ts, which every scheduling
      // computation is actually anchored to — shown read-only in Settings
      // since there's no per-company timezone column yet, and this is the
      // real value in effect, not a placeholder.
      timezoneLabel: "Eastern Time (US & Canada) — GMT-04:00",
    };

    return json({ ok: true, settings: data, status });
  } catch (e: any) {
    console.error("COMPANY_SETTINGS_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (session.role !== "owner") {
      return json({ error: "Unauthorized" }, 403);
    }

    const body = await req.json();

    // Partial update — only touch fields actually present in the request body.
    // (Previously this always wrote every field, defaulting anything missing
    // to null; a request that only sent booking_enabled — e.g. the Public
    // Booking toggle — silently wiped company_name/phone/email/address/etc.)
    const fields: Record<string, any> = { updated_at: new Date().toISOString() };
    const TEXT_FIELDS = ["company_name", "phone", "email", "address", "city", "state", "zip"];
    for (const f of TEXT_FIELDS) {
      if (body[f] !== undefined) fields[f] = (body[f] || "").trim() || null;
    }
    if (typeof body.booking_enabled === "boolean") {
      fields.booking_enabled = body.booking_enabled;
    }

    const { data: existing } = await supabaseAdmin
      .from("company_settings")
      .select("id")
      .limit(1)
      .maybeSingle();

    if (existing) {
      const { error } = await supabaseAdmin
        .from("company_settings")
        .update(fields)
        .eq("id", existing.id);
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from("company_settings")
        .insert(fields);
      if (error) throw error;
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("COMPANY_SETTINGS_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
