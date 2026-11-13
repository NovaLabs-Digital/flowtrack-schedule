// Issuing an SFT invoice (migration 049): render the PDF from the database's
// canonical render input, then hand number + PDF + snapshot to
// issue_invoice, which commits them with the Billing update in one
// transaction -- or refuses and writes nothing.
//
//  * The number moved while rendering (another invoice was issued first):
//    re-render with the new number and try again, automatically.
//  * The draft changed (a newer revision than the one the owner reviewed):
//    stop. The route returns the updated draft for the owner to review
//    before issuing -- never issue content the owner has not seen.
//
// Dependencies are injected so this is unit-testable without a database
// (lib/invoiceIssue.test.ts); the real database behavior is proven in
// test-db/invoices_routes.test.ts.
import { createHash } from "node:crypto";
import type { InvoiceRenderSnapshot } from "@/lib/invoicePdf";
import type { InvoiceRpcOutcome } from "@/lib/invoices";

type RpcResult = { data: unknown; error: { message?: string; code?: string } | null };
export type IssueDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  render: (snapshot: InvoiceRenderSnapshot) => Promise<Uint8Array>;
};

export type IssueResult =
  | { kind: "issued" | "already_issued"; invoiceNumber: string }
  | { kind: "draft_changed"; revision: number }
  | { kind: "not_draft"; status: string; invoiceNumber: string | null }
  | { kind: "refused"; outcome: "not_found" | "invoice_void" | "job_has_invoice_number" | "job_paid_directly"; invoiceNumber?: string | null }
  | { kind: "busy" };

export const MAX_ISSUE_ATTEMPTS = 5;

async function call(deps: IssueDeps, fn: string, args: Record<string, unknown>): Promise<InvoiceRpcOutcome> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message ?? "unknown error"}`);
  return (data ?? {}) as InvoiceRpcOutcome;
}

export async function issueInvoiceWithRetry(
  deps: IssueDeps,
  workspaceId: string,
  invoiceId: string,
  reviewedRevision: number,
  maxAttempts = MAX_ISSUE_ATTEMPTS
): Promise<IssueResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const input = await call(deps, "invoice_render_input", { p_workspace_id: workspaceId, p_invoice_id: invoiceId });
    if (input.outcome === "not_found") return { kind: "refused", outcome: "not_found" };
    if (input.outcome === "not_draft") {
      // Issued by an earlier click/retry: that stored invoice is the result.
      if (input.status === "issued") return { kind: "already_issued", invoiceNumber: input.invoice_number ?? "" };
      return { kind: "not_draft", status: input.status ?? "", invoiceNumber: input.invoice_number ?? null };
    }
    if (input.revision !== reviewedRevision) return { kind: "draft_changed", revision: input.revision ?? 0 };

    const snapshot = input.render_snapshot as InvoiceRenderSnapshot;
    const pdf = Buffer.from(await deps.render(snapshot));
    const out = await call(deps, "issue_invoice", {
      p_workspace_id: workspaceId,
      p_invoice_id: invoiceId,
      p_revision: input.revision,
      p_invoice_number: input.invoice_number,
      p_render_snapshot: snapshot,
      p_pdf_base64: pdf.toString("base64"),
      p_pdf_sha256: createHash("sha256").update(pdf).digest("hex"),
    });

    switch (out.outcome) {
      case "issued":
      case "already_issued":
        return { kind: out.outcome, invoiceNumber: out.invoice_number ?? "" };
      case "number_changed":
      case "snapshot_mismatch":
        continue; // re-read the render input (new number) and render again
      case "stale_revision":
        return { kind: "draft_changed", revision: out.revision ?? 0 };
      case "not_found":
      case "invoice_void":
      case "job_has_invoice_number":
      case "job_paid_directly":
        return { kind: "refused", outcome: out.outcome, invoiceNumber: out.invoice_number ?? null };
      case "pdf_invalid":
        throw new Error("issue_invoice refused the rendered PDF (pdf_invalid)");
      default:
        throw new Error(`issue_invoice returned an unexpected outcome: ${String(out.outcome)}`);
    }
  }
  return { kind: "busy" };
}
