export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { effectiveBusinessHours, normalizeBusinessHours } from "@/lib/businessHours";
import { effectiveTimezone, normalizeTimezone } from "@/lib/timezone";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function GET() {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    // Phase 5.6E defense-in-depth: same rationale as
    // app/api/clients/archived/route.ts -- reads must still be blocked once
    // locked, not just left to UI disabling.
    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const { data, error } = await supabaseAdmin
      .from("company_settings")
      .select("*")
      .eq("workspace_id", session.workspaceId)
      .maybeSingle();

    if (error) throw error;

    // Real-only signals for the Company Status strip — booleans derived from
    // actual provider config / DB counts, never a placeholder value. Only
    // booleans and counts leave this route, never the underlying credentials.
    const { count: totalStaff } = await supabaseAdmin
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", session.workspaceId)
      .eq("is_demo", false);
    const { count: activeStaff } = await supabaseAdmin
      .from("employees")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", session.workspaceId)
      .eq("is_demo", false)
      .eq("active", true);

    const status = {
      emailConfigured: !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL,
      smsConfigured: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN && !!process.env.TWILIO_FROM_NUMBER,
      activeStaff: activeStaff ?? 0,
      totalStaff: totalStaff ?? 0,
    };

    // Phase 4: effective/current Business Hours -- the saved value if
    // present, otherwise the same Mon-Fri 07:00-17:00 fallback the app has
    // always effectively used (see lib/businessHours.ts), so a workspace
    // that has never saved Business Hours sees the exact behavior already
    // in effect for its public-booking availability.
    //
    // Phase 5B: effective/current Time Zone, same pattern -- the saved
    // value if present, otherwise the existing America/New_York fallback
    // (see lib/timezone.ts). Foundation only: no scheduling/display
    // consumer reads this yet (see lib/timezone.ts's Phase 5B header note).
    const settings = data
      ? { ...data, business_hours: effectiveBusinessHours(data.business_hours), timezone: effectiveTimezone(data.timezone) }
      : { business_hours: effectiveBusinessHours(null), timezone: effectiveTimezone(null) };

    return json({ ok: true, settings, status });
  } catch (e: any) {
    console.error("COMPANY_SETTINGS_GET_ERROR", e);
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

    // Partial update — only touch fields actually present in the request body.
    // (Previously this always wrote every field, defaulting anything missing
    // to null; a request that only sent booking_enabled — e.g. the Public
    // Booking toggle — silently wiped company_name/phone/email/address/etc.)
    const fields: Record<string, any> = { updated_at: new Date().toISOString() };
    const TEXT_FIELDS = ["company_name", "phone", "email", "address", "city", "state", "zip"];
    for (const f of TEXT_FIELDS) {
      if (body[f] !== undefined) fields[f] = (body[f] || "").trim() || null;
    }
    if (typeof body.booking_enabled === "boolean") {
      fields.booking_enabled = body.booking_enabled;
    }
    if (typeof body.notifications_enabled === "boolean") {
      fields.notifications_enabled = body.notifications_enabled;
    }
    if (body.business_hours !== undefined) {
      const validation = normalizeBusinessHours(body.business_hours);
      if (!validation.ok) return json({ error: validation.error }, 400);
      fields.business_hours = validation.value;
    }
    if (body.timezone !== undefined) {
      const validation = normalizeTimezone(body.timezone);
      if (!validation.ok) return json({ error: validation.error }, 400);
      fields.timezone = validation.value;
    }

    const { data: existing } = await supabaseAdmin
      .from("company_settings")
      .select("id")
      .eq("workspace_id", session.workspaceId)
      .maybeSingle();

    if (existing) {
      const { error } = await supabaseAdmin
        .from("company_settings")
        .update(fields)
        .eq("id", existing.id)
        .eq("workspace_id", session.workspaceId);
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from("company_settings")
        .insert({ ...fields, workspace_id: session.workspaceId });
      if (error) throw error;
    }

    return json({ ok: true });
  } catch (e: any) {
    console.error("COMPANY_SETTINGS_POST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
