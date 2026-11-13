export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/invoices";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { renderInvoicePdf } from "@/lib/invoicePdf";
import { issueInvoiceWithRetry } from "@/lib/invoiceIssue";
import { isBillableJob, loadInvoiceView, loadOwnedAppointment } from "@/lib/invoiceServer";

type Params = { params: Promise<{ id: string }> };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// POST /api/invoices/[id]/issue
// Body: { revision } -- the draft revision the owner reviewed.
//
// Assigns the next SFT number, stores the PDF and writes the number to
// Billing, all in one database transaction (issue_invoice, migration 049).
//  * If another invoice took the proposed number while this PDF was being
//    rendered, it re-renders with the new number and retries automatically.
//  * If the draft changed after the owner reviewed it, nothing is issued and
//    the updated draft comes back (409 DRAFT_CHANGED) for the owner to review.
//  * A repeated click returns the invoice already issued.
export async function POST(req: Request, { params }: Params) {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;
    const isTester = session.role === "tester";

    const capability = await requireCapability(session, "canMutateOperationalData");
    if (!capability.allowed) return capability.response;

    const { id } = await params;
    const body = await req.json().catch(() => null);
    if (!Number.isInteger(body?.revision)) return json({ error: "Missing revision" }, 400);

    const invoice = await loadInvoiceView(workspaceId, id, isTester);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    if (invoice.status === "draft") {
      const appt = await loadOwnedAppointment(workspaceId, invoice.appointment_id, isTester);
      if (!appt || !(await isBillableJob(appt, workspaceId))) {
        return json({ error: "This appointment is no longer a completed job.", code: "JOB_NOT_COMPLETED" }, 409);
      }
    }

    const result = await issueInvoiceWithRetry(
      { rpc: (fn, args) => supabaseAdmin.rpc(fn, args), render: renderInvoicePdf },
      workspaceId,
      id,
      body.revision
    );
    const current = await loadInvoiceView(workspaceId, id, isTester);

    switch (result.kind) {
      case "issued":
        return json({ ok: true, invoice: current }, 201);
      case "already_issued":
        return json({ ok: true, alreadyIssued: true, invoice: current });
      case "draft_changed":
        return json({ error: "This draft was changed. Review the updated draft before issuing.", code: "DRAFT_CHANGED", invoice: current }, 409);
      case "not_draft":
        return json({ error: "This invoice was voided.", code: "NOT_DRAFT", invoice: current }, 409);
      case "busy":
        return json({ error: "Several invoices are being issued right now. Please try again.", code: "TRY_AGAIN" }, 503);
      case "refused":
        switch (result.outcome) {
          case "job_has_invoice_number":
            return json({ error: `This job already has invoice ${result.invoiceNumber}.`, code: "JOB_HAS_INVOICE_NUMBER" }, 409);
          case "job_paid_directly":
            return json({ error: "This job is marked paid directly with no invoice needed.", code: "JOB_PAID_DIRECTLY" }, 409);
          case "invoice_void":
            return json({ error: "This invoice was voided.", code: "NOT_DRAFT", invoice: current }, 409);
          default:
            return json({ error: "Invoice not found" }, 404);
        }
    }
  } catch (e: unknown) {
    console.error("INVOICE_ISSUE_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
