export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { classifyMessageStatus, describeMessageKind } from "@/lib/messageStatus";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Message History (appointment-scoped). Owner/tester read-only -- same role
// gate and canViewExistingData capability as app/api/clients/archived/
// route.ts, since this is existing-data viewing, not a mutation.
export async function GET(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const url = new URL(req.url);
    const appointmentId = (url.searchParams.get("appointment_id") || "").trim();
    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);

    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIMIT) : DEFAULT_LIMIT;
    const offsetParam = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;

    // Ownership check, independent of the messages_sent query below: an
    // appointment id belonging to a different workspace is rejected
    // outright (404) rather than silently returning an empty message list,
    // which would otherwise leak "this id exists, just not yours."
    const apptRes = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("id", appointmentId)
      .eq("workspace_id", session.workspaceId)
      .maybeSingle();
    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Appointment not found" }, 404);

    // Double-scoped (appointment_id AND workspace_id) even though the
    // ownership check above already proves this appointment belongs to this
    // workspace -- defense-in-depth matching every other workspace-scoped
    // query in this codebase. Stable order: created_at desc, then id desc as
    // a tiebreaker for rows written in the same instant (e.g. the
    // email-then-sms pair from a single notification), so pagination never
    // skips or repeats a row across pages.
    const msgRes = await supabaseAdmin
      .from("messages_sent")
      .select("id, channel, kind, to_value, body, subject, provider_id, created_at, scheduled_for")
      .eq("appointment_id", appointmentId)
      .eq("workspace_id", session.workspaceId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit); // one extra row to detect hasMore without a separate count query

    if (msgRes.error) throw msgRes.error;
    const rows = (msgRes.data ?? []) as any[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return json({
      ok: true,
      messages: page.map((m) => ({
        id: m.id,
        channel: m.channel,
        kindLabel: describeMessageKind(m.kind),
        toValue: m.to_value,
        body: m.body,
        subject: m.subject ?? null,
        status: classifyMessageStatus(m.provider_id, m.channel),
        createdAt: m.created_at,
        scheduledFor: m.scheduled_for ?? null,
      })),
      hasMore,
    });
  } catch (e: any) {
    console.error("APPOINTMENT_MESSAGES_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
