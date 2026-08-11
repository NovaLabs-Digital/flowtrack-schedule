export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { generateFutureDatesSafe } from "@/lib/recurrence";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { fetchAssignments, insertAssignments, deriveLegacyEmployeeId } from "@/lib/appointmentEmployees";
import { effectiveTimezone } from "@/lib/timezone";
import {
  quarantineIfObservedActive,
  finalizeSeriesStopped,
  insertQuarantinedSeries,
  activateSeriesWithSnapshot,
  RECURRING_SERIES_REVIEW_WARNING,
} from "@/lib/recurringSeries";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const appointmentId = (body.appointment_id || "").trim();
    const newFrequency: string = (body.frequency_type || "one_time").trim();
    const newRepeatWeeks: number = typeof body.repeat_weeks === "number" ? body.repeat_weeks : 1;
    // Phase 2 (Monthly Recurring Appointments): null whenever the new
    // recurrence isn't monthly -- mirrors newRepeatWeeks' role for a
    // weekly series, stored in its own additive column (migrations/023).
    const newRepeatMonths: number | null = typeof body.repeat_months === "number" ? body.repeat_months : null;

    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
    if (!["one_time", "daily", "weekdays", "weekly", "monthly"].includes(newFrequency)) {
      return json({ error: "Invalid frequency_type" }, 400);
    }
    // Rejected clearly here, before any read/write below, rather than
    // silently falling through to generateFutureDates' own fail-safe (which
    // would produce zero future occurrences and leave the series looking
    // like a one-time appointment despite frequency_type being saved as
    // "monthly").
    if (newFrequency === "monthly") {
      if (!Number.isInteger(newRepeatMonths) || (newRepeatMonths as number) < 1 || (newRepeatMonths as number) > 12) {
        return json({ error: "Repeat interval must be a whole number of months between 1 and 12." }, 400);
      }
    }

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const { data: appt, error: fetchErr } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, service_type, scheduled_for, scheduled_end, notes, duration_minutes, employee_id, series_id, frequency_type, repeat_weeks, repeat_months, status, is_demo, price_cents, team_color")
      .eq("id", appointmentId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!appt) return json({ error: "Appointment not found" }, 404);
    if (isTester && !appt.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }

    // Phase 5.7D-R18: the origin appointment's full current assignment set
    // (not the legacy single employee_id column) is what every newly
    // generated occurrence below inherits -- mirrors how price_cents is
    // already copied from the origin's own current value, not recomputed.
    const originAssignments = await fetchAssignments(appointmentId, workspaceId);
    const employeeIds = originAssignments.map((a) => a.employee_id);

    const isNewRecurring = newFrequency !== "one_time";
    const newSeriesId = isNewRecurring ? crypto.randomUUID() : null;

    // Resolve the trusted workspace timezone and pre-validate the ENTIRE
    // recurrence generation BEFORE any write below -- a generated occurrence
    // landing on a nonexistent DST local time must reject the whole request
    // with zero partial writes (no cancelled siblings, no updated
    // frequency, no newly inserted occurrences), never a silently
    // shifted/dropped occurrence or a partially-regenerated series.
    const startDate = new Date(appt.scheduled_for);
    let futureDates: Date[] = [];
    // Block 2B: hoisted out of the isNewRecurring block below (rather than
    // re-resolved a second time) so the new series' registry row, inserted
    // further down, can reuse this exact same resolved value.
    let timezone = "America/New_York";
    if (isNewRecurring) {
      const { data: settings } = await supabaseAdmin
        .from("company_settings")
        .select("timezone")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      timezone = effectiveTimezone(settings?.timezone);
      const recurrenceResult = generateFutureDatesSafe(startDate, newFrequency, newRepeatWeeks, timezone, newRepeatMonths ?? undefined);
      if (!recurrenceResult.ok) {
        return json({ error: recurrenceResult.error }, 400);
      }
      futureDates = recurrenceResult.dates;
    }

    // Block 2B safety correction: this Manage Recurrence call always closes
    // out the OLD series -- whether the appointment is becoming one-time, or
    // continuing to recur under a brand-new series_id (below). It must be
    // quarantined to review_required BEFORE any appointment row underneath
    // it is touched. quarantineIfObservedActive explicitly OBSERVES the
    // row's current status first -- a zero-row compare-and-set result is
    // only ever a safe no-op when that observation already showed the
    // series wasn't active; if it WAS observed active and the very next
    // compare-and-set then finds nothing to transition, that's a genuine
    // concurrent change (a race with another request), and the whole
    // mutation must abort with 409, never silently proceed and never later
    // attempt to reactivate the row.
    let oldSeriesWasActive = false;
    if (appt.series_id) {
      let outcome: Awaited<ReturnType<typeof quarantineIfObservedActive>>;
      try {
        outcome = await quarantineIfObservedActive(appt.series_id, workspaceId);
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        return json({ error: "Unable to prepare this recurring series for changes right now. Please try again." }, 500);
      }
      if (outcome.outcome === "conflict") {
        return json({ error: "This recurring series was changed by another request. Please refresh and try again." }, 409);
      }
      oldSeriesWasActive = outcome.outcome === "quarantined";
    }

    let cancelled = 0;

    if (appt.series_id) {
      const { data: siblings, error: sibErr } = await supabaseAdmin
        .from("appointments")
        .select("id")
        .eq("series_id", appt.series_id)
        .eq("workspace_id", workspaceId)
        .eq("status", "scheduled")
        .eq("is_demo", appt.is_demo)
        .gt("scheduled_for", appt.scheduled_for);

      if (sibErr) throw sibErr;

      const sibIds = (siblings ?? []).map((s: any) => s.id);
      if (sibIds.length > 0) {
        const { error } = await supabaseAdmin
          .from("appointments")
          .update({ status: "cancelled" })
          .in("id", sibIds)
          .eq("workspace_id", workspaceId);
        if (error) throw error;
        cancelled = sibIds.length;
      }
    }

    const { error: updateErr } = await supabaseAdmin
      .from("appointments")
      .update({
        frequency_type: newFrequency,
        repeat_weeks: newRepeatWeeks,
        repeat_months: newRepeatMonths,
        series_id: newSeriesId,
      })
      .eq("id", appointmentId)
      .eq("workspace_id", workspaceId);

    if (updateErr) throw updateErr;

    let created = 0;

    if (isNewRecurring) {
      let endOffsetMs = 0;
      if (appt.scheduled_end) {
        endOffsetMs = new Date(appt.scheduled_end).getTime() - startDate.getTime();
      }

      const rows = futureDates.map((d) => ({
        client_id: appt.client_id,
        service_type: appt.service_type,
        scheduled_for: d.toISOString(),
        scheduled_end: endOffsetMs ? new Date(d.getTime() + endOffsetMs).toISOString() : null,
        notes: appt.notes,
        duration_minutes: appt.duration_minutes,
        // appointments.employee_id: read-only compatibility mirror (Phase
        // 5.7D-R18) derived from the origin's current assignment set, not
        // the authoritative assignment list itself -- see the
        // appointment_employees propagation below.
        employee_id: deriveLegacyEmployeeId(employeeIds),
        // Every newly generated occurrence gets the origin appointment's own
        // current price snapshot -- not recomputed from the service's
        // (possibly since-changed) default price.
        price_cents: appt.price_cents,
        // Phase 5.7D-R19: every newly generated occurrence also inherits the
        // origin's current team_color snapshot -- mirrors price_cents
        // immediately above. Harmless when the origin has fewer than two
        // assigned employees (lib/teamColor.ts ignores it entirely below
        // 2 assignments) -- stored unconditionally either way, no
        // assignment-count branch here.
        team_color: appt.team_color,
        cancel_token: crypto.randomBytes(24).toString("hex"),
        status: "scheduled",
        series_id: newSeriesId,
        frequency_type: newFrequency,
        repeat_weeks: newRepeatWeeks,
        repeat_months: newRepeatMonths,
        is_demo: appt.is_demo,
        workspace_id: workspaceId,
      }));

      if (rows.length > 0) {
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from("appointments")
          .insert(rows)
          .select("id");
        if (insErr) throw insErr;
        created = rows.length;

        // Phase 5.7D-R18: every newly generated occurrence gets the exact
        // same set of assigned employees as the origin appointment -- not
        // recomputed per-date, mirroring how price_cents is propagated
        // identically above.
        if (employeeIds.length > 0 && inserted) {
          for (const row of inserted) {
            await insertAssignments(row.id, workspaceId, employeeIds);
          }
        }
      }

    }

    // Block 2B safety correction: both registry transitions below run only
    // after every appointment write above has already succeeded -- neither
    // one can undo or block the appointment mutation at this point, only
    // leave the registry accurately reflecting it or, on failure, safely
    // quarantined in review_required (never active).
    let registryWarning = false;

    // Only ever attempted when THIS request actually quarantined the old
    // series a moment ago (oldSeriesWasActive) -- a series this request
    // never touched (never existed, already stopped, or a legacy
    // review_required series never activated) is left exactly as found,
    // never force-stopped as an incidental side effect.
    if (appt.series_id && oldSeriesWasActive) {
      try {
        const transitioned = await finalizeSeriesStopped(appt.series_id, workspaceId);
        if (!transitioned) registryWarning = true;
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        registryWarning = true;
      }
    }

    if (isNewRecurring) {
      // A series continuing to recur under a brand-new series_id is
      // explicit owner intent (this whole route was invoked by the owner),
      // so it's inserted quarantined and immediately finalized active --
      // the EDITED appointment itself is the new series' confirmed
      // template, since it's the one row the owner just directly acted on.
      // If either step fails, the row simply stays review_required (or
      // never exists at all, which is functionally the same "not eligible"
      // state) -- the appointment mutation above already fully succeeded
      // either way.
      try {
        await insertQuarantinedSeries({
          seriesId: newSeriesId!,
          workspaceId,
          clientId: appt.client_id,
          isDemo: appt.is_demo,
          frequencyType: newFrequency as "daily" | "weekdays" | "weekly" | "monthly",
          repeatWeeks: newFrequency === "weekly" ? newRepeatWeeks : null,
          repeatMonths: newFrequency === "monthly" ? newRepeatMonths : null,
          scheduledForIso: appt.scheduled_for,
          timezone,
        });
        // Block 2C-1: appt's own fields are the CURRENT state of the
        // template row -- this route never mutates service_type/price_cents/
        // duration_minutes/notes/team_color on the edited appointment
        // itself, only frequency_type/repeat_weeks/repeat_months/series_id,
        // so appt.* still faithfully reflects what's actually committed. The
        // RPC re-verifies this fresh under lock regardless, exactly like
        // every other caller of activateSeriesWithSnapshot.
        const outcome = await activateSeriesWithSnapshot({
          seriesId: newSeriesId!,
          workspaceId,
          clientId: appt.client_id,
          templateAppointmentId: appointmentId,
          timezone,
          expected: {
            serviceType: appt.service_type,
            priceCents: appt.price_cents,
            durationMinutes: appt.duration_minutes,
            notes: appt.notes,
            teamColor: appt.team_color,
            scheduledForIso: appt.scheduled_for,
            employeeIds,
          },
        });
        if (outcome.outcome !== "activated") registryWarning = true;
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        registryWarning = true;
      }
    }

    return json({ ok: true, cancelled, created, ...(registryWarning ? { warning: RECURRING_SERIES_REVIEW_WARNING } : {}) });
  } catch (e: any) {
    console.error("MANAGE_RECURRENCE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
