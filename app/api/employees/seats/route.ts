export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";

// GET /api/employees/seats -- employee seats for the owner's own workspace:
// { used, allowance, available, ownerLinked }. Counted by the database's own
// rule (migrations/048 employee_seat_usage): ACTIVE, non-demo employees,
// except the owner's own linked record. The allowance is per workspace
// (default 5; teams above 5 at rollout keep their headcount). Read-only.
function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const { data, error } = await supabaseAdmin.rpc("employee_seat_usage", { p_workspace_id: session.workspaceId });
    const usage = data as { used?: unknown; allowance?: unknown; available?: unknown; owner_linked?: unknown } | null;
    if (error || !usage || typeof usage.used !== "number" || typeof usage.allowance !== "number") {
      // Before migration 048 is applied there is nothing to show.
      return json({ error: "Employee seats are not available right now." }, 503);
    }
    return json({
      used: usage.used,
      allowance: usage.allowance,
      available: Math.max(0, usage.allowance - usage.used),
      ownerLinked: usage.owner_linked === true,
    });
  } catch (e) {
    console.error("GET_EMPLOYEE_SEATS_ERROR", e);
    return json({ error: "Server error" }, 500);
  }
}
