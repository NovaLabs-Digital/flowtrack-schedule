export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { invoicePdfFileName, errorMessage } from "@/lib/invoices";
import { byteaToBuffer, loadInvoiceView } from "@/lib/invoiceServer";

type Params = { params: Promise<{ id: string }> };

// GET /api/invoices/[id]/pdf -- downloads the PDF stored when the invoice
// was issued, byte for byte (never re-rendered). Drafts have no PDF.
export async function GET(_req: Request, { params }: Params) {
  try {
    const session = await getSession();
    const deny = requireOwner(session);
    if (deny) return deny;
    assertWorkspace(session);
    const workspaceId = session.workspaceId;

    const capability = await requireCapability(session, "canViewExistingData");
    if (!capability.allowed) return capability.response;

    const { id } = await params;
    const invoice = await loadInvoiceView(workspaceId, id, session.role === "tester");
    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    if (invoice.status === "draft" || !invoice.invoice_number) {
      return NextResponse.json({ error: "This invoice hasn't been issued yet." }, { status: 404 });
    }

    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("pdf")
      .eq("id", id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    const pdf = byteaToBuffer((data as { pdf?: unknown } | null)?.pdf);
    if (!pdf) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoicePdfFileName(invoice.invoice_number)}"`,
        "Content-Length": String(pdf.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e: unknown) {
    console.error("INVOICE_PDF_ERROR", e);
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }
}
