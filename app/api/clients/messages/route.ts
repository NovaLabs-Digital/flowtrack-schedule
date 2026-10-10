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

// Message History (client-scoped) -- every message across this client's
// appointments, regardless of which calendar week they fall in, same role
// gate and capability as the appointment-scoped route above.
export async function GET(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const url = new URL(req.url);
    const clientId = (url.searchParams.get("client_id") || "").trim();
    if (!clientId) return json({ error: "Missing client_id" }, 400);

    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIMIT) : DEFAULT_LIMIT;
    const offsetParam = Number(url.searchParams.get("offset"));
    const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? Math.floor(offsetParam) : 0;

    // Ownership check: a client id belonging to a different workspace is
    // rejected outright (404), never silently returning an empty list.
    const clientRes = await supabaseAdmin
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .eq("workspace_id", session.workspaceId)
      .maybeSingle();
    if (clientRes.error) throw clientRes.error;
    if (!clientRes.data) return json({ error: "Client not found" }, 404);

    // messages_sent has no client_id column -- it only carries
    // appointment_id (see migrations/*; the table was designed around a
    // single appointment, never a client directly). Resolving this client's
    // own appointment ids first, workspace-scoped, is what lets the
    // messages_sent query below stay exact rather than ever touching
    // another client's (or another workspace's) rows.
    const apptIdsRes = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("client_id", clientId)
      .eq("workspace_id", session.workspaceId);
    if (apptIdsRes.error) throw apptIdsRes.error;
    const appointmentIds = ((apptIdsRes.data ?? []) as any[]).map((a) => a.id);
    if (appointmentIds.length === 0) {
      return json({ ok: true, messages: [], hasMore: false });
    }

    // Double-scoped (appointment_id IN ... AND workspace_id) -- the
    // appointment ids above are already workspace-scoped, but the
    // workspace_id filter here is kept as defense-in-depth, matching the
    // appointment-scoped route and every other workspace-scoped query in
    // this codebase. Same stable order (created_at desc, id desc) as the
    // appointment-scoped route, for the same reason.
    const msgRes = await supabaseAdmin
      .from("messages_sent")
      .select("id, appointment_id, channel, kind, to_value, body, subject, provider_id, created_at, scheduled_for")
      .in("appointment_id", appointmentIds)
      .eq("workspace_id", session.workspaceId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + limit);

    if (msgRes.error) throw msgRes.error;
    const rows = (msgRes.data ?? []) as any[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return json({
      ok: true,
      messages: page.map((m) => ({
        id: m.id,
        appointmentId: m.appointment_id,
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
    console.error("CLIENT_MESSAGES_GET_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
