export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";

const GENERIC_MESSAGE = "If an account with this email is awaiting verification, we've sent a new confirmation link.";

function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Re-triggers Supabase's own confirmation email for an unconfirmed
// account, using its native resend API -- no custom email-sending code,
// no re-implementation of the confirmation link/token logic. Always
// returns the identical generic message regardless of whether the email
// exists, is already confirmed, or the resend call itself fails, so this
// endpoint cannot be used to enumerate accounts or their confirmation
// state. Durably rate-limited (Phase 5.7D-R4) -- a resend action is
// exactly the kind of public, unauthenticated action that must not rely
// on in-memory-only throttling.
export async function POST(req: Request) {
  const clientIp = clientIpFor(req);

  try {
    const limited = await checkAndRecordRateLimit("confirmResend", clientIp);
    if (limited.limited) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: limited.retryAfterSeconds ? { "Retry-After": String(limited.retryAfterSeconds) } : undefined }
      );
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !isValidEmail(email)) {
      // Still generic -- a malformed email gets the same message as a
      // well-formed one that doesn't match any account, never a distinct
      // validation error that could help enumerate valid addresses.
      return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
    }

    const client = createOwnerAuthClient();
    try {
      await client.auth.resend({ type: "signup", email });
    } catch {
      console.error("SIGNUP_RESEND_ERROR");
    }

    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
  } catch (e) {
    console.error("SIGNUP_RESEND_ERROR", e);
    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
  }
}
