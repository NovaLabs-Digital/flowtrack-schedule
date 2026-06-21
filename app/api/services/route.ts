export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("services")
      .select("id, name, description, duration_minutes, active, created_at, updated_at")
      .order("name", { ascending: true });

    if (error) throw error;
    return json({ ok: true, services: data ?? [] });
  } catch (e: any) {
    console.error("SERVICES_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const name = (body.name || "").trim();
    if (!name) return json({ error: "Service name is required" }, 400);

    const { error } = await supabaseAdmin
      .from("services")
      .insert({
        name,
        description: (body.description || "").trim() || null,
        duration_minutes: typeof body.duration_minutes === "number" ? body.duration_minutes : 60,
        active: true,
      });

    if (error) throw error;
    return json({ ok: true });
  } catch (e: any) {
    console.error("SERVICES_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();

    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing service id" }, 400);

    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.description !== undefined) update.description = body.description.trim() || null;
    if (typeof body.duration_minutes === "number") update.duration_minutes = body.duration_minutes;
    if (typeof body.active === "boolean") update.active = body.active;

    const { error } = await supabaseAdmin
      .from("services")
      .update(update)
      .eq("id", id);

    if (error) throw error;
    return json({ ok: true });
  } catch (e: any) {
    console.error("SERVICES_PATCH_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
