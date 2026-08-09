import twilio from "twilio";
import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { effectiveTimezone } from "@/lib/timezone";

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

// The platform name a client-facing message falls back to when a workspace
// hasn't set (or has cleared) its own company name -- never an empty
// header/sign-off, and never another workspace's identity.
const FALLBACK_COMPANY_NAME = "ScheduleFlowTrack";

// Every company_name value must pass through here before it's used in an
// email "From" header or a message body -- company_name is owner-entered
// free text with no existing format validation elsewhere in the app.
// Strips CR/LF and other control characters (which could otherwise inject
// extra headers into a raw email "From" line) and angle brackets (which
// could otherwise break out of the display-name portion of
// `"Name <address>"` and forge a second address), trims surrounding
// whitespace, and caps length defensively. Falls back to the platform name
// when nothing legitimate remains -- a blank, whitespace-only, or
// entirely-stripped value must never produce an empty header/sign-off.
export function sanitizeCompanyName(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[\r\n\x00-\x1F\x7F<>]/g, "")
    .trim()
    .slice(0, 150);
  return cleaned || FALLBACK_COMPANY_NAME;
}

// Workspace-scoped lookup of the business's own display name, for use as
// the email "From" display name and the sign-off/prefix in every
// client-facing template -- so a client clearly sees which business they
// booked with, not just the software behind it. Always scoped by the exact
// workspace_id the caller already established (the appointment/session's
// own workspace, never request input) -- never a global/default row, and
// never another workspace's name.
export async function getCompanyName(workspaceId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("company_settings")
    .select("company_name")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return sanitizeCompanyName(data?.company_name);
}

export type CompanyIdentity = {
  companyName: string;
  // Whether this workspace has public booking turned on -- read from the
  // SAME row as company_name (one query, not two) for the templates that
  // need both (currently only cancelTemplates' "Need another appointment?"
  // CTA). Fails closed to false on a missing row, a null value, or a query
  // error: `data?.booking_enabled` is undefined in every one of those
  // cases, and Boolean(undefined) is false. A settings-query problem must
  // never accidentally advertise a booking page the business hasn't
  // enabled (or that this app has no way to confirm is enabled).
  bookingEnabled: boolean;
  // Phase 5E: the workspace's own resolved timezone, read from the SAME row
  // -- callers that need appointment date/time content (changeTemplates,
  // reminder24hTemplates) get it from this one query rather than a second
  // round trip. Missing row/column safely resolves through
  // effectiveTimezone to the canonical America/New_York fallback, exactly
  // like every other timezone-reading call site in this codebase.
  timezone: string;
};

// Workspace-scoped lookup combining company_name, booking_enabled, and
// timezone for callers that need any combination of the three -- same
// workspace_id scoping guarantees as getCompanyName above, just one query
// instead of two (or three) for routes that need more than company_name
// alone.
export async function getCompanyIdentity(workspaceId: string): Promise<CompanyIdentity> {
  const { data } = await supabaseAdmin
    .from("company_settings")
    .select("company_name, booking_enabled, timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return {
    companyName: sanitizeCompanyName(data?.company_name),
    bookingEnabled: Boolean(data?.booking_enabled),
    timezone: effectiveTimezone(data?.timezone),
  };
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

// fromDisplayName: the workspace's own sanitized company name (see
// getCompanyName/sanitizeCompanyName above), so the client's inbox shows
// which business the email is from -- not just generic platform branding.
// Optional and falls back to the pre-existing RESEND_FROM_NAME/platform
// default so any caller that doesn't (yet) have a company name to pass
// keeps working exactly as before. Re-sanitized here regardless of whether
// the caller already did, so this function can never emit an unsafe "From"
// header no matter what a future caller passes in.
export async function sendEmail(to: string, subject: string, text: string, workspaceId: string, fromDisplayName?: string) {
  if (disabled) {
    console.log("[DISABLE_MESSAGES] Email skipped — to:", to, "| subject:", subject, "| body:", text);
    return "disabled";
  }
  if (!(await ownerNotificationsEnabled(workspaceId))) {
    console.log("[notifications_enabled=false] Email skipped — to:", to, "| subject:", subject, "| workspace:", workspaceId);
    return "notifications-off";
  }
  const fromName = fromDisplayName ? sanitizeCompanyName(fromDisplayName) : (process.env.RESEND_FROM_NAME || "FlowTrack Schedule");
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
