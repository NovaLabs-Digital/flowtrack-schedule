import "server-only";
import { Resend } from "resend";
import { SUPPORT_EMAIL } from "@/lib/support";

// Deliberately separate from lib/notify.ts rather than reusing it: notify.ts
// constructs its Twilio client at module load time, which throws without
// real credentials (this is why it can never be imported, even
// transitively, during tests -- see lib/testSupport.ts's own comment on
// this). Contact Us needs no SMS, no per-workspace notifications_enabled
// gate, and no messages_sent audit row (Resend + the support inbox are the
// system of record here), so a small dedicated module avoids inheriting any
// of that.

export const CONTACT_FIELD_LIMITS = {
  name: 100,
  email: 254,
  company: 150,
  subject: 150,
  message: 5000,
} as const;

export interface ContactSubmission {
  name: string;
  email: string;
  company: string | null;
  subject: string;
  message: string;
}

export type ContactValidationResult =
  | { ok: true; data: ContactSubmission }
  | { ok: false; error: string };

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Pure, no I/O -- trims/normalizes every field and enforces the same
// server-side-authoritative validation convention used by
// app/api/auth/signup/route.ts (never trust client-side validation alone).
export function validateContactSubmission(body: unknown): ContactValidationResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = String(b.name ?? "").trim();
  const email = String(b.email ?? "").trim().toLowerCase();
  const company = String(b.company ?? "").trim();
  const subject = String(b.subject ?? "").trim();
  const message = String(b.message ?? "").trim();

  if (!name) return { ok: false, error: "Please enter your name." };
  if (name.length > CONTACT_FIELD_LIMITS.name) {
    return { ok: false, error: `Name must be ${CONTACT_FIELD_LIMITS.name} characters or fewer.` };
  }
  if (!email || !isValidEmail(email) || email.length > CONTACT_FIELD_LIMITS.email) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (company.length > CONTACT_FIELD_LIMITS.company) {
    return { ok: false, error: `Company must be ${CONTACT_FIELD_LIMITS.company} characters or fewer.` };
  }
  if (!subject) return { ok: false, error: "Please enter a subject." };
  if (subject.length > CONTACT_FIELD_LIMITS.subject) {
    return { ok: false, error: `Subject must be ${CONTACT_FIELD_LIMITS.subject} characters or fewer.` };
  }
  if (!message) return { ok: false, error: "Please enter a message." };
  if (message.length > CONTACT_FIELD_LIMITS.message) {
    return { ok: false, error: `Message must be ${CONTACT_FIELD_LIMITS.message} characters or fewer.` };
  }

  return { ok: true, data: { name, email, company: company || null, subject, message } };
}

// Lazily constructed and cached on first call -- same convention as
// lib/stripe.ts's getStripeConfig(), so a missing RESEND_API_KEY only
// throws when a submission actually arrives, not at module load (which
// would otherwise break `next build`'s page-data collection and every
// test that imports this module).
let cachedClient: Resend | null = null;
function getResendClient(): Resend {
  if (!cachedClient) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new Error("CONTACT_EMAIL_CONFIG_MISSING");
    cachedClient = new Resend(apiKey);
  }
  return cachedClient;
}

// Recipient (SUPPORT_EMAIL) and sender (RESEND_FROM_EMAIL/NAME) are both
// fixed server-side constants -- nothing in `data` (visitor-supplied) can
// ever influence To or From. replyTo is the one visitor-controlled value
// intentionally forwarded, and only after validateContactSubmission has
// already confirmed it's a well-formed email address.
export async function sendContactEmail(data: ContactSubmission): Promise<void> {
  const fromName = process.env.RESEND_FROM_NAME || "FlowTrack Schedule";
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!fromEmail) throw new Error("CONTACT_EMAIL_CONFIG_MISSING");

  const lines = [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    ...(data.company ? [`Company: ${data.company}`] : []),
    `Subject: ${data.subject}`,
    "",
    data.message,
  ];

  const { error } = await getResendClient().emails.send({
    from: `${fromName} <${fromEmail}>`,
    to: SUPPORT_EMAIL,
    replyTo: data.email,
    subject: `[Contact Us] ${data.subject}`,
    text: lines.join("\n"),
  });
  // Resend's SDK returns { data, error } instead of throwing on API-level
  // rejections -- throw here so the route's try/catch (which never forwards
  // this message to the browser) still catches it, same convention as
  // lib/notify.ts's sendEmail.
  if (error) {
    throw Object.assign(new Error(error.message), error);
  }
}
