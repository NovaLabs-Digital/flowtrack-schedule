export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, describeProviderError, recordMessageSent, getCompanyIdentity, NotifyChannel } from "@/lib/notify";
import { changeTemplates } from "@/lib/templates";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { requireCapability, requireCapabilityForWorkspace } from "@/lib/entitlementServer";
import { isValidPriceCents } from "@/lib/money";
import {
  dedupeEmployeeIds,
  deriveLegacyEmployeeId,
  validateEmployeeIdsInWorkspace,
  planAssignmentSync,
  syncAssignmentsAtomically,
  fetchEmployeeHoursForAppointments,
  fetchAssignments,
  type AssignmentSyncOutcome,
} from "@/lib/appointmentEmployees";
import { validateTeamColorInput } from "@/lib/teamColor";
import {
  fetchSeriesById,
  fetchLiveOccurrenceSnapshots,
  evaluateSeriesConsistency,
  RECURRING_SERIES_REVIEW_WARNING,
} from "@/lib/recurringSeries";
import { effectiveTimezone } from "@/lib/timezone";
import { isHistoricalAppointment } from "@/lib/payroll";
import { localMoveBetween, applyLocalMove } from "@/lib/localShift";
import { excludeSeriesOccurrence } from "@/lib/seriesOccurrenceExclusion";

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

// Block 2C-1: safe, non-raw responses for every non-"synced" outcome
// sync_appointment_assignments can return. Assignment synchronization is
// part of this request's own operational mutation, not a best-effort side
// effect -- every one of these stops the request immediately (see the two
// call sites below), never reports ok:true, and never leaks a raw
// SQL/database detail.
function assignmentSyncErrorResponse(outcome: Exclude<AssignmentSyncOutcome, "synced">) {
  if (outcome === "employee_not_eligible") {
    return json(
      { error: "One or more assigned employees are no longer active or no longer belong to this workspace. Please refresh and try again.", code: "ASSIGNMENT_SYNC_FAILED" },
      409
    );
  }
  if (outcome === "state_changed") {
    return json(
      { error: "This appointment's staff assignments changed since you loaded this page. Please refresh and try again.", code: "ASSIGNMENT_SYNC_FAILED" },
      409
    );
  }
  // appointment_not_found
  return json(
    { error: "This appointment could not be found. Please refresh and try again.", code: "ASSIGNMENT_SYNC_FAILED" },
    409
  );
}

