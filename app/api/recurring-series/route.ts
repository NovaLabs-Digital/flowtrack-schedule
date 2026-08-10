export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { RECURRING_SERIES_COLUMNS } from "@/lib/recurringSeries";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Block 2B: the owner review queue -- every review_required series in this
// workspace, with enough live-occurrence context for the owner to identify
// it and choose a template, but no automatic write of any kind. A tester
// session is further scoped to is_demo=true rows only, matching the
// defense-in-depth "isTester && !row.is_demo -> 404" convention already
// used by every other appointment-adjacent route in this repository.
export async function GET() {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    let query = supabaseAdmin
      .from("recurring_series")
      .select(RECURRING_SERIES_COLUMNS)
      .eq("workspace_id", workspaceId)
      .eq("status", "review_required");
    if (isTester) query = query.eq("is_demo", true);

    const { data: seriesRows, error } = await query;
    if (error) throw error;

    const rows = (seriesRows ?? []) as any[];
    if (rows.length === 0) return json({ series: [] });

    const seriesIds = rows.map((r) => r.id);
    const clientIds = Array.from(new Set(rows.map((r) => r.client_id)));

    const [clientsRes, occurrencesRes] = await Promise.all([
      supabaseAdmin.from("clients").select("id, name, status, archived_at").in("id", clientIds).eq("workspace_id", workspaceId),
      supabaseAdmin
        .from("appointments")
        .select("id, series_id, scheduled_for, service_type, price_cents, duration_minutes")
        .in("series_id", seriesIds)
        .eq("workspace_id", workspaceId)
        .eq("status", "scheduled")
        .gt("scheduled_for", new Date().toISOString())
        .order("scheduled_for", { ascending: true }),
    ]);
    if (clientsRes.error) throw clientsRes.error;
    if (occurrencesRes.error) throw occurrencesRes.error;

    const clientById = new Map((clientsRes.data ?? []).map((c: any) => [c.id, c]));
    const occurrencesBySeriesId = new Map<string, any[]>();
    for (const occ of (occurrencesRes.data ?? []) as any[]) {
      const list = occurrencesBySeriesId.get(occ.series_id) ?? [];
      list.push(occ);
      occurrencesBySeriesId.set(occ.series_id, list);
    }

    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const series = rows.map((r) => {
      const client = clientById.get(r.client_id) as any;
      const occurrences = occurrencesBySeriesId.get(r.id) ?? [];
      const latest = occurrences.length > 0 ? occurrences[occurrences.length - 1] : null;
      return {
        id: r.id,
        frequencyType: r.frequency_type,
        repeatWeeks: r.repeat_weeks,
        repeatMonths: r.repeat_months,
        anchorLocalDate: r.anchor_local_date,
        anchorLocalTime: r.anchor_local_time,
        anchorTimezone: r.anchor_timezone,
        isDemo: r.is_demo,
        createdAt: r.created_at,
        clientId: r.client_id,
        clientName: client?.name ?? null,
        clientInactiveOrArchived: client ? client.status === "inactive" || !!client.archived_at : false,
        candidates: occurrences.map((o: any) => ({
          id: o.id,
          scheduledFor: o.scheduled_for,
          serviceType: o.service_type,
          priceCents: o.price_cents,
          durationMinutes: o.duration_minutes,
        })),
        hasLiveOccurrences: occurrences.length > 0,
        expiresWithin30Days: latest ? new Date(latest.scheduled_for).getTime() - now <= THIRTY_DAYS_MS : false,
      };
    });

    // Series with live occurrences, soonest-expiring first, then series with
    // none at all (nothing urgent to review for those -- they need a
    // reconciliation action, not a time-sensitive activation decision).
    series.sort((a, b) => {
      if (a.hasLiveOccurrences !== b.hasLiveOccurrences) return a.hasLiveOccurrences ? -1 : 1;
      if (!a.hasLiveOccurrences) return 0;
      const aLatest = a.candidates[a.candidates.length - 1]?.scheduledFor ?? "";
      const bLatest = b.candidates[b.candidates.length - 1]?.scheduledFor ?? "";
      return aLatest.localeCompare(bLatest);
    });

    return json({ series });
  } catch (e: any) {
    console.error("RECURRING_SERIES_LIST_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
