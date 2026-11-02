export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createScopedAuthClient } from "@/lib/supabaseAuthClient";
import { getMfaPendingToken } from "@/lib/session";
import { getPendingMfaChallenge, setPendingEnrolled } from "@/lib/mfaPending";
import { getOwnerSecurityState, lockOwnerSecurity } from "@/lib/ownerSecurityStore";
import { lockHolderFor, SECURITY_LOCK_SECONDS } from "@/lib/ownerSecurity";

const GENERIC_ERROR = "Unable to start MFA setup. Please sign in again.";
const BUSY_ERROR = "Another sign-in security change is in progress. Please try again in a few minutes.";

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

    // Migration 045: setting up an authenticator is allowed only
    //   * while signing in with none set up -- and, if this identity has had
    //     recovery codes, only after one was accepted (so a password alone
    //     can never set up a new authenticator for it); or
    //   * when a signed-in owner (password re-entered) turns two-step on.
    // Never in a turn-off or new-codes flow. Unknown state: refused.
    if (challenge.purpose !== "login" && challenge.purpose !== "enable") {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
    }
    const { data: factorsData, error: factorsErr } = await client.auth.mfa.listFactors();
    if (factorsErr) throw factorsErr;
    const verified = (factorsData?.totp ?? []).filter((f) => f.status === "verified").length;
    const security = await getOwnerSecurityState(challenge.authUserId);
    const allowed =
      verified === 0 &&
      (challenge.purpose === "enable" ? !security.required : security.codesTotal === 0 || challenge.recovered);
    if (!allowed) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
    }
    // One security change at a time per identity (held until verify
    // finishes it, or it expires).
    if (!(await lockOwnerSecurity(challenge.authUserId, lockHolderFor(token), SECURITY_LOCK_SECONDS))) {
      return NextResponse.json({ error: BUSY_ERROR }, { status: 409 });
    }

    const { data, error } = await client.auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) {
      console.error("MFA_ENROLL_ERROR");
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
    }

    await setPendingEnrolled(token, data.id);

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
