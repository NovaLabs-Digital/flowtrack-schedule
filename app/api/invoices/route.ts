export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { toDateInputValue } from "@/lib/payroll";
import { nowInBusinessTz } from "@/lib/timezone";
import { buildInvoicePrefill, draftFieldsOf, reissueFields, type InvoiceRpcOutcome, errorMessage } from "@/lib/invoices";
import { UUID_RE, isBillableJob, loadCompanySettings, loadInvoiceView, loadOwnedAppointment } from "@/lib/invoiceServer";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// POST /api/invoices
// Body: { appointment_id, request_id, reissue_from_invoice_id? }
//
// "Create Invoice": creates the job's DRAFT invoice, prefilled from the job
// (date, service, price), the client (bill to), Settings -> Company (the
// business), and the workspace's most recent issued invoice (payment
// instructions / note). The owner reviews and edits the draft, then issues
// it. request_id (generated when the owner clicks) makes a double-click or
// retry return the same draft. With reissue_from_invoice_id (a VOID invoice
// of the same job), the new draft copies that invoice's details, dated today.
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
    const requestId = typeof body?.request_id === "string" ? body.request_id.trim() : "";
    const reissueFrom = typeof body?.reissue_from_invoice_id === "string" ? body.reissue_from_invoice_id.trim() : "";
    if (!appointmentId) return json({ error: "Missing appointment_id" }, 400);
    if (!UUID_RE.test(requestId)) return json({ error: "Missing request_id" }, 400);
    if (reissueFrom && !UUID_RE.test(reissueFrom)) return json({ error: "Invalid reissue_from_invoice_id" }, 400);

    const appt = await loadOwnedAppointment(workspaceId, appointmentId, isTester);
    if (!appt) return json({ error: "Appointment not found" }, 404);
    if (!(await isBillableJob(appt, workspaceId))) {
      return json({ error: "This appointment is not marked completed yet.", code: "JOB_NOT_COMPLETED" }, 409);
    }

    const { company, timezone } = await loadCompanySettings(workspaceId);
    const today = toDateInputValue(nowInBusinessTz(timezone));

    let fields;
    if (reissueFrom) {
      const voided = await loadInvoiceView(workspaceId, reissueFrom, isTester);
      if (!voided || voided.status !== "void" || voided.appointment_id !== appt.id) {
        return json({ error: "Only a voided invoice of this job can be reissued." }, 400);
      }
      fields = reissueFields(draftFieldsOf(voided), today);
    } else {
      const { data: client, error: clientError } = await supabaseAdmin
        .from("clients")
        .select("name, address, email")
        .eq("id", appt.client_id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (clientError) throw clientError;
      if (!client) return json({ error: "Client not found" }, 404);

      const { data: previous, error: prevError } = await supabaseAdmin
        .from("invoices")
        .select("payment_instructions, note_to_client")
        .eq("workspace_id", workspaceId)
        .in("status", ["issued", "void"])
        .order("issued_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prevError) throw prevError;

      fields = buildInvoicePrefill({
        appointment: appt,
        client: client as { name: string; address: string | null; email: string | null },
        company,
        previous: (previous as { payment_instructions: string | null; note_to_client: string | null } | null) ?? null,
        today,
        timezone,
      });
    }
    if (!fields.business_name) {
      return json({ error: "Add your business name in Settings → Company before creating an invoice.", code: "BUSINESS_NAME_MISSING" }, 409);
    }

    const { data, error } = await supabaseAdmin.rpc("create_invoice_draft", {
      p_workspace_id: workspaceId,
      p_appointment_id: appt.id,
      p_request_id: requestId,
      p_draft: reissueFrom ? { ...fields, reissued_from_invoice_id: reissueFrom } : fields,
    });
    if (error) throw error;
    const out = (data ?? {}) as InvoiceRpcOutcome;

    switch (out.outcome) {
      case "ok": {
        const invoice = await loadInvoiceView(workspaceId, out.invoice_id ?? "", isTester);
        return json({ ok: true, replayed: !!out.replayed, invoice }, out.replayed ? 200 : 201);
      }
      case "job_has_invoice":
        return json({
          error: out.status === "draft" ? "This job already has a draft invoice." : `This job already has invoice ${out.invoice_number}.`,
          code: "JOB_HAS_INVOICE", invoice_id: out.invoice_id, status: out.status, invoice_number: out.invoice_number ?? null,
        }, 409);
      case "job_has_invoice_number":
        return json({ error: `This job already has invoice ${out.invoice_number}.`, code: "JOB_HAS_INVOICE_NUMBER", invoice_number: out.invoice_number }, 409);
      case "job_paid_directly":
        return json({ error: "This job is marked paid directly with no invoice needed. Undo that first to create an invoice.", code: "JOB_PAID_DIRECTLY" }, 409);
      case "appointment_cancelled":
        return json({ error: "This appointment was cancelled.", code: "JOB_NOT_COMPLETED" }, 409);
      case "invalid_reissue":
        return json({ error: "Only a voided invoice of this job can be reissued." }, 400);
      case "request_id_conflict":
        return json({ error: "Please try again." }, 409);
      case "not_found":
        return json({ error: "Appointment not found" }, 404);
      default:
        return json({ error: "Invalid invoice details" }, 400);
    }
  } catch (e: unknown) {
    console.error("INVOICES_CREATE_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
