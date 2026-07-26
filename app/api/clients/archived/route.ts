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
    // Phase 5.6E defense-in-depth: dashboard/page.tsx already stops
    // rendering any client UI that could call this once a workspace is
    // canceled_locked, but "do not rely on UI disabling for security"
    // applies to reads too -- a direct call to this endpoint with a still-
    // valid session must be rejected the same way once locked. Read access
    // is otherwise unaffected: canViewExistingData stays true through the
    // entire canceled_read_only period, matching every other restricted
    // reason (see lib/entitlement.ts).
    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;
    const isTester = session.role === "tester";

    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("id, name, email, phone, archived_at, status")
      .not("archived_at", "is", null)
      .eq("workspace_id", session.workspaceId)
      .eq("is_demo", isTester)
      .order("name", { ascending: true });

    if (error) throw error;
    return json({ ok: true, clients: data ?? [] });
  } catch (e: any) {
    console.error("ARCHIVED_CLIENTS_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
