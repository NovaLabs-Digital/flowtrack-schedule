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

    return json({ ok: true, settings: data });
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
