export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

async function hasColumn(col: string): Promise<boolean> {
  const { error } = await supabaseAdmin.from("clients").select(col).limit(0);
  return !error;
}

const OPTIONAL_TEXT_FIELDS = ["address", "referred_by", "status", "notes", "preferred_contact_method"];
const OPTIONAL_BOOL_FIELDS = ["auto_email", "auto_sms"];

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing client id" }, 400);

    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    const isTester = session.role === "tester";
    // Always confirm the row exists in this workspace before mutating —
    // an UPDATE whose WHERE clause matches nothing succeeds silently with
    // zero rows affected, which would otherwise look identical to a real
    // success. Checked for every role, not just tester, so a wrong-workspace
    // ID gets an honest 404 instead of a misleading 200.
    {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("is_demo")
        .eq("id", id)
        .eq("workspace_id", session.workspaceId)
        .maybeSingle();
      if (!data) return json({ error: "Client not found" }, 404);
      if (isTester && !data.is_demo) return json({ error: "Client not found" }, 404);
    }

    const update: Record<string, any> = {};
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.email !== undefined) update.email = body.email.trim() || null;
    if (body.phone !== undefined) update.phone = body.phone.trim() || null;
    if (body.client_since !== undefined) update.client_since = body.client_since || null;

    for (const f of OPTIONAL_TEXT_FIELDS) {
      if (body[f] !== undefined && await hasColumn(f)) {
        update[f] = typeof body[f] === "string" ? (body[f].trim() || null) : body[f];
      }
    }
    for (const f of OPTIONAL_BOOL_FIELDS) {
      if (body[f] !== undefined && await hasColumn(f)) {
        update[f] = !!body[f];
      }
    }
    if (body.client_since !== undefined && await hasColumn("client_since")) {
      update.client_since = body.client_since || null;
    }

    if (Object.keys(update).length === 0)
      return json({ error: "Nothing to update" }, 400);

    const { error } = await supabaseAdmin
      .from("clients")
      .update(update)
      .eq("id", id)
      .eq("workspace_id", session.workspaceId);
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

    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    const isTester = session.role === "tester";
    // Always confirm the row exists in this workspace before mutating —
    // an UPDATE whose WHERE clause matches nothing succeeds silently with
    // zero rows affected, which would otherwise look identical to a real
    // success. Checked for every role, not just tester, so a wrong-workspace
    // ID gets an honest 404 instead of a misleading 200.
    {
      const { data } = await supabaseAdmin
        .from("clients")
        .select("is_demo")
        .eq("id", id)
        .eq("workspace_id", session.workspaceId)
        .maybeSingle();
      if (!data) return json({ error: "Client not found" }, 404);
      if (isTester && !data.is_demo) return json({ error: "Client not found" }, 404);
    }

    if (action === "archive") {
      const update: Record<string, any> = { archived_at: new Date().toISOString() };
      if (await hasColumn("status")) update.status = "inactive";
      const { error } = await supabaseAdmin
        .from("clients")
        .update(update)
        .eq("id", id)
        .eq("workspace_id", session.workspaceId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "restore") {
      const update: Record<string, any> = { archived_at: null };
      if (await hasColumn("status")) update.status = "active";
      const { error } = await supabaseAdmin
        .from("clients")
        .update(update)
        .eq("id", id)
        .eq("workspace_id", session.workspaceId);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Invalid action" }, 400);
  } catch (e: any) {
    console.error("CLIENT_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
