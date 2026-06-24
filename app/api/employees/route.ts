export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("id, name, phone, color, active")
      .order("name", { ascending: true });

    if (error) throw error;
    return json(data ?? []);
  } catch (e: any) {
    console.error("GET_EMPLOYEES_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const name = (body.name || "").trim();
    if (!name) return json({ error: "Name is required" }, 400);

    const row: Record<string, any> = {
      name,
      phone: (body.phone || "").trim() || null,
      color: (body.color || "#3B82F6").trim(),
      active: body.active !== false,
    };

    const { data, error } = await supabaseAdmin
      .from("employees")
      .insert(row)
      .select("id, name, phone, color, active")
      .single();

    if (error) throw error;
    return json(data, 201);
  } catch (e: any) {
    console.error("CREATE_EMPLOYEE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();

    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing employee id" }, 400);

    const update: Record<string, any> = {};
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.phone !== undefined) update.phone = body.phone.trim() || null;
    if (body.color !== undefined) update.color = body.color.trim();
    if (body.active !== undefined) update.active = body.active;

    if (Object.keys(update).length === 0) {
      return json({ error: "No fields to update" }, 400);
    }

    const { error } = await supabaseAdmin
      .from("employees")
      .update(update)
      .eq("id", id);

    if (error) throw error;
    return json({ ok: true });
  } catch (e: any) {
    console.error("UPDATE_EMPLOYEE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
