export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { effectiveTimezone } from "@/lib/timezone";
import { fetchSeriesById, evaluateSeriesConsistency, fetchLiveOccurrenceSnapshots, finalizeSeriesActive } from "@/lib/recurringSeries";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Block 2B: owner-confirmed activation of a review_required series. This is
// the ONLY place a legacy series can ever become active -- never automatic,
// never guessed. No appointment is created, cancelled, rescheduled, or
// rewritten here; this route only ever reads appointments/clients and
// writes exactly one recurring_series row. No automatic write
// replenishment exists yet -- activation only makes a series ELIGIBLE for
// that later, not-yet-built step.
export async function POST(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();
    const seriesId = (body.series_id || "").trim();
    const templateAppointmentId = (body.template_appointment_id || "").trim();
    if (!seriesId || !templateAppointmentId) {
      return json({ error: "Missing series_id or template_appointment_id" }, 400);
    }

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const series = await fetchSeriesById(seriesId, workspaceId);
    if (!series) return json({ error: "Series not found" }, 404);
    if (isTester && !series.is_demo) return json({ error: "Series not found" }, 404);

    if (series.status !== "review_required") {
      return json({ error: "Only a series awaiting review can be activated." }, 409);
    }
    // Demo series must never become active through this route, regardless
    // of role -- automatic discovery already excludes is_demo=true, but
    // this is a second, independent line of defense against a demo series
    // ever carrying a "confirmed" template/anchor at all.
    if (series.is_demo) {
      return json({ error: "Demo series cannot be activated." }, 400);
    }

    const { data: client, error: clientErr } = await supabaseAdmin
      .from("clients")
      .select("id, status, archived_at")
      .eq("id", series.client_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (clientErr) throw clientErr;
    if (!client) return json({ error: "Client not found" }, 404);
    if (client.status === "inactive" || client.archived_at) {
      return json({ error: "This series' client is inactive or archived and cannot be activated." }, 409);
    }

    const occurrenceSnapshots = await fetchLiveOccurrenceSnapshots(seriesId, workspaceId);
    if (occurrenceSnapshots.length === 0) {
      return json(
        { error: "This series has no scheduled future occurrences to activate from.", blockers: ["no_live_occurrences"] },
        409
      );
    }

    // Explicit, standalone proof that the chosen template appointment
    // actually belongs to THIS series, in THIS workspace, for THIS series'
    // own client, is still a live scheduled occurrence, and is not in the
    // past -- every one of those five conditions is its own explicit filter
    // here, never assumed from the broader occurrenceSnapshots list above
    // (which is scoped by series_id/workspace_id/status/future already, but
    // never checks client_id -- client matching is never left implicit). A
    // template id tampered to point at a different workspace, a different
    // series, a different client, a cancelled occurrence, or a past
    // appointment all fail this exact same query the exact same way: no
    // matching row, 400 template_not_in_series.
    const { data: templateRow, error: templateErr } = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("id", templateAppointmentId)
      .eq("workspace_id", workspaceId)
      .eq("series_id", seriesId)
      .eq("client_id", series.client_id)
      .eq("status", "scheduled")
      .gt("scheduled_for", new Date().toISOString())
      .maybeSingle();
    if (templateErr) throw templateErr;
    if (!templateRow) {
      return json(
        { error: "The chosen appointment is not a current, scheduled occurrence of this series.", blockers: ["template_not_in_series"] },
        400
      );
    }

    const { data: settings } = await supabaseAdmin
      .from("company_settings")
      .select("timezone")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const timezone = effectiveTimezone(settings?.timezone);

    // The safety gate: every currently-scheduled future occurrence must
    // independently agree -- never majority/mode guessing. The known legacy
    // pre-Phase-5 DST signature is the one pattern allowed through rather
    // than blocking; everything else (including a clean 60-minute gap with
    // no real offset change) remains a review blocker.
    const consistency = evaluateSeriesConsistency(
      occurrenceSnapshots,
      templateAppointmentId,
      series.frequency_type,
      timezone,
      series.repeat_months
    );

    if (!consistency.ok) {
      return json(
        {
          error: "This series can't be activated yet -- its scheduled occurrences don't all agree. Review or reconcile the differing occurrence(s), then try again.",
          blockers: consistency.blockers,
        },
        409
      );
    }

    const templateAppt = occurrenceSnapshots.find((o) => o.id === templateAppointmentId)!;

    // Compare-and-set: template, anchor, reviewed_at, and status all move
    // together, and only from review_required -- matches the DB CHECK
    // constraint that active status requires template_appointment_id and
    // reviewed_at together, and re-checks status='review_required' as the
    // WHERE-clause condition itself, the defensive guard against a
    // concurrent duplicate activation or any other lifecycle change that
    // may have raced this request.
    const outcome = await finalizeSeriesActive({
      seriesId,
      workspaceId,
      clientId: series.client_id,
      templateAppointmentId,
      scheduledForIso: templateAppt.scheduledFor,
      timezone,
    });
    // Re-checked immediately before the write (see finalizeSeriesActive) --
    // the client-inactive check above already ran once, but a client can go
    // inactive/archived in the window between that check and this one. No
    // appointment is ever touched by this route either way.
    if (outcome.outcome === "client_not_active") {
      return json({ error: "This series' client is inactive or archived and cannot be activated." }, 409);
    }
    if (outcome.outcome === "conflict") {
      return json({ error: "This series was already reviewed by someone else. Please refresh and try again." }, 409);
    }

    return json({ ok: true, timePattern: consistency.timePattern });
  } catch (e: any) {
    console.error("RECURRING_SERIES_ACTIVATE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
