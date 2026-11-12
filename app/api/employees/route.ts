export const runtime = "nodejs";

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Employee seats (migrations/048): the database refuses a new or reactivated
// active employee once the workspace's seats are all in use (SQLSTATE SL001,
// DETAIL {"used", "allowance"}). Nothing was written; the owner frees a seat
// by deactivating someone.
function seatsFullResponse(error: { code?: string; details?: string | null }) {
  if (error?.code !== "SL001") return null;
  let used = 0;
  let allowance = 0;
  try {
    const d = JSON.parse(error.details ?? "{}");
    used = Number(d.used) || 0;
    allowance = Number(d.allowance) || 0;
  } catch {
    // keep zeros; the message below still applies
  }
  return json(
    {
      error: `All ${allowance} employee seats are in use. Deactivate an employee to free a seat.`,
      code: "EMPLOYEE_SEATS_FULL",
      seats: { used, allowance, available: Math.max(0, allowance - used) },
    },
    409
  );
}

export async function GET() {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    // Phase 5.6E defense-in-depth: reads must still be blocked once locked,
    // even though the owning dashboard page already stops rendering any UI
    // that would call this -- see the matching comment in
    // app/api/clients/archived/route.ts.
    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;
    const isTester = session.role === "tester";

    const { data, error } = await supabaseAdmin
      .from("employees")
      .select("id, name, phone, color, active, email, position, owner_profile_id")
      .eq("workspace_id", session.workspaceId)
      .eq("is_demo", isTester)
      .order("name", { ascending: true });

    if (error) throw error;
    // is_you: the signed-in owner's own record (migrations/048). The profile
    // id itself never leaves the server.
    const me = session.role === "owner" ? session.authUserId : null;
    const rows = ((data ?? []) as Record<string, unknown>[]).map(({ owner_profile_id, ...rest }) => ({
      ...rest,
      is_you: !!me && owner_profile_id === me,
    }));
    return json(rows);
  } catch (e: any) {
    console.error("GET_EMPLOYEES_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (session.role !== "owner") {
      return json({ error: "Unauthorized" }, 403);
    }

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const name = (body.name || "").trim();
    if (!name) return json({ error: "Name is required" }, 400);

    const row: Record<string, any> = {
      name,
      phone: (body.phone || "").trim() || null,
      color: (body.color || "#3B82F6").trim(),
      active: body.active !== false,
      workspace_id: session.workspaceId,
    };
    // Phase: normalized to lowercase, matching the existing convention for
    // owner-account email at signup (app/api/auth/signup/route.ts). The
    // uniqueness index (migrations/019) is workspace-scoped and computed
    // on LOWER(email); storing the normalized value here keeps every write
    // path consistent with what that index actually compares, and with
    // what app/api/auth/login/route.ts's employee lookup now normalizes
    // its own input to.
    const email = (body.email || "").trim().toLowerCase();
    if (email) row.email = email;
    const position = (body.position || "").trim();
    if (position) row.position = position;
    const pw = (body.password || "").trim();
    if (pw) row.password_hash = await bcrypt.hash(pw, 10);

    const { data, error } = await supabaseAdmin
      .from("employees")
      .insert(row)
      .select("id, name, phone, color, active, email, position")
      .single();

    if (error) {
      const seatsFull = seatsFullResponse(error);
      if (seatsFull) return seatsFull;
      throw error;
    }
    return json(data, 201);
  } catch (e: any) {
    console.error("CREATE_EMPLOYEE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getSession();
    const isTester = session.role === "tester";
    if (session.role !== "owner") {
      return json({ error: "Unauthorized" }, 403);
    }

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const id = (body.id || "").trim();
    if (!id) return json({ error: "Missing employee id" }, 400);

    // Always confirm the row exists in this workspace before mutating — an
    // UPDATE whose WHERE clause matches nothing succeeds silently with zero
    // rows affected. Checked for every role, not just tester.
    {
      const { data } = await supabaseAdmin
        .from("employees")
        .select("is_demo")
        .eq("id", id)
        .eq("workspace_id", session.workspaceId)
        .maybeSingle();
      if (!data) return json({ error: "Employee not found" }, 404);
      if (isTester && !data.is_demo) return json({ error: "Employee not found" }, 404);
    }

    const update: Record<string, any> = {};
    if (body.name !== undefined) update.name = body.name.trim();
    if (body.phone !== undefined) update.phone = body.phone.trim() || null;
    if (body.color !== undefined) update.color = body.color.trim();
    if (body.active !== undefined) update.active = body.active;
    if (body.email !== undefined) update.email = body.email.trim().toLowerCase() || null;
    if (body.position !== undefined) update.position = body.position.trim() || null;
    const pw = (body.password || "").trim();
    if (pw) update.password_hash = await bcrypt.hash(pw, 10);

    if (Object.keys(update).length === 0) {
      return json({ error: "No fields to update" }, 400);
    }

    const { error } = await supabaseAdmin
      .from("employees")
      .update(update)
      .eq("id", id)
      .eq("workspace_id", session.workspaceId);

    if (error) {
      const seatsFull = seatsFullResponse(error);
      if (seatsFull) return seatsFull;
      throw error;
    }
    return json({ ok: true });
  } catch (e: any) {
    console.error("UPDATE_EMPLOYEE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
