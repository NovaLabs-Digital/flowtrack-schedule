export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, describeProviderError, recordMessageSent, getCompanyIdentity, NotifyChannel } from "@/lib/notify";
import { changeTemplates } from "@/lib/templates";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability, requireCapabilityForWorkspace } from "@/lib/entitlementServer";
import { isValidPriceCents } from "@/lib/money";
import {
  dedupeEmployeeIds,
  deriveLegacyEmployeeId,
  validateEmployeeIdsInWorkspace,
  planAssignmentSync,
  applyAssignmentSync,
  fetchEmployeeHoursForAppointments,
} from "@/lib/appointmentEmployees";
import { validateTeamColorInput } from "@/lib/teamColor";
import {
  quarantineIfObservedActive,
  finalizeSeriesActive,
  fetchSeriesById,
  fetchLiveOccurrenceSnapshots,
  evaluateSeriesConsistency,
  RECURRING_SERIES_REVIEW_WARNING,
} from "@/lib/recurringSeries";
import { effectiveTimezone } from "@/lib/timezone";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

async function hasColumn(col: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("appointments")
    .select(col)
    .limit(0);
  return !error;
}

export async function PATCH(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();

    const appointment_id = (body.appointment_id || "").trim();
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);

    const mode = (body.mode || "single").trim();
    const notify_channel: NotifyChannel = body.notify_channel || "none";

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const existing = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, series_id, scheduled_for, scheduled_end, is_demo")
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (!existing.data) return json({ error: "Appointment not found" }, 404);
    if (isTester && !existing.data.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }
    // Narrowed into its own const: existing.data's null-check above doesn't
    // persist into the fetchSiblings() closure below (a nested function
    // reading a property off an outer `const` object isn't narrowed across
    // the function boundary) -- existingData carries the non-null type
    // through every reference in this handler instead.
    const existingData = existing.data;

    // Phase 5.7D-R18: undefined means "assignments not part of this
    // request, leave unchanged" -- same convention as price_cents/
    // scheduled_end below. An explicit [] means "unassign everyone," which
    // the caller (AppointmentModal) is expected to have already confirmed
    // with the owner before sending.
    const employee_ids: string[] | undefined =
      body.employee_ids !== undefined ? dedupeEmployeeIds(Array.isArray(body.employee_ids) ? body.employee_ids : []) : undefined;

    if (employee_ids !== undefined) {
      const employeeValidation = await validateEmployeeIdsInWorkspace(employee_ids, workspaceId);
      if (!employeeValidation.ok) return json({ error: employeeValidation.error }, 404);
    }

    // Siblings (for "future" mode) are needed both for the pre-R18
    // time-shift logic below (unchanged) and, when employee_ids is part of
    // this request, for assignment-removal safety validation that must run
    // BEFORE any mutation. fetchSiblings() is memoized so it issues exactly
    // one query regardless of how many times it's called -- when
    // employee_ids is absent (the common case: rescheduling, renaming,
    // etc.), it's still only ever called once, at the original point in the
    // flow, preserving the exact pre-R18 call order/count for every request
    // that doesn't touch assignments.
    type Sibling = { id: string; scheduled_for: string; scheduled_end: string | null };
    let siblingsCache: Sibling[] | null = null;
    async function fetchSiblings(): Promise<Sibling[]> {
      if (siblingsCache) return siblingsCache;
      if (mode !== "future" || !existingData.series_id) {
        siblingsCache = [];
        return siblingsCache;
      }
      const { data, error: sibErr } = await supabaseAdmin
        .from("appointments")
        .select("id, scheduled_for, scheduled_end")
        .eq("series_id", existingData.series_id)
        .eq("workspace_id", workspaceId)
        .eq("status", "scheduled")
        .gt("scheduled_for", existingData.scheduled_for)
        .order("scheduled_for", { ascending: true });
      if (sibErr) throw sibErr;
      siblingsCache = data ?? [];
      return siblingsCache;
    }

    // Phase 5.7D-R18: validate every assignment change (origin + every
    // future sibling) BEFORE mutating anything. An assignment that already
    // has recorded work (a Job Tracking timestamp or a saved manual
    // appointment_employee_hours entry) must never be silently discarded by
    // ordinary appointment editing -- if ANY removal anywhere in this
    // request is blocked, the entire request is rejected with zero writes,
    // rather than partially applying some changes and skipping others.
    let originPlan: { toAdd: string[]; toRemove: string[] } | null = null;
    const siblingPlans = new Map<string, { toAdd: string[]; toRemove: string[] }>();

    if (employee_ids !== undefined) {
      const siblingsForValidation = await fetchSiblings();
      const appointmentIds = [appointment_id, ...siblingsForValidation.map((s) => s.id)];
      const allEmployeeHours = await fetchEmployeeHoursForAppointments(appointmentIds, workspaceId);
      const blockedEmployeeIds = new Set<string>();

      const originResult = await planAssignmentSync(
        appointment_id,
        workspaceId,
        employee_ids,
        allEmployeeHours.filter((h) => h.appointment_id === appointment_id)
      );
      if (!originResult.ok) {
        for (const id of originResult.blockedEmployeeIds) blockedEmployeeIds.add(id);
      } else {
        originPlan = originResult;
      }

      if (mode === "future") {
        for (const sib of siblingsForValidation) {
          const sibResult = await planAssignmentSync(
            sib.id,
            workspaceId,
            employee_ids,
            allEmployeeHours.filter((h) => h.appointment_id === sib.id)
          );
          if (!sibResult.ok) {
            for (const id of sibResult.blockedEmployeeIds) blockedEmployeeIds.add(id);
          } else {
            siblingPlans.set(sib.id, sibResult);
          }
        }
      }

      if (blockedEmployeeIds.size > 0) {
        return json(
          {
            error: "One or more employees being removed already have recorded worked hours and cannot be removed here. Use a dedicated historical correction instead.",
            code: "ASSIGNMENT_REMOVAL_BLOCKED",
            blockedEmployeeIds: Array.from(blockedEmployeeIds),
          },
          409
        );
      }
    }

    // Block 2B safety correction: a "This & Future" edit to an appointment
    // belonging to an ACTIVE series must quarantine that series to
    // review_required BEFORE any appointment row is mutated -- a "single"
    // edit never touches the registry at all, matching every other route's
    // "abort before appointment mutation" invariant. quarantineIfObservedActive
    // explicitly observes the row's current status first, so a zero-row
    // compare-and-set result is only ever a safe no-op when that
    // observation already showed the series wasn't active; if it WAS
    // observed active and the transition then matches nothing, that's a
    // genuine concurrent change -- abort with 409 and never touch a single
    // appointment row. oldSeriesWasActive is remembered so the post-mutation
    // re-finalize step below only ever attempts to reactivate a series this
    // same request actually quarantined -- it must never auto-activate a
    // legacy review_required series just because one of its occurrences
    // happened to be edited.
    const seriesInvolved = mode === "future" && !!existingData.series_id;
    let oldSeriesWasActive = false;
    if (seriesInvolved) {
      let outcome: Awaited<ReturnType<typeof quarantineIfObservedActive>>;
      try {
        outcome = await quarantineIfObservedActive(existingData.series_id!, workspaceId);
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        return json({ error: "Unable to prepare this recurring series for changes right now. Please try again." }, 500);
      }
      if (outcome.outcome === "conflict") {
        return json({ error: "This recurring series was changed by another request. Please refresh and try again." }, 409);
      }
      oldSeriesWasActive = outcome.outcome === "quarantined";
    }

    const apptUpdate: Record<string, any> = {};
    if (body.service_type !== undefined)
      apptUpdate.service_type = body.service_type.trim();
    if (body.scheduled_for !== undefined)
      apptUpdate.scheduled_for = body.scheduled_for.trim();
    if (body.status !== undefined) apptUpdate.status = body.status.trim();
    if (body.notes !== undefined) apptUpdate.notes = body.notes.trim() || null;
    if (body.scheduled_end !== undefined && await hasColumn("scheduled_end"))
      apptUpdate.scheduled_end = body.scheduled_end;
    if (typeof body.duration_minutes === "number" && await hasColumn("duration_minutes"))
      apptUpdate.duration_minutes = body.duration_minutes;
    // price_cents: undefined means "not part of this request, leave
    // unchanged"; null explicitly clears a previously-set price back to "no
    // price." Never re-derived from the appointment's service here -- the
    // client already resolved whatever value it wants stored.
    if (body.price_cents !== undefined && await hasColumn("price_cents")) {
      if (body.price_cents === null) {
        apptUpdate.price_cents = null;
      } else if (isValidPriceCents(body.price_cents)) {
        apptUpdate.price_cents = body.price_cents;
      } else {
        return json({ error: "Price must be a valid, non-negative amount." }, 400);
      }
    }
    // appointments.employee_id: read-only compatibility mirror (Phase
    // 5.7D-R18), not the authoritative assignment list -- appointment_employees
    // (synced below, after this row's own field update) is authoritative.
    if (employee_ids !== undefined && await hasColumn("employee_id")) {
      apptUpdate.employee_id = deriveLegacyEmployeeId(employee_ids);
    }
    // team_color (Phase 5.7D-R19): undefined means "not part of this
    // request, leave unchanged" -- same convention as price_cents above.
    // Explicit null clears a previously-selected team color back to "no
    // explicit selection" (the only way it's ever cleared -- dropping to
    // one or zero employees never implicitly clears it, see
    // lib/teamColor.ts's resolveTeamAccentColor). A non-null value must be
    // a strict #RRGGBB hex color; anything else is rejected before any
    // write happens.
    if (body.team_color !== undefined && await hasColumn("team_color")) {
      const teamColorValidation = validateTeamColorInput(body.team_color);
      if (!teamColorValidation.ok) return json({ error: teamColorValidation.error }, 400);
      apptUpdate.team_color = teamColorValidation.value;
    }

    if (Object.keys(apptUpdate).length > 0) {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update(apptUpdate)
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    }

    if (originPlan) {
      await applyAssignmentSync(appointment_id, workspaceId, originPlan.toAdd, originPlan.toRemove);
    }

    const siblings = await fetchSiblings();

    if (mode === "future" && siblings.length > 0) {
      const newStart = body.scheduled_for ? new Date(body.scheduled_for) : null;
      const newEnd = body.scheduled_end ? new Date(body.scheduled_end) : null;
      const oldStart = new Date(existingData.scheduled_for);
      const oldEnd = existingData.scheduled_end ? new Date(existingData.scheduled_end) : null;

      // Full timestamp delta, not a same-day hour/minute comparison: moving
      // the selected occurrence from Thursday to Wednesday at an unchanged
      // clock time has zero hour/minute delta, so a time-of-day-only check
      // never propagates it, leaving every future occurrence stuck on the
      // old weekday. Each sibling is a materialized, independently-stored
      // row (see manage-recurrence's generateFutureDates insert), so this
      // delta must be added to each sibling's own scheduled_for/scheduled_end
      // rather than recomputed from the recurrence rule -- that's also what
      // keeps the interval between occurrences intact regardless of
      // frequency_type (daily/weekdays/weekly/every-N-weeks).
      const startDeltaMs = newStart ? newStart.getTime() - oldStart.getTime() : 0;
      const endDeltaMs = newEnd && oldEnd ? newEnd.getTime() - oldEnd.getTime() : startDeltaMs;

      for (const sib of siblings) {
        const sibUpdate: Record<string, any> = {};

        if (apptUpdate.service_type !== undefined) sibUpdate.service_type = apptUpdate.service_type;
        if (apptUpdate.notes !== undefined) sibUpdate.notes = apptUpdate.notes;
        if (apptUpdate.duration_minutes !== undefined) sibUpdate.duration_minutes = apptUpdate.duration_minutes;
        if (apptUpdate.employee_id !== undefined) sibUpdate.employee_id = apptUpdate.employee_id;
        if (apptUpdate.price_cents !== undefined) sibUpdate.price_cents = apptUpdate.price_cents;
        // Phase 5.7D-R19: "this and future" copies the selected occurrence's
        // team_color onto every eligible future sibling, exactly mirroring
        // price_cents immediately above -- including an explicit null
        // (clearing) propagating the same way a real color value does.
        if (apptUpdate.team_color !== undefined) sibUpdate.team_color = apptUpdate.team_color;

        if (startDeltaMs !== 0) {
          sibUpdate.scheduled_for = new Date(new Date(sib.scheduled_for).getTime() + startDeltaMs).toISOString();
        }
        if (endDeltaMs !== 0 && sib.scheduled_end) {
          sibUpdate.scheduled_end = new Date(new Date(sib.scheduled_end).getTime() + endDeltaMs).toISOString();
        }

        if (Object.keys(sibUpdate).length > 0) {
          const { error } = await supabaseAdmin
            .from("appointments")
            .update(sibUpdate)
            .eq("id", sib.id)
            .eq("workspace_id", workspaceId);
          if (error) throw error;
        }

        const sibPlan = siblingPlans.get(sib.id);
        if (sibPlan) {
          await applyAssignmentSync(sib.id, workspaceId, sibPlan.toAdd, sibPlan.toRemove);
        }
      }

    }

    // Block 2B safety correction: re-finalize the series ONLY if it was
    // actually active (and therefore quarantined) at the top of this
    // request -- a legacy review_required series must never be silently
    // auto-activated just because one of its occurrences was edited; that
    // remains exclusively an explicit owner action via
    // app/api/recurring-series/activate. This is the confirmed template's
    // fields (service, price, duration, notes, team color, employee
    // assignments) moving forward via template_appointment_id -- the
    // registry never duplicates those values itself, it only points at the
    // appointment row that carries them. Anchor date/time/timezone are
    // recomputed from the edited appointment's own current scheduled_for,
    // a no-op when the time didn't actually change.
    let registryWarning = false;
    if (seriesInvolved && oldSeriesWasActive) {
      try {
        const { data: settings } = await supabaseAdmin
          .from("company_settings")
          .select("timezone")
          .eq("workspace_id", workspaceId)
          .maybeSingle();
        const timezone = effectiveTimezone(settings?.timezone);

        const seriesRow = await fetchSeriesById(existingData.series_id!, workspaceId);
        const liveOccurrences = await fetchLiveOccurrenceSnapshots(existingData.series_id!, workspaceId);
        const consistency = seriesRow
          ? evaluateSeriesConsistency(liveOccurrences, appointment_id, seriesRow.frequency_type, timezone, seriesRow.repeat_months)
          : ({ ok: false, blockers: [] } as const);

        if (consistency.ok) {
          const outcome = await finalizeSeriesActive({
            seriesId: existingData.series_id!,
            workspaceId,
            clientId: existingData.client_id,
            templateAppointmentId: appointment_id,
            scheduledForIso: apptUpdate.scheduled_for ?? existingData.scheduled_for,
            timezone,
          });
          if (outcome.outcome !== "activated") registryWarning = true;
        } else {
          // Stays quarantined in review_required -- the resulting live tail
          // no longer agrees, so this requires explicit owner review rather
          // than an automatic reactivation.
          registryWarning = true;
        }
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        registryWarning = true;
      }
    }

    const clientUpdate: Record<string, any> = {};
    if (body.email !== undefined) clientUpdate.email = body.email.trim() || null;
    if (body.phone !== undefined) clientUpdate.phone = body.phone.trim() || null;
    if (body.name !== undefined) clientUpdate.name = body.name.trim();

    if (Object.keys(clientUpdate).length > 0) {
      const { error } = await supabaseAdmin
        .from("clients")
        .update(clientUpdate)
        .eq("id", existingData.client_id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
    }

    if (notify_channel !== "none" && !existingData.is_demo) {
      // The appointment/client updates above have already completed and
      // succeeded regardless of what happens next -- canSendNotifications is
      // evaluated as an independent follow-up step, using the exact
      // workspaceId this route already established for the authenticated
      // session, never re-derived and never request-supplied. When denied,
      // the appointment/client lookups below are skipped entirely -- same
      // pattern as appointments/cancel and cron/reminders.
      const notifyCapability = await requireCapabilityForWorkspace(workspaceId, "canSendNotifications");
      if (notifyCapability.allowed) {
        const apptRes = await supabaseAdmin
          .from("appointments")
          .select("service_type, scheduled_for")
          .eq("id", appointment_id)
          .eq("workspace_id", workspaceId)
          .single();
        const clientRes = await supabaseAdmin
          .from("clients")
          .select("name, email, phone, auto_email, auto_sms")
          .eq("id", existingData.client_id)
          .eq("workspace_id", workspaceId)
          .single();

        if (!apptRes.error && !clientRes.error) {
          const { name, email, phone, auto_email, auto_sms } = clientRes.data;
          const { service_type, scheduled_for } = apptRes.data;
          const { companyName, timezone } = await getCompanyIdentity(workspaceId);
          const t = changeTemplates(name, service_type, scheduled_for, companyName, timezone);

          if (email && auto_email && shouldSend(notify_channel, "email")) {
            try {
              const providerId = await sendEmail(email, t.email.subject, t.email.body, workspaceId, companyName);
              await recordMessageSent({
                appointment_id, channel: "email", kind: "update", workspace_id: workspaceId,
                to_value: email, body: t.email.body, provider_id: providerId,
              });
            } catch (err) {
              console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
              await recordMessageSent({
                appointment_id, channel: "email", kind: "update", workspace_id: workspaceId,
                to_value: email, body: t.email.body, provider_id: "failed",
              });
            }
          }
          // Runs even if the email attempt above failed — one provider's
          // failure must not block the other channel.
          if (phone && auto_sms && shouldSend(notify_channel, "sms")) {
            try {
              const providerId = await sendSms(phone, t.sms, workspaceId);
              await recordMessageSent({
                appointment_id, channel: "sms", kind: "update", workspace_id: workspaceId,
                to_value: phone, body: t.sms, provider_id: providerId,
              });
            } catch (err) {
              console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
              await recordMessageSent({
                appointment_id, channel: "sms", kind: "update", workspace_id: workspaceId,
                to_value: phone, body: t.sms, provider_id: "failed",
              });
            }
          }
        }
      }
    }

    return json({ ok: true, ...(registryWarning ? { warning: RECURRING_SERIES_REVIEW_WARNING } : {}) });
  } catch (e: any) {
    console.error("UPDATE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
