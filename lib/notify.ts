import twilio from "twilio";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

let resendClient: Resend | null = null;
function getResend(): Resend {
  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY!);
  }
  return resendClient;
}

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const disabled = process.env.DISABLE_MESSAGES === "true";

// The owner's Settings → Automation → "Enable Client Notifications" master
// switch. This is the single choke point every route's send goes through
// (create/update/cancel/public-cancel/reminders all call sendEmail/sendSms
// and nothing else), so gating it here — rather than in each route — makes
// it impossible for a route to forget the check or bypass it. Read fresh on
// every call rather than cached: sends are low-frequency (appointment
// actions), so an extra read is cheap, and it avoids any staleness window
// after the owner flips the toggle.
//
// Workspace-scoped as of Phase 2 tenant scoping — every caller must know
// which workspace the notification belongs to (the appointment/client's
// own workspace_id, never a single global row) so one workspace's
// notification setting can never affect another's.
async function ownerNotificationsEnabled(workspaceId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("company_settings")
    .select("notifications_enabled")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return Boolean(data?.notifications_enabled);
}

export type NotifyChannel = "email" | "sms" | "both" | "none";

export function shouldSend(channel: NotifyChannel | undefined, medium: "email" | "sms"): boolean {
  if (!channel || channel === "none") return false;
  if (channel === "both") return true;
  return channel === medium;
}

// Node's console.error truncates nested objects (e.g. logs "response: [Object]"
// instead of the actual SendGrid/Twilio response body that explains *why* a
// send failed) — this serializes the full error, including any own
// enumerable properties providers attach (SendGrid's ResponseError has
// .code/.response; Twilio's RestException has .status/.code/.moreInfo), so
// the real reason is visible in logs instead of a placeholder.
export function describeProviderError(err: unknown): string {
  if (err instanceof Error) {
    const plain: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(err)) {
      plain[key] = (err as unknown as Record<string, unknown>)[key];
    }
    try {
      return JSON.stringify(plain, null, 2);
    } catch {
      return err.message;
    }
  }
  try {
    return JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

export type MessageSentRow = {
  appointment_id: string | null;
  channel: "email" | "sms";
  kind: string;
  workspace_id: string;
  to_value: string;
  body: string;
  provider_id: string;
};

// Writes the audit-trail row for a notification attempt (success or failed).
// This insert is diagnostic only — its failure must never throw or fail the
// appointment operation/notification flow it's recording, so the error is
// only logged. Logged under a distinct tag (MESSAGES_SENT_INSERT_ERROR) from
// provider send failures (NOTIFY_EMAIL_ERROR / NOTIFY_SMS_ERROR) so the two
// failure classes stay distinguishable. Never logs to_value/body/provider
// credentials — only the non-sensitive routing fields.
export async function recordMessageSent(row: MessageSentRow): Promise<void> {
  const { error } = await supabaseAdmin.from("messages_sent").insert(row);
  if (error) {
    console.error("MESSAGES_SENT_INSERT_ERROR", {
      channel: row.channel,
      kind: row.kind,
      appointment_id: row.appointment_id,
      workspace_id: row.workspace_id,
      error: error.message,
    });
  }
}

export async function sendSms(to: string, body: string, workspaceId: string) {
  if (disabled) {
    console.log("[DISABLE_MESSAGES] SMS skipped — to:", to, "| body:", body);
    return "disabled";
  }
  if (!(await ownerNotificationsEnabled(workspaceId))) {
    console.log("[notifications_enabled=false] SMS skipped — to:", to, "| body:", body, "| workspace:", workspaceId);
    return "notifications-off";
  }
  const msg = await twilioClient.messages.create({
    to,
    from: process.env.TWILIO_FROM_NUMBER!,
    body,
  });
  return msg.sid;
}

export async function sendEmail(to: string, subject: string, text: string, workspaceId: string) {
  if (disabled) {
    console.log("[DISABLE_MESSAGES] Email skipped — to:", to, "| subject:", subject, "| body:", text);
    return "disabled";
  }
  if (!(await ownerNotificationsEnabled(workspaceId))) {
    console.log("[notifications_enabled=false] Email skipped — to:", to, "| subject:", subject, "| workspace:", workspaceId);
    return "notifications-off";
  }
  const fromName = process.env.RESEND_FROM_NAME || "FlowTrack Schedule";
  const { data, error } = await getResend().emails.send({
    from: `${fromName} <${process.env.RESEND_FROM_EMAIL}>`,
    to,
    subject,
    text,
  });
  // Resend's SDK returns { data, error } instead of throwing on API-level
  // rejections — throw here so the existing try/catch + describeProviderError
  // handling in the route files (unchanged) still catches this the same way
  // it caught SendGrid failures.
  if (error) {
    throw Object.assign(new Error(error.message), error);
  }
  return data?.id || "resend";
}
