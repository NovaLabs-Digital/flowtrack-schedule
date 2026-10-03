export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { fetchAssignments, fetchEmployeeHoursForAppointments } from "@/lib/appointmentEmployees";
import { isCompletedForBilling, normalizeInvoiceNumber, validateBillingState, isValidPaymentMethod } from "@/lib/completedJobBilling";

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// PATCH /api/billing/completed-jobs/update
// Body: { appointment_id: string, invoice_number?: string|null, paid?: boolean, payment_method?: string|null }
//
// A PARTIAL update -- only the fields actually present in the body are
// changed; an absent field keeps its current value (or the "no row yet"
// default: invoice_number=null, paid=false, payment_method=null). This
// matches the inline-edit UI, where Invoice #, Paid, and Payment Method are
// each editable independently (e.g. ticking Paid before an invoice number
// has been typed must not clear/reject anything that wasn't touched).
//
// Validation always runs against the RESULTING merged state (see
// lib/completedJobBilling.ts's validateBillingState), not just the fields
// in this one request -- "paid requires a payment method" is a property of
// the row as a whole.
export async function PATCH(req: Request) {
  try {
    const session = await getSession();
    const deny = requireRole(session, ["owner", "tester"]);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;
    const isTester = session.role === "tester";

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json();
    const appointment_id = (body.appointment_id || "").trim();
    if (!appointment_id) return json({ error: "Missing appointment_id" }, 400);

    const hasField = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

    if (hasField("invoice_number") && body.invoice_number !== null && typeof body.invoice_number !== "string") {
      return json({ error: "Invalid invoice number" }, 400);
    }
    if (hasField("paid") && typeof body.paid !== "boolean") {
      return json({ error: "paid must be true or false" }, 400);
    }
    if (hasField("payment_method") && body.payment_method !== null && !isValidPaymentMethod(body.payment_method)) {
      return json({ error: "Invalid payment method" }, 400);
    }

    // The appointment must exist, belong to this workspace (and, for a
    // tester session, be demo data -- same guard as
    // app/api/appointments/delete/route.ts), and must already be
    // "completed" per the single authoritative definition
    // (isCompletedForBilling) before any billing fields can be attached to
    // it. This is enforced server-side regardless of what the UI shows --
    // the UI only ever offers these controls on an already-completed row,
    // but the server never trusts that without re-checking.
    const apptRes = await supabaseAdmin
      .from("appointments")
      .select("id, workspace_id, is_demo, status, client_id")
      .eq("id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (apptRes.error) throw apptRes.error;
    const appt = apptRes.data as { id: string; workspace_id: string; is_demo: boolean; status: string; client_id: string } | null;
    if (!appt) return json({ error: "Appointment not found" }, 404);
    if (isTester && !appt.is_demo) return json({ error: "Appointment not found" }, 404);

    const assignments = await fetchAssignments(appointment_id, workspaceId);
    // employeeHours (appointment_employee_hours): an owner-approved worked-
    // time correction resolves an otherwise-missing/incomplete Job Tracking
    // pair for billing purposes -- see isCompletedForBilling's and
    // isAppointmentBillingEligible's doc comments. Never fabricates or
    // rewrites assignments' own actual_started_at/actual_completed_at.
    const employeeHours = await fetchEmployeeHoursForAppointments([appointment_id], workspaceId);
    if (!isCompletedForBilling(appointment_id, assignments, employeeHours)) {
      return json({ error: "This appointment is not marked completed yet." }, 409);
    }

    const existingRes = await supabaseAdmin
      .from("completed_job_billing")
      .select("invoice_number, paid, payment_method")
      .eq("appointment_id", appointment_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (existingRes.error) throw existingRes.error;
    const existing = existingRes.data as { invoice_number: string | null; paid: boolean; payment_method: string | null } | null;

    const merged = {
      invoice_number: hasField("invoice_number") ? normalizeInvoiceNumber(body.invoice_number) : (existing?.invoice_number ?? null),
      paid: hasField("paid") ? (body.paid as boolean) : (existing?.paid ?? false),
      payment_method: hasField("payment_method") ? (body.payment_method ?? null) : (existing?.payment_method ?? null),
    };

    const validation = validateBillingState(merged);
    if (!validation.ok) return json({ error: validation.error }, 400);

    // Migration 033: an invoice number MAY repeat across multiple completed
    // jobs for the SAME client (a recurring client's visits are routinely
    // combined onto one QuickBooks invoice) but must never be silently
    // reused across DIFFERENT clients in the same workspace. The database
    // no longer enforces a blanket per-workspace uniqueness on
    // invoice_number (see migration 033) -- this IS the enforcement, run
    // only when this request is actually changing invoice_number to a new
    // non-null value, not on every unrelated paid/payment_method edit.
    // completed_job_billing has exactly one write path in this application
    // (this route), so this check is the complete enforcement surface, not
    // a best-effort fallback in front of a stricter database rule.
    const normalizedIncomingInvoiceNumber = hasField("invoice_number") ? normalizeInvoiceNumber(body.invoice_number) : null;
    const invoiceNumberChanged = hasField("invoice_number") && normalizedIncomingInvoiceNumber !== (existing?.invoice_number ?? null);
    if (invoiceNumberChanged && merged.invoice_number !== null) {
      const conflictRes = await supabaseAdmin
        .from("completed_job_billing")
        .select("client_id")
        .eq("workspace_id", workspaceId)
        .eq("invoice_number", merged.invoice_number)
        .neq("appointment_id", appointment_id)
        .neq("client_id", appt.client_id)
        .limit(1)
        .maybeSingle();
      if (conflictRes.error) throw conflictRes.error;
      if (conflictRes.data) {
        return json({ error: "That invoice number is already used by a different client in this workspace." }, 409);
      }
    }

    const { data, error } = await supabaseAdmin
      .from("completed_job_billing")
      .upsert(
        {
          workspace_id: workspaceId,
          appointment_id,
          client_id: appt.client_id,
          invoice_number: merged.invoice_number,
          paid: merged.paid,
          payment_method: merged.payment_method,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "appointment_id" }
      )
      .select("id, workspace_id, appointment_id, client_id, invoice_number, paid, payment_method, created_at, updated_at")
      .single();

    if (error) {
      // 23505 = unique_violation. No DB-level uniqueness on invoice_number
      // remains as of migration 033 (see the cross-client check above,
      // which is the real enforcement) -- this branch is kept purely as a
      // defensive backstop for an unexpected constraint violation (e.g. the
      // untouched appointment_id UNIQUE), translated into a clear message
      // rather than a raw database error, never left to surface the actual
      // SQL/constraint name to the owner.
      if ((error as { code?: string }).code === "23505") {
        return json({ error: "That invoice number is already used by another job in this workspace." }, 409);
      }
      throw error;
    }

    return json({ ok: true, billing: data });
  } catch (e: any) {
    console.error("BILLING_COMPLETED_JOBS_UPDATE_ERROR", e);
    return json({ error: e?.message || "Server error" }, 500);
  }
}
