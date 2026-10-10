export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendEmail, sendSms, shouldSend, describeProviderError, recordMessageSent, getCompanyIdentity, NotifyChannel } from "@/lib/notify";
import { cancelTemplates } from "@/lib/templates";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability, requireCapabilityForWorkspace } from "@/lib/entitlementServer";
import { quarantineIfObservedActive, finalizeSeriesStopped, RECURRING_SERIES_REVIEW_WARNING } from "@/lib/recurringSeries";
import { isHistoricalAppointment, deriveAppointmentTrackingStatus } from "@/lib/payroll";
import { fetchAssignments } from "@/lib/appointmentEmployees";

const CANCELLATION_REASON_MAX_LENGTH = 2000;

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// Strict "YYYY-MM-DD" validation for cancellation_reported_date: a plain
// regex alone (the convention this codebase otherwise uses for date-range
// query strings, e.g. app/api/billing/completed-jobs/route.ts) only checks
// shape, not calendar validity -- it would accept "2026-13-45" and pass it
// straight through to a real Postgres DATE column, turning a client input
// mistake into a 500 instead of a clean 400. The round-trip through Date's
// own UTC getters rejects any out-of-range month/day (including Feb 30/31,
// which Date silently rolls into March rather than rejecting).
function isValidDateInput(value: string): boolean {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m;
  const parsed = new Date(`${y}-${mo}-${d}T00:00:00.000Z`);
  return (
    !isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(y) &&
    parsed.getUTCMonth() + 1 === Number(mo) &&
    parsed.getUTCDate() === Number(d)
  );
}

