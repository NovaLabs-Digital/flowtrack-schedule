export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("id, name, email, phone, archived_at, status")
      .not("archived_at", "is", null)
      .order("name", { ascending: true });

    if (error) throw error;
    return json({ ok: true, clients: data ?? [] });
  } catch (e: any) {
    console.error("ARCHIVED_CLIENTS_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
