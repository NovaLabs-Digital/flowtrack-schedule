export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { type InvoiceRpcOutcome, errorMessage } from "@/lib/invoices";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { loadInvoiceView } from "@/lib/invoiceServer";

type Params = { params: Promise<{ id: string }> };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// POST /api/invoices/[id]/void
// Body: { reason }
//
// Voids an ISSUED invoice: the record and its PDF are kept, its number is
// retired forever, and Billing's invoice number for the job is cleared (one
// transaction, void_invoice). A paid invoice must be marked unpaid in
// Billing first. Corrections are made by reissuing (POST /api/invoices with
// reissue_from_invoice_id).
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
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return json({ error: "Enter a reason for voiding this invoice." }, 400);
    if (reason.length > 500) return json({ error: "Reason is too long" }, 400);

    if (!(await loadInvoiceView(workspaceId, id, isTester))) return json({ error: "Invoice not found" }, 404);

    const { data, error } = await supabaseAdmin.rpc("void_invoice", { p_workspace_id: workspaceId, p_invoice_id: id, p_reason: reason });
    if (error) throw error;
    const out = (data ?? {}) as InvoiceRpcOutcome;
    const current = await loadInvoiceView(workspaceId, id, isTester);
    switch (out.outcome) {
      case "ok":
        return json({ ok: true, invoice: current });
      case "invoice_paid":
        return json({ error: "This invoice is marked paid. Mark it unpaid in Billing before voiding it.", code: "INVOICE_PAID" }, 409);
      case "not_issued":
        return json({ error: current?.status === "void" ? "This invoice is already void." : "Only an issued invoice can be voided.", code: "NOT_ISSUED", invoice: current }, 409);
      case "reason_required":
        return json({ error: "Enter a reason for voiding this invoice." }, 400);
      default:
        return json({ error: "Invoice not found" }, 404);
    }
  } catch (e: unknown) {
    console.error("INVOICE_VOID_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
