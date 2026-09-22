export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCapability } from "@/lib/entitlementServer";
import { effectiveTimezone } from "@/lib/timezone";
import type { NotifyChannel } from "@/lib/notify";
import {
  RECURRENCE_FREQUENCIES,
  buildRecurrenceChangeRequest,
  normalizeExpectedSnapshot,
  mapRecurrenceRpcResult,
  isUuid,
} from "@/lib/recurrenceChange";
import { sendAppointmentChangeNotification } from "@/lib/notifyAppointmentChange";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// One request = one database transaction (migrations/029's
// apply_recurrence_change). This route only: authenticates, reads what it
// needs to GENERATE the dates (the workspace timezone), builds the normalized
// request with the existing DST-safe generator, calls the RPC once, and maps
// its outcome. Everything that must be atomic -- validating the expected
// snapshot against the locked row, capturing the original boundary, editing
// the anchor, protecting recorded work, stopping the old series, replacing
// occurrences, activating the new series, recording the operation -- happens
// inside the RPC. The client no longer sends (and the server no longer
// trusts) a "previous scheduled_for": the original position is read from the
// locked row.
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
    const frequency: string = (body.frequency_type || "one_time").trim();
    const operationId = typeof body.client_operation_id === "string" ? body.client_operation_id.trim().toLowerCase() : "";
    const notifyChannel: NotifyChannel = body.notify_channel || "none";

    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
    if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(frequency)) {
      return json({ error: "Invalid frequency_type" }, 400);
    }
    if (!isUuid(operationId)) return json({ error: "Missing or invalid client_operation_id." }, 400);
    const expected = normalizeExpectedSnapshot(body.expected);
    if (!expected) return json({ error: "Missing or invalid expected snapshot." }, 400);

    const isTester = session.role === "tester";
    const workspaceId = session.workspaceId;

    const { data: appt, error: fetchErr } = await supabaseAdmin
      .from("appointments")
      .select("id, client_id, is_demo")
      .eq("id", appointmentId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!appt) return json({ error: "Appointment not found" }, 404);
    if (isTester && !appt.is_demo) return json({ error: "Appointment not found" }, 404);

    const { data: settings } = await supabaseAdmin
      .from("company_settings")
      .select("timezone")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const timezone = effectiveTimezone(settings?.timezone);

    const built = buildRecurrenceChangeRequest({
      fields: body.fields,
      employeeIds: body.employee_ids,
      frequencyType: frequency,
      repeatWeeks: body.repeat_weeks,
      repeatMonths: body.repeat_months,
      timezone,
    });
    if (!built.ok) return json({ error: built.error }, built.status);

    const { data, error: rpcErr } = await supabaseAdmin.rpc("apply_recurrence_change", {
      p_workspace_id: workspaceId,
      p_appointment_id: appointmentId,
      p_operation_id: operationId,
      p_request: built.request,
      p_expected: expected,
    });
    if (rpcErr) {
      // A raised error aborts the whole transaction: nothing was saved.
      console.error("APPLY_RECURRENCE_CHANGE_ERROR", rpcErr);
      return json({ error: "Unable to save this change right now. Nothing was saved. Please try again." }, 500);
    }

    const mapped = mapRecurrenceRpcResult(data);
    if (data?.outcome === "rolled_back") console.error("APPLY_RECURRENCE_CHANGE_ROLLED_BACK", data.reason);

    // Notify only AFTER the transaction has committed (outcome "applied"),
    // never for an identical replay, never for demo data. No outbox exists: a
    // crash between the commit above and this send loses the notification.
    if (mapped.status === 200 && !data.replayed && data.client_visible_change && notifyChannel !== "none" && !appt.is_demo) {
      try {
        await sendAppointmentChangeNotification({
          workspaceId,
          appointmentId,
          clientId: appt.client_id,
          channel: notifyChannel,
        });
      } catch (err) {
        console.error("APPOINTMENT_CHANGE_NOTIFY_ERROR", err);
      }
    }

    return json(mapped.body, mapped.status);
  } catch (e: unknown) {
    console.error("MANAGE_RECURRENCE_ERROR", e);
    return json({ error: "Server error" }, 500);
  }
}
