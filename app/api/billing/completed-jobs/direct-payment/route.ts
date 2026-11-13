export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { type InvoiceRpcOutcome, errorMessage } from "@/lib/invoices";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { isValidPaymentMethod } from "@/lib/completedJobBilling";
import { isBillableJob, loadOwnedAppointment } from "@/lib/invoiceServer";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// POST /api/billing/completed-jobs/direct-payment
// Body: { appointment_id, no_invoice_required: true, payment_method }  -- "Paid directly, no invoice"
//       { appointment_id, no_invoice_required: false }                  -- undo (an invoice is needed again)
//
// An explicit per-job decision (migration 049's set_no_invoice_required),
// with any supported payment method. Confirming it marks the job paid with
// that method and clears its Needs Attention billing issue; undo keeps paid /
// payment method as they are, so the job shows "Needs invoice number" again.
export async function POST(req: Request) {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;
    const isTester = session.role === "tester";

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const body = await req.json().catch(() => null);
    const appointmentId = typeof body?.appointment_id === "string" ? body.appointment_id.trim() : "";
    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
    if (typeof body?.no_invoice_required !== "boolean") return json({ error: "no_invoice_required must be true or false" }, 400);
    const confirm = body.no_invoice_required as boolean;
    if (confirm && !isValidPaymentMethod(body.payment_method)) return json({ error: "Choose how the client paid." }, 400);

    const appt = await loadOwnedAppointment(workspaceId, appointmentId, isTester);
    if (!appt) return json({ error: "Appointment not found" }, 404);
    if (confirm && !(await isBillableJob(appt, workspaceId))) {
      return json({ error: "This appointment is not marked completed yet.", code: "JOB_NOT_COMPLETED" }, 409);
    }

    const { data, error } = await supabaseAdmin.rpc("set_no_invoice_required", {
      p_workspace_id: workspaceId,
      p_appointment_id: appt.id,
      p_no_invoice_required: confirm,
      p_payment_method: confirm ? body.payment_method : null,
    });
    if (error) throw error;
    const out = (data ?? {}) as InvoiceRpcOutcome;
    switch (out.outcome) {
      case "ok":
        return json({ ok: true, billing: out.billing ?? null });
      case "job_has_invoice":
        return json({ error: "This job has an invoice in Schedule. Void or discard it first.", code: "JOB_HAS_INVOICE" }, 409);
      case "job_has_invoice_number":
        return json({ error: `This job already has invoice ${out.invoice_number}.`, code: "JOB_HAS_INVOICE_NUMBER" }, 409);
      case "invalid_payment_method":
        return json({ error: "Choose how the client paid." }, 400);
      default:
        return json({ error: "Appointment not found" }, 404);
    }
  } catch (e: unknown) {
    console.error("BILLING_DIRECT_PAYMENT_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