export async function PATCH(req: Request) {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
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
      .select("id, client_id, series_id, scheduled_for, scheduled_end, duration_minutes, status, is_demo")
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (!existing.data) return json({ error: "Appointment not found" }, 404);
    if (isTester && !existing.data.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }

    // Historical-record protection (founder decision): a past, completed, or
    // already-cancelled appointment can never be edited/rescheduled through
    // this route, in either mode -- checked before any read/validation that
    // could imply a mutation is in progress, and before any DB write. Mode
    // "future" is anchored to this exact row (siblings are queried with
    // scheduled_for > this row's own scheduled_for), so rejecting a
    // historical anchor here also guarantees no future sibling is ever
    // touched by a request anchored to a historical occurrence.
    // isHistoricalAppointment (lib/payroll.ts) additionally treats the
    // appointment as historical the moment EVERY assigned employee's Job
    // Tracking is complete, even if scheduled_end hasn't elapsed yet.
    const historicalAssignments = await fetchAssignments(appointment_id, workspaceId);
    if (isHistoricalAppointment(existing.data, historicalAssignments)) {
      return json({ error: "This appointment is a past record and can no longer be changed.", code: "APPOINTMENT_IS_HISTORICAL" }, 409);
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

    const inactiveEmployeeIds = new Set<string>();
    if (employee_ids !== undefined) {
      const employeeValidation = await validateEmployeeIdsInWorkspace(employee_ids, workspaceId);
      if (!employeeValidation.ok) return json({ error: employeeValidation.error }, 404);
      for (const id of employeeValidation.inactiveIds) inactiveEmployeeIds.add(id);
    }

    // Siblings (for "future" mode) are needed both for the pre-R18
    // time-shift logic below (unchanged) and, when employee_ids is part of
    // this request, for assignment-removal safety validation that must run
    // BEFORE any mutation.
    //
    // Production-review correction (Block 2C-2B lifecycle-concurrency
    // audit): this used to be memoized (cached after its first call), which
    // meant that whenever employee_ids was part of the request, the EARLY
    // call below (for assignment-removal validation, before the series is
    // quarantined) silently served its cached, now-stale result to the
    // LATER call further down -- the one that actually decides which
    // sibling rows get mutated -- even though that later call happens
    // AFTER quarantineIfObservedActive has already run. A recurring-series
    // occurrence inserted by a concurrent replenish_recurring_series call
    // in the narrow window between the early fetch and the quarantine call
    // would then be silently absent from the mutation loop, while still
    // being live and (via evaluateSeriesConsistency's own separate, always-
    // fresh fetch) potentially causing an otherwise-successful edit to be
    // unnecessarily flagged for review. Removing the cache means every call
    // always queries fresh -- the common case (employee_ids absent) still
    // issues exactly one query, at the same point as before; only the
    // employee_ids-present case now correctly re-queries after quarantine,
    // which is the one case that actually needed it.
    //
    // The edited appointment itself is never one of its own siblings. The
    // mutation-time call below runs AFTER this appointment has been saved at
    // its new time; moved later, it would otherwise match the "later than
    // the original time" filter and be moved a second time (9:00 entered,
    // 10:00 saved -- reported 2026-11-11).
    type Sibling = { id: string; scheduled_for: string; scheduled_end: string | null };
    async function fetchSiblings(): Promise<Sibling[]> {
      if (mode !== "future" || !existingData.series_id) {
        return [];
      }
      const { data, error: sibErr } = await supabaseAdmin
        .from("appointments")
        .select("id, scheduled_for, scheduled_end")
        .eq("series_id", existingData.series_id)
        .eq("workspace_id", workspaceId)
        .eq("status", "scheduled")
        .neq("id", appointment_id)
        .gt("scheduled_for", existingData.scheduled_for)
        .order("scheduled_for", { ascending: true });
      if (sibErr) throw sibErr;
      return data ?? [];
    }

    // The workspace's saved timezone, read at most once per request.
    let timezoneCache: string | null = null;
    async function workspaceTimezone(): Promise<string> {
      if (timezoneCache) return timezoneCache;
      const { data: settings } = await supabaseAdmin
        .from("company_settings")
        .select("timezone")
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      timezoneCache = effectiveTimezone(settings?.timezone);
      return timezoneCache;
    }

    // "This & future": every later occurrence moves by the same change the
    // owner made to this one, in the business's local calendar and clock
    // (lib/localShift.ts) -- never a fixed elapsed-time offset, which lands an
    // hour off whenever this occurrence's old and new dates sit on opposite
    // sides of a daylight-saving change. Each occurrence keeps its own clock
    // time plus that change, and its own duration (plus any change the owner
    // made to this occurrence's duration).
    const newStartIso = typeof body.scheduled_for === "string" ? body.scheduled_for.trim() : null;
    const startChanges = !!newStartIso && new Date(newStartIso).getTime() !== new Date(existingData.scheduled_for).getTime();
    const durationDeltaMs =
      body.scheduled_end && existingData.scheduled_end
        ? new Date(body.scheduled_end).getTime() - new Date(existingData.scheduled_end).getTime() -
          ((newStartIso ? new Date(newStartIso).getTime() : new Date(existingData.scheduled_for).getTime()) -
            new Date(existingData.scheduled_for).getTime())
        : 0;
    type SiblingTarget = { scheduled_for?: string; scheduled_end?: string };
    async function planSiblingTargets(sibs: Sibling[]): Promise<{ ok: true; targets: Map<string, SiblingTarget> } | { ok: false; local: string }> {
      const targets = new Map<string, SiblingTarget>();
      if (sibs.length === 0 || (!startChanges && durationDeltaMs === 0)) return { ok: true, targets };
      const timezone = startChanges ? await workspaceTimezone() : "";
      const move = startChanges ? localMoveBetween(existingData.scheduled_for, newStartIso!, timezone) : null;
      for (const sib of sibs) {
        const target: SiblingTarget = {};
        const oldStartMs = new Date(sib.scheduled_for).getTime();
        let startMs = oldStartMs;
        if (move) {
          const moved = applyLocalMove(sib.scheduled_for, move, timezone);
          if (!moved.ok) return { ok: false, local: moved.local };
          startMs = new Date(moved.iso).getTime();
          if (startMs !== oldStartMs) target.scheduled_for = new Date(startMs).toISOString();
        }
        if (sib.scheduled_end) {
          const endMs = startMs + (new Date(sib.scheduled_end).getTime() - oldStartMs) + durationDeltaMs;
          if (endMs !== new Date(sib.scheduled_end).getTime()) target.scheduled_end = new Date(endMs).toISOString();
        }
        targets.set(sib.id, target);
      }
      return { ok: true, targets };
    }

    // Checked before anything is written: a later occurrence that would land
    // on a time the clock skips (the spring-forward gap) refuses the whole
    // request, the same rule appointment entry and the recurrence generator use.
    if (mode === "future" && existingData.series_id && startChanges) {
      const plan = await planSiblingTargets(await fetchSiblings());
      if (!plan.ok) {
        return json(
          {
            error: `A later appointment in this series would move to ${plan.local}, a time that doesn't exist because of a daylight-saving change. Nothing was saved. Move only this appointment, or choose another time.`,
            code: "NONEXISTENT_LOCAL_TIME",
          },
          400
        );
      }
    }

    // Phase 5.7D-R18: validate every assignment change (origin + every
    // future sibling) BEFORE mutating anything. An assignment that already
    // has recorded work (a Job Tracking timestamp or a saved manual
    // appointment_employee_hours entry) must never be silently discarded by
    // ordinary appointment editing -- if ANY removal anywhere in this
    // request is blocked, the entire request is rejected with zero writes,
    // rather than partially applying some changes and skipping others.
    let originPlan: { toAdd: string[]; toRemove: string[]; currentEmployeeIds: string[] } | null = null;
    const siblingPlans = new Map<string, { toAdd: string[]; toRemove: string[]; currentEmployeeIds: string[] }>();

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

      // An employee who is no longer active can never be newly ADDED to a
      // visit -- refused here, before anything is written, rather than by the
      // assignment sync after this visit was already saved. One who is
      // already on the visit and stays on it is fine (see needsSync below).
      const adding = [...(originPlan?.toAdd ?? []), ...[...siblingPlans.values()].flatMap((p) => p.toAdd)];
      if (adding.some((id) => inactiveEmployeeIds.has(id))) {
        return assignmentSyncErrorResponse("employee_not_eligible");
      }
    }

    // Assignments are only re-synced when this request actually adds or
    // removes someone. The edit form always resends the whole staff list, and
    // the sync refuses any list containing an employee who has since been
    // deactivated -- so an unchanged list used to fail AFTER this visit's new
    // time was saved, and before any later visit was touched (reported
    // 2026-11-11: This & future changed only the selected visit).
    const needsSync = (p: { toAdd: string[]; toRemove: string[] }) => p.toAdd.length > 0 || p.toRemove.length > 0;

    const apptUpdate: Record<string, any> = {};
    if (body.service_type !== undefined)
      apptUpdate.service_type = body.service_type.trim();
    if (body.scheduled_for !== undefined) {
      apptUpdate.scheduled_for = body.scheduled_for.trim();
      // SFT reminder reliability fix: reminder_24h_sent_at is the cron's own
      // dedup flag (app/api/cron/reminders/route.ts) and is never cleared
      // anywhere else -- once an appointment has been reminded, moving it to
      // a new scheduled_for must re-arm eligibility for the NEW time, or it
      // silently never gets reminded again. Only reset when the resolved
      // instant actually differs from the locked row's own value (compared
      // as real timestamps, not strings, since the same instant can arrive
      // formatted differently) -- an edit that happens to resubmit the exact
      // same scheduled_for leaves the flag untouched.
      if (new Date(apptUpdate.scheduled_for).getTime() !== new Date(existingData.scheduled_for).getTime()) {
        apptUpdate.reminder_24h_sent_at = null;
        // SFT reminder claim protocol: any in-flight or stale claim held
        // for the OLD time must also be invalidated -- otherwise a claim
        // token minted before this edit could still (harmlessly, but
        // needlessly) govern eligibility for the NEW time until its lease
        // expires. See app/api/cron/reminders/route.ts's claim/finalize
        // protocol and migrations/036.
        apptUpdate.reminder_24h_claimed_at = null;
        apptUpdate.reminder_24h_claim_token = null;
      }
    }
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

    let registryWarning = false;

    if (mode === "future" && existingData.series_id) {
      // "This & future": the whole edit -- this visit, every later visit,
      // staff changes, and holding/re-confirming the series -- is planned
      // here and applied by ONE database transaction (migrations/047
      // apply_future_edit): either all of it is saved, or none of it.
      const seriesId = existingData.series_id;
      const sibs = await fetchSiblings();
      if (employee_ids !== undefined) {
        const planned = new Set(siblingPlans.keys());
        if (sibs.length !== planned.size || sibs.some((x) => !planned.has(x.id))) {
          return json({ error: "This recurring series was changed by another request. Nothing was saved. Please refresh and try again." }, 409);
        }
      }
      const plan = await planSiblingTargets(sibs);
      if (!plan.ok) {
        return json({ error: "This recurring series was changed by another request. Nothing was saved. Please refresh and try again.", code: "NONEXISTENT_LOCAL_TIME" }, 409);
      }

      // Fields copied onto every later visit (same set as always: never the
      // time, which moves by the local change, and never the status).
      const siblingFields: Record<string, unknown> = {};
      for (const key of ["service_type", "notes", "duration_minutes", "employee_id", "price_cents", "team_color"]) {
        if (apptUpdate[key] !== undefined) siblingFields[key] = apptUpdate[key];
      }
      const siblingsPayload = sibs.map((sib) => {
        const target = plan.targets.get(sib.id) ?? {};
        return {
          id: sib.id,
          expected_scheduled_for: sib.scheduled_for,
          expected_scheduled_end: sib.scheduled_end,
          ...(target.scheduled_for ? { scheduled_for: target.scheduled_for } : {}),
          ...(target.scheduled_end ? { scheduled_end: target.scheduled_end } : {}),
        };
      });
      const sortedIds = (ids: string[]) => [...ids].sort();
      const assignmentsPayload: { appointment_id: string; expected: string[]; desired: string[] }[] = [];
      if (originPlan && needsSync(originPlan)) {
        assignmentsPayload.push({ appointment_id, expected: sortedIds(originPlan.currentEmployeeIds), desired: sortedIds(employee_ids!) });
      }
      for (const sib of sibs) {
        const sibPlan = siblingPlans.get(sib.id);
        if (sibPlan && needsSync(sibPlan)) {
          assignmentsPayload.push({ appointment_id: sib.id, expected: sortedIds(sibPlan.currentEmployeeIds), desired: sortedIds(employee_ids!) });
        }
      }

      // Re-confirming an ACTIVE series: checked here on the planned result,
      // over the visits this edit governs (this one and every later one --
      // upcoming visits before it keep their time and must not hold the
      // series). A legacy review_required series is never auto-confirmed.
      let activation: Record<string, unknown> | null = null;
      try {
        const seriesRow = await fetchSeriesById(seriesId, workspaceId);
        if (seriesRow?.status === "active") {
          const timezone = await workspaceTimezone();
          const current = new Map((await fetchLiveOccurrenceSnapshots(seriesId, workspaceId)).map((o) => [o.id, o]));
          const anchorNow = current.get(appointment_id);
          if (anchorNow) {
            const pick = <T,>(key: string, fallback: T): T => (apptUpdate[key] !== undefined ? apptUpdate[key] : fallback);
            const plannedAnchor = {
              ...anchorNow,
              scheduledFor: pick("scheduled_for", anchorNow.scheduledFor),
              serviceType: pick("service_type", anchorNow.serviceType),
              priceCents: pick("price_cents", anchorNow.priceCents),
              durationMinutes: pick("duration_minutes", anchorNow.durationMinutes),
              teamColor: pick("team_color", anchorNow.teamColor),
              employeeIds: employee_ids ?? anchorNow.employeeIds,
            };
            const plannedLater = sibs.flatMap((sib) => {
              const cur = current.get(sib.id);
              if (!cur) return [];
              const target = plan.targets.get(sib.id);
              return [{
                ...cur,
                scheduledFor: target?.scheduled_for ?? cur.scheduledFor,
                serviceType: pick("service_type", cur.serviceType),
                priceCents: pick("price_cents", cur.priceCents),
                durationMinutes: pick("duration_minutes", cur.durationMinutes),
                teamColor: pick("team_color", cur.teamColor),
                employeeIds: employee_ids ?? cur.employeeIds,
              }];
            });
            const consistency = evaluateSeriesConsistency([plannedAnchor, ...plannedLater], appointment_id, seriesRow.frequency_type, timezone, seriesRow.repeat_months);
            if (consistency.ok) {
              const { data: anchorRow, error: anchorErr } = await supabaseAdmin
                .from("appointments")
                .select("notes")
                .eq("id", appointment_id)
                .eq("workspace_id", workspaceId)
                .single();
              if (anchorErr) throw anchorErr;
              activation = {
                service_type: plannedAnchor.serviceType,
                price_cents: plannedAnchor.priceCents,
                duration_minutes: plannedAnchor.durationMinutes,
                notes: apptUpdate.notes !== undefined ? apptUpdate.notes : anchorRow.notes,
                team_color: plannedAnchor.teamColor,
                scheduled_for: plannedAnchor.scheduledFor,
                employee_ids: sortedIds(plannedAnchor.employeeIds),
                timezone,
              };
            }
          }
        }
      } catch (err) {
        // Planning the re-confirmation failed: the edit still saves, and an
        // active series is left on hold for the owner (review warning).
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        activation = null;
      }

      const anchorFields: Record<string, unknown> = { ...apptUpdate };
      delete anchorFields.reminder_24h_sent_at;
      delete anchorFields.reminder_24h_claimed_at;
      delete anchorFields.reminder_24h_claim_token;

      const { data: applied, error: applyErr } = await supabaseAdmin.rpc("apply_future_edit", {
        p_workspace_id: workspaceId,
        p_appointment_id: appointment_id,
        p_expected_scheduled_for: existingData.scheduled_for,
        p_anchor: anchorFields,
        p_siblings: siblingsPayload,
        p_sibling_fields: siblingFields,
        p_assignments: assignmentsPayload,
        p_activation: activation,
      });
      if (applyErr) {
        console.error("FUTURE_EDIT_ERROR", applyErr);
        return json({ error: "Unable to save these changes right now. Nothing was saved. Please try again." }, 500);
      }
      const result = (applied ?? {}) as { outcome?: string; review_warning?: boolean };
      if (result.outcome === "employee_not_eligible" || result.outcome === "appointment_not_found") {
        return assignmentSyncErrorResponse(result.outcome);
      }
      if (result.outcome !== "applied") {
        return json({ error: "This recurring series was changed by another request. Nothing was saved. Please refresh and try again." }, 409);
      }
      registryWarning = result.review_warning === true;
    } else {
      // A single occurrence leaving its original time: record that time as
      // skipped on the series FIRST, so an automatic top-up can never recreate
      // the job the owner moved (lib/seriesOccurrenceExclusion.ts). The moved
      // appointment and the rest of the series are unchanged. If this cannot
      // be recorded, nothing is saved.
      if (existingData.series_id && startChanges) {
        const exclusion = await excludeSeriesOccurrence(existingData.series_id, workspaceId, existingData.scheduled_for);
        if (exclusion === "conflict") {
          return json({ error: "This recurring series was changed by another request. Nothing was saved. Please refresh and try again." }, 409);
        }
        if (exclusion === "error") {
          return json({ error: "Unable to move this appointment right now. Nothing was saved. Please try again." }, 500);
        }
      }

      if (Object.keys(apptUpdate).length > 0) {
        const { error } = await supabaseAdmin
          .from("appointments")
          .update(apptUpdate)
          .eq("id", appointment_id)
          .eq("workspace_id", workspaceId);
        if (error) throw error;
      }

      if (originPlan && needsSync(originPlan)) {
        // Block 2C-1: the atomic, shared-lock-coordinated sync (migrations/
        // 027a). Only reached when staff actually change; an inactive
        // employee being added was already refused before any write.
        const syncResult = await syncAssignmentsAtomically({
          appointmentId: appointment_id,
          workspaceId,
          expectedCurrentEmployeeIds: originPlan.currentEmployeeIds,
          desiredEmployeeIds: employee_ids!,
        });
        if (syncResult.outcome !== "synced") {
          return assignmentSyncErrorResponse(syncResult.outcome);
        }
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
                to_value: email, body: t.email.body, subject: t.email.subject, provider_id: providerId,
              });
            } catch (err) {
              console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
              await recordMessageSent({
                appointment_id, channel: "email", kind: "update", workspace_id: workspaceId,
                to_value: email, body: t.email.body, subject: t.email.subject, provider_id: "failed",
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
