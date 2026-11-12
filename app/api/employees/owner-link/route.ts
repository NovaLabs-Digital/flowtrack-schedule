export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";

// The owner's own employee record (migrations/048): an owner who works jobs
// keeps an employee record so they can be assigned, and that record does not
// use an employee seat. The link is made only here, only after the owner
// confirms "This is me" in Staff settings, and always to the SIGNED-IN
// owner's own account (session.authUserId) -- the request never names a
// person or profile. The database re-checks that this account owns the
// workspace and allows at most one linked record per workspace. Nothing is
// ever linked by name or email.
//
//   POST   { employee_id }  link this record to me
//   DELETE { employee_id }  remove my link (the record then needs a free seat
//                           if it is active)

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function seatsFull(details?: string | null) {
  let used = 0;
  let allowance = 0;
  try {
    const d = JSON.parse(details ?? "{}");
    used = Number(d.used) || 0;
    allowance = Number(d.allowance) || 0;
  } catch {
    // keep zeros
  }
  return json(
    {
      error: `All ${allowance} employee seats are in use. Deactivate an employee before removing your owner link from an active record.`,
      code: "EMPLOYEE_SEATS_FULL",
      seats: { used, allowance, available: Math.max(0, allowance - used) },
    },
    409
  );
}

async function handle(req: Request, link: boolean) {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    if (session.role !== "owner") return json({ error: "Unauthorized" }, 403);
    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json().catch(() => ({}));
    const employeeId = typeof body?.employee_id === "string" ? body.employee_id.trim() : "";
    if (!employeeId) return json({ error: "Missing employee_id" }, 400);

    let query = supabaseAdmin
      .from("employees")
      .update({ owner_profile_id: link ? session.authUserId : null })
      .eq("id", employeeId)
      .eq("workspace_id", session.workspaceId)
      .eq("is_demo", false);
    // Only ever remove MY link.
    if (!link) query = query.eq("owner_profile_id", session.authUserId);
    const { data, error } = await query.select("id");

    if (error) {
      if (error.code === "23505") {
        return json({ error: "Another employee record is already marked as you. Remove that link first.", code: "OWNER_ALREADY_LINKED" }, 409);
      }
      if (error.code === "SL002") {
        return json({ error: "Only the owner of this business can be linked to an employee record.", code: "OWNER_LINK_NOT_ALLOWED" }, 403);
      }
      if (error.code === "SL001") return seatsFull(error.details);
      throw error;
    }
    if (!data || data.length === 0) return json({ error: "Employee not found" }, 404);
    return json({ ok: true });
  } catch (e) {
    console.error("OWNER_LINK_ERROR", e);
    return json({ error: "Server error" }, 500);
  }
}

export async function POST(req: Request) {
  return handle(req, true);
}

export async function DELETE(req: Request) {
  return handle(req, false);
}
