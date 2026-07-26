export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createScopedAuthClient } from "@/lib/supabaseAuthClient";
import { getMfaPendingToken } from "@/lib/session";
import { getPendingMfaChallenge, setPendingMfaFactorId } from "@/lib/mfaPending";

const GENERIC_ERROR = "Unable to start MFA setup. Please sign in again.";

// GET — begins TOTP enrollment for the identity behind the current
// sft_mfa_pending cookie. Returns Supabase's own QR code (SVG data URI)
// and manual-entry secret DIRECTLY from its response — this route never
// stores either anywhere (no table, no log line); they exist only in this
// one response, over HTTPS, for the browser to render once.
export async function GET() {
  try {
    const token = await getMfaPendingToken();
    if (!token) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    const challenge = await getPendingMfaChallenge(token);
    if (!challenge) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    const client = await createScopedAuthClient(challenge.supabaseAccessToken, challenge.supabaseRefreshToken);
    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) {
      console.error("MFA_ENROLL_ERROR");
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
    }

    await setPendingMfaFactorId(token, data.id);

    // qr_code is Supabase's own SVG data URI; secret is the manual-entry
    // fallback. Neither is written to any table, log line, or persisted
    // anywhere by this route — the response body is the only place either
    // value exists server-side, for the duration of this one request.
    return NextResponse.json({
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      factorId: data.id,
    });
  } catch (e) {
    console.error("MFA_ENROLL_ERROR", e);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
