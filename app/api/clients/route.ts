export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

async function hasColumn(col: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("clients").select(col).limit(0);
  return !error;
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing client id" }, 400);

    const update: Record<string, any> = {};
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.email !== undefined) update.email = body.email.trim() || null;
    if (body.phone !== undefined) update.phone = body.phone.trim() || null;

    if (Object.keys(update).length === 0)
      return json({ error: "Nothing to update" }, 400);

    const { error } = await supabaseAdmin
      .from("clients")
      .update(update)
      .eq("id", id);
    if (error) throw error;

    return json({ ok: true });
  } catch (e: any) {
    console.error("CLIENT_PATCH_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = (body.action || "").trim();
    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing client id" }, 400);

    const hasArchived = await hasColumn("archived_at");

    if (action === "archive") {
      if (!hasArchived) return json({ error: "Archive not supported yet. Run the migration." }, 400);
      const { error } = await supabaseAdmin
        .from("clients")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "restore") {
      if (!hasArchived) return json({ error: "Archive not supported yet." }, 400);
      const { error } = await supabaseAdmin
        .from("clients")
        .update({ archived_at: null })
        .eq("id", id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Invalid action" }, 400);
  } catch (e: any) {
    console.error("CLIENT_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
