import twilio from "twilio";
import sgMail from "@sendgrid/mail";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!
);

const disabled = process.env.DISABLE_MESSAGES === "true";

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

export async function sendSms(to: string, body: string) {
  if (disabled) {
    console.log("[DISABLE_MESSAGES] SMS skipped — to:", to, "| body:", body);
    return "disabled";
  }
  const msg = await twilioClient.messages.create({
    to,
    from: process.env.TWILIO_FROM_NUMBER!,
    body,
  });
  return msg.sid;
}

export async function sendEmail(to: string, subject: string, text: string) {
  if (disabled) {
    console.log("[DISABLE_MESSAGES] Email skipped — to:", to, "| subject:", subject, "| body:", text);
    return "disabled";
  }
  const res = await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL!,
      name: process.env.SENDGRID_FROM_NAME || "FlowTrack Schedule",
    },
    subject,
    text,
  });
  return res?.[0]?.headers?.["x-message-id"]?.toString() || "sendgrid";
}
