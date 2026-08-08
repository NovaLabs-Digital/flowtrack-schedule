export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";
import { validateContactSubmission, sendContactEmail } from "@/lib/contactMessage";

const GENERIC_ERROR = "We couldn't send your message right now. Please try again shortly, or email us directly.";
// Generous for a contact form (name/email/company/subject/message, all
// individually length-capped in lib/contactMessage.ts) -- this is a coarse,
// cheap pre-parse guard against a pathologically oversized request body,
// not the primary defense.
const MAX_BODY_BYTES = 20_000;

function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

// Public, unauthenticated by design -- no account/session required to send
// a message. Recipient (SUPPORT_EMAIL) and sender identity are both fixed
// server-side in lib/contactMessage.ts; nothing in the request body can
// change who this is sent to or from.
export async function POST(req: Request) {
  const clientIp = clientIpFor(req);

  try {
    const limited = await checkAndRecordRateLimit("contact", clientIp);
    if (limited.limited) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: limited.retryAfterSeconds ? { "Retry-After": String(limited.retryAfterSeconds) } : undefined }
      );
    }

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request too large." }, { status: 413 });
    }

    const body = await req.json().catch(() => ({}));

    // Honeypot: a hidden field real visitors never see or fill (see
    // app/contact/page.tsx). A bot that fills every input it finds trips
    // this -- respond with the identical success shape as a real
    // submission (never reveal that it was caught, and never error), but
    // silently discard it without ever calling sendContactEmail.
    const honeypot = (body as Record<string, unknown> | null)?.website;
    if (typeof honeypot === "string" && honeypot.trim() !== "") {
      return NextResponse.json({ ok: true });
    }

    const validation = validateContactSubmission(body);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    await sendContactEmail(validation.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // Fixed message only -- never e.message/provider details/stack, which
    // could otherwise leak Resend configuration or internal state to a
    // public, unauthenticated endpoint.
    console.error("CONTACT_ERROR", e);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
