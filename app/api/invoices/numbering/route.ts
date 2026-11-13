export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { parseStartingNumber, errorMessage, type InvoiceNumberingState } from "@/lib/invoices";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

async function ownerWorkspace(capabilityName: "canViewExistingData" | "canMutateOperationalData") {
  const session = await getSession();
  const deny = requireOwner(session);
  if (deny) return { ok: false as const, deny };
  assertWorkspace(session);
  const capability = await requireCapability(session, capabilityName);
  if (!capability.allowed) return { ok: false as const, deny: capability.response };
  return { ok: true as const, workspaceId: session.workspaceId };
}

// GET /api/invoices/numbering -- Settings -> Billing's "Invoice numbers":
// the series, the next available number, whether the starting number can
// still change, and the highest numeric invoice number recorded in Billing.
export async function GET() {
  try {
    const ctx = await ownerWorkspace("canViewExistingData");
    if (!ctx.ok) return ctx.deny;
    const { data, error } = await supabaseAdmin.rpc("invoice_numbering_state", { p_workspace_id: ctx.workspaceId });
    if (error) throw error;
    return json({ numbering: data as InvoiceNumberingState });
  } catch (e: unknown) {
    console.error("INVOICE_NUMBERING_GET_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}

// PUT /api/invoices/numbering
// Body: { starting_number: "13485" | 13485 | null } -- null/blank = the
// default SFT-1001 series. Owner only; refused once the first invoice was
// issued, and for a start at or below the highest number in Billing.
export async function PUT(req: Request) {
  try {
    const ctx = await ownerWorkspace("canMutateOperationalData");
    if (!ctx.ok) return ctx.deny;
    const body = await req.json().catch(() => null);
    const parsed = parseStartingNumber(body?.starting_number);
    if (!parsed.ok) return json({ error: parsed.error, code: "INVALID_STARTING_NUMBER" }, 400);

    const { data, error } = await supabaseAdmin.rpc("set_invoice_starting_number", {
      p_workspace_id: ctx.workspaceId,
      p_starting_number: parsed.value,
    });
    if (error) throw error;
    const out = data as { outcome: string; state: InvoiceNumberingState };
    if (out.outcome === "ok") return json({ ok: true, numbering: out.state });
    if (out.outcome === "locked") {
      return json({
        error: "Invoice numbers are set once the first invoice is issued, so the starting number can no longer change.",
        code: "NUMBERING_LOCKED", numbering: out.state,
      }, 409);
    }
    if (out.outcome === "at_or_below_recorded") {
      const h = out.state.highest_recorded;
      return json({
        error: `Choose a number above ${h?.number ?? "the highest invoice number"}${h?.client_name ? ` (${h.client_name})` : ""}, the highest invoice number recorded in Billing.`,
        code: "STARTING_NUMBER_TOO_LOW", numbering: out.state,
      }, 409);
    }
    return json({ error: "Enter a whole number, like 13485.", code: "INVALID_STARTING_NUMBER", numbering: out.state }, 400);
  } catch (e: unknown) {
    console.error("INVOICE_NUMBERING_PUT_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
