export const runtime = "nodejs";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession, requireOwner, assertWorkspace } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireCapability } from "@/lib/entitlementServer";
import { invoicePdfFileName, errorMessage } from "@/lib/invoices";
import { UUID_RE, byteaToBuffer, loadInvoiceView } from "@/lib/invoiceServer";
import { buildInvoiceEmailPrefill, toSendAttempt, validateInvoiceEmail, SEND_STATE_LABEL, type InvoiceSendState } from "@/lib/invoiceEmail";
import { sendInvoiceEmail } from "@/lib/notify";

type Params = { params: Promise<{ id: string }> };

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

async function ownerContext(capabilityName: "canViewExistingData" | "canMutateOperationalData") {
  const session = await getSession();
  const deny = requireOwner(session);
  if (deny) return { ok: false as const, deny };
  assertWorkspace(session);
  const capability = await requireCapability(session, capabilityName);
  if (!capability.allowed) return { ok: false as const, deny: capability.response };
  return { ok: true as const, workspaceId: session.workspaceId, isTester: session.role === "tester" };
}

async function loadAttempts(workspaceId: string, invoiceId: string) {
  const { data, error } = await supabaseAdmin
    .from("messages_sent")
    .select("id, provider_id, to_value, subject, created_at")
    .eq("workspace_id", workspaceId)
    .eq("invoice_id", invoiceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(20);
  if (error) throw error;
  const now = Date.now();
  return ((data ?? []) as { id: string; provider_id: string | null; to_value: string; subject: string | null; created_at: string }[])
    .map((r) => toSendAttempt(r, now));
}

async function loadPdf(workspaceId: string, invoiceId: string): Promise<Buffer | null> {
  const { data, error } = await supabaseAdmin.from("invoices").select("pdf").eq("id", invoiceId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  return byteaToBuffer((data as { pdf?: unknown } | null)?.pdf);
}

// GET /api/invoices/[id]/send -- what Review & Send shows: the prefilled
// recipient (the client's email), subject and message, the attachment (the
// invoice's stored PDF), and earlier send attempts.
export async function GET(_req: Request, { params }: Params) {
  try {
    const ctx = await ownerContext("canViewExistingData");
    if (!ctx.ok) return ctx.deny;
    const { id } = await params;
    const invoice = await loadInvoiceView(ctx.workspaceId, id, ctx.isTester);
    if (!invoice) return json({ error: "Invoice not found" }, 404);
    const attempts = await loadAttempts(ctx.workspaceId, invoice.id);
    if (invoice.status !== "issued" || !invoice.invoice_number) {
      return json({ invoice_number: invoice.invoice_number, sendable: false, status: invoice.status, attempts });
    }
    const [{ data: client, error: clientError }, pdf] = await Promise.all([
      supabaseAdmin.from("clients").select("email").eq("id", invoice.client_id).eq("workspace_id", ctx.workspaceId).maybeSingle(),
      loadPdf(ctx.workspaceId, invoice.id),
    ]);
    if (clientError) throw clientError;
    return json({
      invoice_number: invoice.invoice_number,
      sendable: true,
      status: invoice.status,
      prefill: buildInvoiceEmailPrefill(invoice, (client as { email?: string | null } | null)?.email ?? null),
      attachment: { file_name: invoicePdfFileName(invoice.invoice_number), bytes: pdf?.length ?? 0 },
      attempts,
    });
  } catch (e: unknown) {
    console.error("INVOICE_SEND_GET_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}

type Claim = {
  outcome: string; attempt_id?: string; state?: InvoiceSendState; provider_id?: string | null;
  to?: string; created_at?: string; status?: string; field?: string; invoice_number?: string; pdf_sha256?: string;
};

function attemptOf(c: Claim, subject: string | null = null) {
  const state = (c.state ?? "uncertain") as InvoiceSendState;
  return { id: c.attempt_id, state, label: SEND_STATE_LABEL[state], to: c.to ?? null, subject, created_at: c.created_at ?? null };
}

// POST /api/invoices/[id]/send
// Body: { request_id, to, subject, message, acknowledged_attempt_id? }
// Sends ONE issued invoice by email with its stored PDF attached, after the
// owner reviewed the recipient and invoice number. request_id makes a
// double-click or retry return the same attempt instead of a second email.
// When an earlier attempt went out or has an unknown outcome, the owner must
// acknowledge that attempt (by id) to send again.
export async function POST(req: Request, { params }: Params) {
  try {
    const ctx = await ownerContext("canMutateOperationalData");
    if (!ctx.ok) return ctx.deny;
    const { id } = await params;
    const invoice = await loadInvoiceView(ctx.workspaceId, id, ctx.isTester);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const body = await req.json().catch(() => null);
    const requestId = typeof body?.request_id === "string" ? body.request_id : "";
    if (!UUID_RE.test(requestId)) return json({ error: "Missing request id", code: "INVALID_REQUEST" }, 400);
    const ack = typeof body?.acknowledged_attempt_id === "string" && UUID_RE.test(body.acknowledged_attempt_id) ? body.acknowledged_attempt_id : null;
    const fields = validateInvoiceEmail(body);
    if (!fields.ok) return json({ error: fields.error, code: "INVALID_FIELD", field: fields.field }, 400);

    const { data, error } = await supabaseAdmin.rpc("claim_invoice_send", {
      p_workspace_id: ctx.workspaceId,
      p_invoice_id: invoice.id,
      p_request_id: requestId,
      p_to: fields.value.to,
      p_subject: fields.value.subject,
      p_body: fields.value.message,
      p_acknowledged_attempt_id: ack,
    });
    if (error) throw error;
    const claim = data as Claim;
    switch (claim.outcome) {
      case "replay":
        return json({ ok: true, replayed: true, attempt: attemptOf(claim, fields.value.subject) });
      case "not_found":
        return json({ error: "Invoice not found" }, 404);
      case "not_issued":
        return json({ error: "Only an issued invoice can be sent. Drafts and voided invoices can't be emailed.", code: "NOT_ISSUED" }, 409);
      case "in_progress":
        return json({ error: "This invoice is being sent right now. Wait a moment, then check the result.", code: "SEND_IN_PROGRESS", attempt: attemptOf({ ...claim, state: "sending" }) }, 409);
      case "needs_acknowledgement":
        return json({
          error: claim.state === "sent"
            ? "This invoice was already sent. Confirm to send it again."
            : "The last attempt to send this invoice has an unknown outcome -- the client may already have it. Confirm to send it again.",
          code: "PREVIOUS_ATTEMPT", attempt: attemptOf(claim),
        }, 409);
      case "request_conflict":
        return json({ error: "That request was already used for a different invoice.", code: "INVALID_REQUEST" }, 400);
      case "invalid":
        return json({ error: "Check the email details and try again.", code: "INVALID_FIELD", field: claim.field }, 400);
      case "claimed":
        break;
      default:
        throw new Error(`Unexpected send outcome: ${claim.outcome}`);
    }

    // The exact PDF stored for this invoice -- byte for byte, checked
    // against the fingerprint saved when it was issued.
    const pdf = await loadPdf(ctx.workspaceId, invoice.id);
    const pdfOk = !!pdf && createHash("sha256").update(pdf).digest("hex") === claim.pdf_sha256;
    const result = pdfOk
      ? await sendInvoiceEmail({
          to: fields.value.to,
          subject: fields.value.subject,
          text: fields.value.message,
          fromDisplayName: invoice.business_name,
          replyTo: invoice.business_email,
          attachment: { filename: invoicePdfFileName(claim.invoice_number ?? invoice.invoice_number ?? "invoice"), content: pdf! },
          idempotencyKey: requestId,
        })
      : ({ outcome: "failed", reason: "the stored invoice PDF could not be read" } as const);
    const providerId = result.outcome === "accepted" ? result.providerId
      : result.outcome === "failed" ? "failed"
      : result.outcome === "disabled" ? "disabled"
      : "unconfirmed";
    const finish = await supabaseAdmin.rpc("finish_invoice_send", { p_workspace_id: ctx.workspaceId, p_attempt_id: claim.attempt_id, p_provider_id: providerId });
    if (finish.error) console.error("INVOICE_SEND_FINISH_ERROR", { attempt: claim.attempt_id, error: finish.error.message });
    const state: InvoiceSendState = result.outcome === "accepted" ? "sent" : result.outcome === "failed" ? "failed" : result.outcome === "disabled" ? "disabled" : "uncertain";
    return json({
      ok: true,
      attempt: { id: claim.attempt_id, state, label: SEND_STATE_LABEL[state], to: fields.value.to, subject: fields.value.subject, created_at: claim.created_at ?? null },
      ...(result.outcome === "failed" || result.outcome === "uncertain" ? { reason: result.reason } : {}),
    }, 201);
  } catch (e: unknown) {
    console.error("INVOICE_SEND_ERROR", e);
    return json({ error: errorMessage(e) }, 500);
  }
}
