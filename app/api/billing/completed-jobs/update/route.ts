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

    // Migration 033: an invoice number MAY repeat across multiple completed
    // jobs for the SAME client (a recurring client's visits are routinely
    // combined onto one QuickBooks invoice), but (a) must never be silently
    // reused across DIFFERENT clients in the same workspace, and (b)
    // payment status belongs to the INVOICE, not to any one job inside it
    // -- marking one job in a shared-invoice group Paid must mark every
    // other job under that same (workspace_id, client_id, invoice_number),
    // and the reverse when marked back to unpaid. Otherwise Unpaid $ and
    // reconciliation could show one part of a single QuickBooks invoice as
    // paid and another part as not.
    //
    // Real UI usage edits invoice_number and paid/payment_method in
    // SEPARATE requests (type an invoice number, tab away; later, tick
    // Paid) -- so a job can be given an ALREADY-paid invoice's number
    // without touching Paid in that same request. Left alone, that job
    // would sit at the group's old per-row default (paid=false) right next
    // to its now-paid siblings, which is exactly the inconsistent state
    // this feature exists to prevent. So: when invoice_number is changing
    // to a new non-null value and this request does NOT also explicitly
    // set paid/payment_method, the job instead adopts whatever paid/
    // payment_method its new invoice-mates already agree on.
    const normalizedIncomingInvoiceNumber = hasField("invoice_number") ? normalizeInvoiceNumber(body.invoice_number) : null;
    const invoiceNumberChanged = hasField("invoice_number") && normalizedIncomingInvoiceNumber !== (existing?.invoice_number ?? null);
    if (invoiceNumberChanged && merged.invoice_number !== null && !hasField("paid") && !hasField("payment_method")) {
      const siblingRes = await supabaseAdmin
        .from("completed_job_billing")
        .select("paid, payment_method")
        .eq("workspace_id", workspaceId)
        .eq("client_id", appt.client_id)
        .eq("invoice_number", merged.invoice_number)
        .neq("appointment_id", appointment_id)
        .limit(1)
        .maybeSingle();
      if (siblingRes.error) throw siblingRes.error;
      if (siblingRes.data) {
        merged.paid = siblingRes.data.paid as boolean;
        merged.payment_method = siblingRes.data.payment_method as string | null;
      }
    }

    // Validated against the FINAL merged state -- after the inherit-from-
    // group step above, not before -- since "paid requires a payment
    // method" is a property of what will actually be written, including
    // any inherited values. Inherited values always come from an already-
    // valid sibling row, so this can never newly fail here in practice,
    // but checking the true final state is the correct contract regardless.
    const validation = validateBillingState(merged);
    if (!validation.ok) return json({ error: validation.error }, 400);

    // The sole write path for this table (migration 033's
    // upsert_completed_job_billing): in one transaction, it rejects a
    // cross-client invoice-number conflict, upserts this row, and -- when
    // invoice_number is non-null -- synchronizes paid/payment_method onto
    // every other row sharing the exact same (workspace_id, client_id,
    // invoice_number). A direct two-step upsert-then-sync from here would
    // risk leaving the group half-updated if the second step failed; doing
    // both inside the function keeps it atomic.
    const { data, error } = await supabaseAdmin.rpc("upsert_completed_job_billing", {
      p_workspace_id: workspaceId,
      p_appointment_id: appointment_id,
      p_client_id: appt.client_id,
      p_invoice_number: merged.invoice_number,
      p_paid: merged.paid,
      p_payment_method: merged.payment_method,
    });

    if (error) {
      const code = (error as { code?: string }).code;
      const message = (error as { message?: string }).message || "";
      if (code === "23505" && message.includes("completed_job_billing_invoice_number_different_client")) {
        return json({ error: "That invoice number is already used by a different client in this workspace." }, 409);
      }
      // Any other 23505 = unique_violation (e.g. the untouched
      // appointment_id UNIQUE, in a genuine race) -- defensive backstop,
      // translated into a clear message rather than a raw database error.
      if (code === "23505") {
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
