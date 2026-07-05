export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
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
    const body = await req.json();

    const fields: Record<string, any> = {
      company_name: (body.company_name || "").trim() || null,
      phone: (body.phone || "").trim() || null,
      email: (body.email || "").trim() || null,
      address: (body.address || "").trim() || null,
      city: (body.city || "").trim() || null,
      state: (body.state || "").trim() || null,
      zip: (body.zip || "").trim() || null,
      updated_at: new Date().toISOString(),
    };
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
