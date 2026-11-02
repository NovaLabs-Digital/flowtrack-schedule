export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { getMfaPendingToken, clearMfaPendingCookie } from "@/lib/session";
import {
  getPendingMfaChallenge,
  recordFailedMfaAttempt,
  consumePendingMfaChallenge,
  setPendingRecovered,
  MFA_MAX_ATTEMPTS,
} from "@/lib/mfaPending";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";
import {
  getOwnerEmail,
  getOwnerSecurityState,
  lockOwnerSecurity,
  unlockOwnerSecurity,
  recoveryCodeIsUnused,
  removeAllAuthenticators,
  consumeRecoveryCode,
} from "@/lib/ownerSecurityStore";
import { hashRecoveryCode, lockHolderFor, normalizeRecoveryCode, SECURITY_LOCK_SECONDS } from "@/lib/ownerSecurity";
import { sendAccountSecurityEmail, RECOVERY_CODE_USED_EMAIL } from "@/lib/securityEmail";

// Lost authenticator (migration 045). During sign-in -- after the password
// step -- the owner enters one unused recovery code AND their password
// again. Then:
//   1. the code is checked (not yet used up), the password re-checked;
//   2. every authenticator on the identity is removed (this also ends the
//      identity's Supabase sessions, hence the password: it starts a fresh
//      session for setting up the new authenticator);
//   3. the code is used up atomically (a replayed or concurrent use fails);
//   4. the owner continues to /mfa/enroll. Two-step sign-in stays ON; the
//      new authenticator's verification issues new recovery codes (old ones
//      stop working) and signs out every other device.
// If the owner stops after step 3, two-step is still on with no
// authenticator: the next sign-in asks for another recovery code -- a
// password alone never sets up a new authenticator for this identity.
// Attempts are limited per network, per pending sign-in, and per identity.

const INVALID = "That recovery code or password isn't correct.";
const EXPIRED = "Your session has expired. Please sign in again.";
const LOCKED = "Too many attempts. Please sign in again.";
const BUSY = "Another sign-in security change is in progress. Please try again in a few minutes.";

function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

export async function POST(req: Request) {
  try {
    const ipLimited = await checkAndRecordRateLimit("mfaVerify", clientIpFor(req));
    if (ipLimited.limited) return NextResponse.json({ error: LOCKED }, { status: 429 });

    const token = await getMfaPendingToken();
    const challenge = token ? await getPendingMfaChallenge(token) : null;
    if (!token || !challenge || challenge.purpose !== "login") {
      return NextResponse.json({ error: EXPIRED }, { status: 401 });
    }
    const authUserId = challenge.authUserId;

    const userLimited = await checkAndRecordRateLimit("recoveryCode", authUserId);
    if (userLimited.limited) return NextResponse.json({ error: "Too many recovery attempts. Please try again later." }, { status: 429 });

    const body = await req.json().catch(() => ({}));
    const normalized = normalizeRecoveryCode(body.code);
    const password = typeof body.password === "string" ? body.password : "";

    const fail = async () => {
      const attempts = await recordFailedMfaAttempt(token);
      if (attempts >= MFA_MAX_ATTEMPTS) {
        await consumePendingMfaChallenge(token);
        const res = NextResponse.json({ error: LOCKED }, { status: 401 });
        clearMfaPendingCookie(res);
        return res;
      }
      return NextResponse.json({ error: INVALID }, { status: 401 });
    };

    const security = await getOwnerSecurityState(authUserId);
    if (security.codesUnused === 0) {
      return NextResponse.json({ error: "This account has no unused recovery codes. Please contact support." }, { status: 400 });
    }
    if (!normalized || !password) return fail();
    const codeHash = hashRecoveryCode(normalized);
    if (!(await recoveryCodeIsUnused(authUserId, codeHash))) return fail();

    const email = await getOwnerEmail(authUserId);
    if (!email) return NextResponse.json({ error: "Unable to continue. Please try again." }, { status: 503 });
    const passwordCheck = await createOwnerAuthClient().auth.signInWithPassword({ email, password });
    if (passwordCheck.error || passwordCheck.data?.user?.id !== authUserId) return fail();

    const holder = lockHolderFor(token);
    if (!(await lockOwnerSecurity(authUserId, holder, SECURITY_LOCK_SECONDS))) {
      return NextResponse.json({ error: BUSY }, { status: 409 });
    }

    try {
      await removeAllAuthenticators(authUserId);
    } catch {
      // Some authenticators may remain (sign-in still asks for a code); the
      // recovery code was not used up, so the owner can simply try again.
      await unlockOwnerSecurity(authUserId, holder).catch(() => {});
      console.error("OWNER_RECOVERY_FACTOR_REMOVAL_FAILED");
      return NextResponse.json({ error: "Your authenticator couldn't be reset. Your recovery code still works. Please try again." }, { status: 500 });
    }

    // A fresh session (the old ones ended with the authenticator removal)
    // for setting up the new authenticator.
    const fresh = await createOwnerAuthClient().auth.signInWithPassword({ email, password });
    if (fresh.error || !fresh.data?.session || fresh.data.user?.id !== authUserId) {
      await unlockOwnerSecurity(authUserId, holder).catch(() => {});
      return NextResponse.json({ error: "Unable to continue. Please sign in again." }, { status: 503 });
    }

    if (!(await consumeRecoveryCode(authUserId, codeHash))) {
      // Used by a concurrent request in the meantime: refused.
      await unlockOwnerSecurity(authUserId, holder).catch(() => {});
      return fail();
    }
    await setPendingRecovered(token, fresh.data.session.access_token, fresh.data.session.refresh_token);
    await sendAccountSecurityEmail(authUserId, RECOVERY_CODE_USED_EMAIL.subject, RECOVERY_CODE_USED_EMAIL.text);
    return NextResponse.json({ ok: true, next: "enroll" });
  } catch {
    console.error("OWNER_RECOVERY_ERROR");
    return NextResponse.json({ error: "Unable to continue. Please try again." }, { status: 500 });
  }
}
