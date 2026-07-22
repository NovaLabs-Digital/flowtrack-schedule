export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    const isTester = session.role === "tester";

    const { data, error } = await supabaseAdmin
      .from("services")
      .select("id, name, description, duration_minutes, active, color, created_at, updated_at")
      .eq("workspace_id", session.workspaceId)
      .eq("is_demo", isTester)
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
    const session = await getSession();
    const isTester = session.role === "tester";
    if (session.role !== "owner" && !isTester) {
      return json({ error: "Unauthorized" }, 403);
    }

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const name = (body.name || "").trim();
    if (!name) return json({ error: "Service name is required" }, 400);

    const row: Record<string, any> = {
      name,
      description: (body.description || "").trim() || null,
      duration_minutes: typeof body.duration_minutes === "number" ? body.duration_minutes : 60,
      active: true,
      is_demo: isTester,
      workspace_id: session.workspaceId,
    };
    if (body.color) row.color = body.color.trim();

    const { error } = await supabaseAdmin
      .from("services")
      .insert(row);

    if (error) throw error;
    return json({ ok: true });
  } catch (e: any) {
    console.error("SERVICES_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getSession();
    const isTester = session.role === "tester";
    if (session.role !== "owner" && !isTester) {
      return json({ error: "Unauthorized" }, 403);
    }

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing service id" }, 400);

    // Always confirm the row exists in this workspace before mutating — an
    // UPDATE whose WHERE clause matches nothing succeeds silently with zero
    // rows affected. Checked for every role, not just tester.
    {
      const { data } = await supabaseAdmin
        .from("services")
        .select("is_demo")
        .eq("id", id)
        .eq("workspace_id", session.workspaceId)
        .maybeSingle();
      if (!data) return json({ error: "Service not found" }, 404);
      if (isTester && !data.is_demo) return json({ error: "Service not found" }, 404);
    }

    const update: Record<string, any> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.description !== undefined) update.description = body.description.trim() || null;
    if (typeof body.duration_minutes === "number") update.duration_minutes = body.duration_minutes;
    if (typeof body.active === "boolean") update.active = body.active;
    if (body.color !== undefined) update.color = body.color.trim();

    const { error } = await supabaseAdmin
      .from("services")
      .update(update)
      .eq("id", id)
      .eq("workspace_id", session.workspaceId);

    if (error) throw error;
    return json({ ok: true });
  } catch (e: any) {
    console.error("SERVICES_PATCH_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

// Demo-only delete — regardless of caller, this only ever removes a row
// tagged is_demo = true. Real services have no delete capability (only the
// existing active/inactive toggle); this exists specifically so the
// Interactive Business Experience can let a tester create a throwaway
// demo service and then actually delete it.
export async function DELETE(req: Request) {
  try {
    const session = await getSession();
    if (session.role !== "owner" && session.role !== "tester") {
      return json({ error: "Unauthorized" }, 403);
    }

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();
    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing service id" }, 400);

    const { data } = await supabaseAdmin
      .from("services")
      .select("is_demo")
      .eq("id", id)
      .eq("workspace_id", session.workspaceId)
      .maybeSingle();
    if (!data?.is_demo) return json({ error: "Service not found" }, 404);

    const { error } = await supabaseAdmin
      .from("services")
      .delete()
      .eq("id", id)
      .eq("workspace_id", session.workspaceId);
    if (error) throw error;

    return json({ ok: true });
  } catch (e: any) {
    console.error("SERVICES_DELETE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
