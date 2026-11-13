"use client";

// Review & Send (migration 050): email ONE issued invoice to the client with
// the PDF stored when it was issued. Compose (prefilled, editable) -> Review
// (recipient + invoice number, confirm) -> result. Issuing never sends; only
// this confirm does. A double-click or a retry after a lost connection reuses
// the same request id, so it can never send twice. An earlier send that went
// out, or whose outcome is unknown, is shown before another send is allowed.
import { useCallback, useEffect, useRef, useState } from "react";
import { validateInvoiceEmail, type InvoiceEmailFields, type InvoiceSendAttempt } from "@/lib/invoiceEmail";

type Props = {
  invoiceId: string;
  invoiceNumber: string;
  onClose: () => void;
  onSent: () => void;
};

type Loaded = {
  sendable: boolean;
  prefill?: InvoiceEmailFields;
  attachment?: { file_name: string; bytes: number };
  attempts: InvoiceSendAttempt[];
};

type Result = { attempt: InvoiceSendAttempt; reason?: string };

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50";
const labelCls = "block text-[11px] font-medium text-slate-500 mb-0.5";

const STATE_BOX: Record<string, string> = {
  sent: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  uncertain: "border-amber-200 bg-amber-50 text-amber-800",
  sending: "border-amber-200 bg-amber-50 text-amber-800",
  disabled: "border-slate-200 bg-white text-slate-700",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit", hour: "numeric", minute: "2-digit" });
}
function kb(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

export default function InvoiceSendPanel({ invoiceId, invoiceNumber, onClose, onSent }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState("");
  const [fields, setFields] = useState<InvoiceEmailFields>({ to: "", subject: "", message: "" });
  const [step, setStep] = useState<"compose" | "review" | "result">("compose");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [lostConnection, setLostConnection] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // The attempt the owner must see (and acknowledge) before sending again.
  const [openAttempt, setOpenAttempt] = useState<InvoiceSendAttempt | null>(null);
  const requestId = useRef<string>("");
  const inFlight = useRef(false);

  const load = useCallback(async (keepFields: boolean) => {
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Could not load the email (${res.status})`);
      const data = body as Loaded;
      setLoaded(data);
      if (!keepFields && data.prefill) setFields(data.prefill);
      setOpenAttempt(data.attempts.find((a) => a.state === "sent" || a.state === "uncertain" || a.state === "sending") ?? null);
      setLoadError("");
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [invoiceId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  function review() {
    const v = validateInvoiceEmail(fields);
    if (!v.ok) return setError(v.error);
    setFields(v.value);
    setError("");
    // One request id per confirmed send: a double-click or a retry after a
    // lost connection reuses it; a later, separate send gets a new one.
    requestId.current = crypto.randomUUID();
    setLostConnection(false);
    setStep("review");
  }

  async function send() {
    if (inFlight.current) return; // a second click while the first is in flight
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId.current, ...fields, acknowledged_attempt_id: openAttempt?.state === "sending" ? null : openAttempt?.id ?? null }),
      });
      const body = await res.json().catch(() => ({}));
      setLostConnection(false);
      if (res.ok) {
        setResult({ attempt: body.attempt as InvoiceSendAttempt, reason: body.reason });
        setStep("result");
        onSent();
        await load(true);
        return;
      }
      if (body?.code === "PREVIOUS_ATTEMPT" || body?.code === "SEND_IN_PROGRESS") {
        // Something changed since this screen loaded: show it before sending.
        setOpenAttempt(body.attempt as InvoiceSendAttempt);
        requestId.current = crypto.randomUUID();
        setError(body.error);
        return;
      }
      setError(body?.error || "Could not send the invoice. Please try again.");
    } catch {
      // No answer from our server: the email may or may not have been sent.
      // "Check status" repeats the SAME request, which can never send twice.
      setLostConnection(true);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function sendAnother() {
    setResult(null);
    setError("");
    setStep("compose");
  }

  if (loadError) return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{loadError}</div>;
  if (!loaded) return <div className="text-xs text-slate-400">Loading...</div>;
  if (!loaded.sendable) {
    return <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">Only an issued invoice can be sent. Drafts and voided invoices can&apos;t be emailed.</div>;
  }

  const lastAttempts = loaded.attempts.slice(0, 3);
  const ackKind = openAttempt?.state;

  return (
    <section aria-label="Review & Send" className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3" data-testid="invoice-send-panel">
      {lastAttempts.length > 0 && step !== "result" && (
        <div className="space-y-1" data-testid="invoice-send-history">
          <div className="text-[11px] font-medium text-slate-500">Earlier emails for this invoice</div>
          {lastAttempts.map((a) => (
            <div key={a.id} className="text-[11px] text-slate-600">
              <span className="font-medium text-slate-800">{a.label}</span> &middot; {when(a.created_at)} &middot; to {a.to}
            </div>
          ))}
        </div>
      )}

      {step === "compose" && (
        <div className="space-y-2">
          <div>
            <label className={labelCls} htmlFor="inv-send-to">To</label>
            <input id="inv-send-to" type="email" className={inputCls} value={fields.to} onChange={(e) => setFields({ ...fields, to: e.target.value })} placeholder="client@example.com" />
          </div>
          <div>
            <label className={labelCls} htmlFor="inv-send-subject">Subject</label>
            <input id="inv-send-subject" className={inputCls} value={fields.subject} onChange={(e) => setFields({ ...fields, subject: e.target.value })} />
          </div>
          <div>
            <label className={labelCls} htmlFor="inv-send-message">Message</label>
            <textarea id="inv-send-message" rows={8} className={inputCls} value={fields.message} onChange={(e) => setFields({ ...fields, message: e.target.value })} />
          </div>
          {loaded.attachment && (
            <p className="text-[11px] text-slate-600" data-testid="invoice-send-attachment">
              Attachment: <span className="font-medium text-slate-800">{loaded.attachment.file_name}</span> ({kb(loaded.attachment.bytes)}), the PDF saved when this invoice was issued.
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={review} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">Review</button>
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">Cancel</button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-2" data-testid="invoice-send-review">
          <p className="text-sm text-slate-900">
            Send invoice <span className="font-semibold">{invoiceNumber}</span> to <span className="font-semibold">{fields.to}</span>?
          </p>
          <p className="text-[11px] text-slate-600">Subject: {fields.subject}</p>
          {loaded.attachment && <p className="text-[11px] text-slate-600">Attachment: {loaded.attachment.file_name}</p>}
          {ackKind === "sent" && openAttempt && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="invoice-send-warning">
              This invoice was already sent on {when(openAttempt.created_at)} to {openAttempt.to}. Sending again emails another copy.
            </div>
          )}
          {ackKind === "uncertain" && openAttempt && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="invoice-send-warning">
              The attempt on {when(openAttempt.created_at)} to {openAttempt.to} has an unknown outcome &mdash; the client may already have this invoice. Send again only if you&apos;re sure.
            </div>
          )}
          {ackKind === "sending" && openAttempt && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="invoice-send-warning">
              A send started {when(openAttempt.created_at)} is still in progress.{" "}
              <button type="button" className="font-medium underline" onClick={() => void load(true)}>Check again</button>
            </div>
          )}
          {lostConnection && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
              We couldn&apos;t reach the server, so the email may or may not have been sent. Check its status before doing anything else &mdash; checking never sends a second copy.
            </div>
          )}
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700" role="alert">{error}</div>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || ackKind === "sending"}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? "Sending..." : lostConnection ? "Check status" : ackKind === "sent" ? "Send again" : ackKind === "uncertain" ? "Send again anyway" : "Send invoice"}
            </button>
            <button type="button" onClick={() => { setStep("compose"); setError(""); }} disabled={sending} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">Back</button>
          </div>
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-2">
          <div className={["rounded-lg border px-3 py-2 text-xs", STATE_BOX[result.attempt.state] ?? STATE_BOX.uncertain].join(" ")} data-testid="invoice-send-result" role="status">
            <span className="font-semibold">{result.attempt.label}</span>
            {result.attempt.state === "sent" && <> &middot; invoice {invoiceNumber} to {result.attempt.to}. The email service accepted it; delivery to the inbox isn&apos;t confirmed.</>}
            {result.attempt.state === "failed" && <> &middot; nothing was sent{result.reason ? ` (${result.reason})` : ""}. You can correct it and try again.</>}
            {result.attempt.state === "uncertain" && <> &middot; {result.reason ? `${result.reason.replace(/\.+$/, "")}. ` : ""}The client may or may not have received it. Check with them before sending again.</>}
            {result.attempt.state === "disabled" && <> &middot; email sending is turned off on this server.</>}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800">Done</button>
            {result.attempt.state === "failed" && (
              <button type="button" onClick={sendAnother} className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100">Try again</button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
