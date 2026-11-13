export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { normalizeDraftFields, type InvoiceRpcOutcome, errorMessage } from "@/lib/invoices";
import { loadBillingState, loadInvoiceView } from "@/lib/invoiceServer";

type Params = { params: Promise<{ id: string }> };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

type OwnerContext = { ok: false; deny: NextResponse } | { ok: true; workspaceId: string; isTester: boolean };

async function ownerContext(capabilityName: "canViewExistingData" | "canMutateOperationalData"): Promise<OwnerContext> {
  const session = await getSession();
  const deny = requireOwner(session);
  if (deny) return { ok: false, deny };
  assertWorkspace(session);
  const capability = await requireCapability(session, capabilityName);
  if (!capability.allowed) return { ok: false, deny: capability.response };
  return { ok: true, workspaceId: session.workspaceId, isTester: session.role === "tester" };
}

// GET /api/invoices/[id] -- the invoice (never its PDF bytes) plus the job's
// Billing paid status, which lives in Billing, not on the invoice.
export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await ownerContext("canViewExistingData");
    if (!ctx.ok) return ctx.deny;
    const { id } = await params;
    const invoice = await loadInvoiceView(ctx.workspaceId, id, ctx.isTester);
    if (!invoice) return json({ error: "Invoice not found" }, 404);
    const billing = await loadBillingState(ctx.workspaceId, invoice.appointment_id);
    return json({ invoice, billing: billing ? { paid: billing.paid, payment_method: billing.payment_method } : { paid: false, payment_method: null } });
  } catch (e: unknown) {
    console.error("INVOICE_GET_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}

// PATCH /api/invoices/[id]
// Body: { revision, fields } -- saves the owner's edits to a DRAFT (a full
// replacement of its printed content). revision is the one the owner was
// editing; if the draft changed since (another tab), nothing is saved and
// the current draft comes back for review.
export async function PATCH(req: Request, { params }: Params) {
  try {
    const ctx = await ownerContext("canMutateOperationalData");
    if (!ctx.ok) return ctx.deny;
    const { id } = await params;
    const invoice = await loadInvoiceView(ctx.workspaceId, id, ctx.isTester);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const body = await req.json().catch(() => null);
    if (!Number.isInteger(body?.revision)) return json({ error: "Missing revision" }, 400);
    const validation = normalizeDraftFields(body?.fields);
    if (!validation.ok) return json({ error: validation.error }, 400);

    const { data, error } = await supabaseAdmin.rpc("update_invoice_draft", {
      p_workspace_id: ctx.workspaceId,
      p_invoice_id: id,
      p_expected_revision: body.revision,
      p_draft: validation.fields,
    });
    if (error) throw error;
    const out = (data ?? {}) as InvoiceRpcOutcome;
    const current = await loadInvoiceView(ctx.workspaceId, id, ctx.isTester);
    switch (out.outcome) {
      case "ok":
        return json({ ok: true, invoice: current });
      case "stale_revision":
        return json({ error: "This draft was changed elsewhere. Review the latest version.", code: "DRAFT_CHANGED", invoice: current }, 409);
      case "not_draft":
        return json({ error: "This invoice was already issued and can no longer be edited.", code: "NOT_DRAFT", invoice: current }, 409);
      case "not_found":
        return json({ error: "Invoice not found" }, 404);
      default:
        return json({ error: "Invalid invoice details" }, 400);
    }
  } catch (e: unknown) {
    console.error("INVOICE_UPDATE_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}

// DELETE /api/invoices/[id] -- discards a DRAFT (it never had a number).
export async function DELETE(_req: Request, { params }: Params) {
  try {
    const ctx = await ownerContext("canMutateOperationalData");
    if (!ctx.ok) return ctx.deny;
    const { id } = await params;
    const invoice = await loadInvoiceView(ctx.workspaceId, id, ctx.isTester);
    if (!invoice) return json({ error: "Invoice not found" }, 404);
    const { data, error } = await supabaseAdmin.rpc("discard_invoice_draft", { p_workspace_id: ctx.workspaceId, p_invoice_id: id });
    if (error) throw error;
    const out = (data ?? {}) as InvoiceRpcOutcome;
    if (out.outcome === "ok") return json({ ok: true });
    if (out.outcome === "not_draft") return json({ error: "An issued invoice can't be discarded. Void it instead.", code: "NOT_DRAFT" }, 409);
    return json({ error: "Invoice not found" }, 404);
  } catch (e: unknown) {
    console.error("INVOICE_DISCARD_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