async function hasColumn(col: string): Promise<boolean> {
  const { error } = await supabaseAdmin
    .from("appointments")
    .select(col)
    .limit(0);
  return !error;
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

    const appointment_id = (body.appointment_id || "").trim();
    const mode = body.mode;
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);
    if (mode !== "single" && mode !== "future")
      return json({ error: "Invalid mode" }, 400);
    const notify_channel: NotifyChannel = body.notify_channel || "none";

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const selectFields = "id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes, status, series_id, is_demo";
    let apptRes = await supabaseAdmin
      .from("appointments")
      .select(selectFields)
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();

    if (apptRes.error) {
      apptRes = await supabaseAdmin
        .from("appointments")
        .select("id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes, status, is_demo")
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
    }

    if (apptRes.error) throw apptRes.error;
    if (!apptRes.data) return json({ error: "Appointment not found" }, 404);
    const appt = apptRes.data as any;

    if (isTester && !appt.is_demo) {
      return json({ error: "Appointment not found" }, 404);
    }

    // Historical-record protection: a past, completed, or already-cancelled
    // appointment can never be EDITED/RESCHEDULED through this app (see
    // app/api/appointments/update/route.ts, which still rejects every
    // historical appointment unconditionally) -- but recording its
    // cancellation is a different, narrower action this route now
    // explicitly allows for an authorized owner/admin (every caller of this
    // route already passed the role + canMutateOperationalData checks
    // above), per the real case of a client-reported cancellation the owner
    // could not get to record until after the scheduled time had passed.
    // isHistoricalAppointment (lib/payroll.ts) is the single canonical
    // predicate -- it treats the appointment as historical the moment EVERY
    // assigned employee's Job Tracking is complete, even if scheduled_end
    // hasn't elapsed yet, not just cancelled/past-by-time.
    const historicalAssignments = await fetchAssignments(appointment_id, workspaceId);
    const historical = isHistoricalAppointment(appt, historicalAssignments);

    // Correction fields: accepted from any caller, but only ever meaningful
    // (and only ever required) for a historical correction below. A live,
    // not-yet-historical cancellation may still pass a reason/reported date
    // if it has one -- harmless, just persisted alongside the normal
    // cancellation.
    const cancellationReasonInput =
      typeof body.cancellation_reason === "string" ? body.cancellation_reason.trim().slice(0, CANCELLATION_REASON_MAX_LENGTH) : "";
    const cancellationReportedDateInput =
      typeof body.cancellation_reported_date === "string" ? body.cancellation_reported_date.trim() : "";
    if (cancellationReportedDateInput && !isValidDateInput(cancellationReportedDateInput)) {
      return json({ error: "Invalid cancellation reported date." }, 400);
    }

    if (historical) {
      // Idempotent: re-submitting a cancellation for an already-cancelled
      // record is a no-op success, never an error -- matches the public
      // token-based cancel route's own "already" convention
      // (app/api/appointments/cancel/route.ts).
      if (appt.status === "cancelled") {
        return json({ ok: true, already: true, cancelled: 0 });
      }
      // "This and future" is a live-series-management operation (quarantine,
      // sibling discovery, series finalization) that a backfilled historical
      // correction has no business performing -- a historical correction
      // always targets exactly the one past occurrence it's anchored to,
      // and every future occurrence is left completely untouched.
      if (mode !== "single") {
        return json(
          { error: "A past appointment can only be corrected one occurrence at a time. Future occurrences are unaffected.", code: "HISTORICAL_CANCEL_SINGLE_ONLY" },
          409
        );
      }
      // If this appointment is already Completed (every assigned employee's
      // Job Tracking done), overriding that completed record to Cancelled
      // is a correction, not a plain cancellation -- it requires an explicit
      // reason so the audit trail explains why a completed job was retro-
      // actively marked cancelled. A merely past-but-never-worked
      // appointment (the common real case: the client cancelled and no one
      // ever showed up) has nothing to override, so no reason is required.
      const trackingStatus = deriveAppointmentTrackingStatus(historicalAssignments);
      if (trackingStatus === "completed" && !cancellationReasonInput) {
        return json(
          { error: "A reason is required to correct a completed appointment to cancelled.", code: "CANCELLATION_REASON_REQUIRED" },
          400
        );
      }
    }

    // Additive audit fields (migrations/038), set directly -- same
    // convention as the other recently-added appointments columns in this
    // codebase (reminder_24h_sent_at/claimed_at/claim_token), never
    // hasColumn-guarded like the older scheduled_end/duration_minutes/
    // price_cents/series_id fields this route already reads elsewhere.
    // cancelled_at is set on every cancellation (live or historical), never
    // only the historical-correction path, so "when was this actually
    // recorded" is consistently available regardless of which path
    // produced it.
    const cancellationFields: Record<string, unknown> = {
      cancelled_at: new Date().toISOString(),
    };
    if (cancellationReasonInput) cancellationFields.cancellation_reason = cancellationReasonInput;
    if (cancellationReportedDateInput) cancellationFields.cancellation_reported_date = cancellationReportedDateInput;

    async function notifyCancellation() {
      if (notify_channel === "none" || appt.is_demo) return;

      // The cancellation mutation has already completed and succeeded
      // regardless of what happens next -- canSendNotifications is evaluated
      // as an independent follow-up step, using the exact workspaceId this
      // route already established for the authenticated session, never
      // re-derived and never request-supplied. When denied, the client
      // lookup below is skipped entirely -- same pattern as
      // appointments/cancel and cron/reminders.
      const notifyCapability = await requireCapabilityForWorkspace(workspaceId, "canSendNotifications");
      if (!notifyCapability.allowed) return;

      const clientRes = await supabaseAdmin
        .from("clients")
        .select("name, email, phone, auto_email, auto_sms")
        .eq("id", appt.client_id)
        .eq("workspace_id", workspaceId)
        .single();
      if (clientRes.error) return;

      const { name, email, phone, auto_email, auto_sms } = clientRes.data;
      const { companyName, bookingEnabled } = await getCompanyIdentity(workspaceId);
      const t = cancelTemplates(name, appt.service_type, companyName, bookingEnabled);

      if (email && auto_email && shouldSend(notify_channel, "email")) {
        try {
          const providerId = await sendEmail(email, t.email.subject, t.email.body, workspaceId, companyName);
          await recordMessageSent({
            appointment_id, channel: "email", kind: "cancel", workspace_id: workspaceId,
            to_value: email, body: t.email.body, provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_EMAIL_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id, channel: "email", kind: "cancel", workspace_id: workspaceId,
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
            appointment_id, channel: "sms", kind: "cancel", workspace_id: workspaceId,
            to_value: phone, body: t.sms, provider_id: providerId,
          });
        } catch (err) {
          console.error("NOTIFY_SMS_ERROR", describeProviderError(err));
          await recordMessageSent({
            appointment_id, channel: "sms", kind: "cancel", workspace_id: workspaceId,
            to_value: phone, body: t.sms, provider_id: "failed",
          });
        }
      }
    }

    if (mode === "single") {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update({ status: "cancelled", ...cancellationFields })
        .eq("id", appointment_id)
        .eq("workspace_id", workspaceId);
      if (error) throw error;
      await notifyCancellation();
      return json({ ok: true, cancelled: 1 });
    }

    // mode === "future"
    //
    // Production-review correction (Block 2C-2B lifecycle-concurrency
    // audit): the target-id query used to run BEFORE quarantineIfObservedActive
    // below, and that pre-quarantine list was what actually got cancelled --
    // a future occurrence inserted by a concurrent replenish_recurring_series
    // call in the narrow window between that read and the quarantine call
    // would be silently absent from `ids`, left live and un-cancelled, even
    // though the series itself was about to be stopped -- a genuinely
    // orphaned appointment with no series left to ever reconsider it. The
    // fix is to quarantine FIRST (unconditionally, whenever this appointment
    // belongs to a series), THEN query the authoritative target set fresh --
    // so any occurrence a concurrent replenishment call already committed
    // before this quarantine takes effect is correctly swept up and
    // cancelled here, and any occurrence a concurrent call attempts AFTER
    // this quarantine commits is independently rejected by
    // replenish_recurring_series's own fresh status check (it requires
    // status = 'active', which this quarantine has already cleared).
    let registryWarning = false;
    let oldSeriesWasActive = false;

    if (appt.series_id) {
      // Block 2B safety correction: "Delete This & Future" is explicit
      // owner intent to stop the series -- quarantined to review_required
      // BEFORE any appointment row is touched. quarantineIfObservedActive
      // explicitly observes the row's current status first, so a zero-row
      // compare-and-set result is only ever a safe no-op when that
      // observation already showed the series wasn't active; if it WAS
      // observed active and the transition then matches nothing, that's a
      // genuine concurrent change and the whole cancellation must abort
      // with 409, never silently proceed.
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

    // Prefer series_id if the appointment belongs to a series -- queried
    // fresh here, AFTER the quarantine above, never before it.
    let query = supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("status", "scheduled")
      .eq("workspace_id", workspaceId)
      .eq("is_demo", appt.is_demo)
      .gte("scheduled_for", appt.scheduled_for);

    if (appt.series_id && await hasColumn("series_id")) {
      query = query.eq("series_id", appt.series_id);
    } else {
      query = query.eq("client_id", appt.client_id).eq("service_type", appt.service_type);
    }

    const { data: targets, error: qErr } = await query;
    if (qErr) throw qErr;

    const ids = (targets ?? []).map((t: any) => t.id);

    if (ids.length > 0) {
      const { error } = await supabaseAdmin
        .from("appointments")
        .update({ status: "cancelled", ...cancellationFields })
        .in("id", ids)
        .eq("workspace_id", workspaceId);
      if (error) throw error;

      await notifyCancellation();
    }

    // Finalize the quarantined series as stopped -- only after the
    // cancellation above has already fully succeeded (or was correctly
    // skipped because there was nothing left to cancel), and only ever
    // attempted when THIS request actually quarantined it a moment ago.
    // Deliberately NOT gated on ids.length > 0 (unlike before this
    // correction) -- a series this request quarantined must always be
    // finalized as stopped, even in the rare case where the freshly
    // re-queried target set came back empty, rather than being left stuck
    // in review_required with no appointment mutation left to explain why.
    // A failure (thrown error, or a zero-row compare-and-set -- e.g. some
    // other concurrent request already changed its status again) leaves
    // the series in review_required (never forced into any other state)
    // and surfaces as a non-sensitive warning on this still-successful
    // response.
    if (oldSeriesWasActive) {
      try {
        const transitioned = await finalizeSeriesStopped(appt.series_id, workspaceId);
        if (!transitioned) registryWarning = true;
      } catch (err) {
        console.error("RECURRING_SERIES_REGISTRY_ERROR", err);
        registryWarning = true;
      }
    }

    return json({ ok: true, cancelled: ids.length, ...(registryWarning ? { warning: RECURRING_SERIES_REVIEW_WARNING } : {}) });
  } catch (e: any) {
    console.error("DELETE_APPOINTMENT_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
