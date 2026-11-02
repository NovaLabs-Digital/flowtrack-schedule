export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createScopedAuthClient } from "@/lib/supabaseAuthClient";
import { getMfaPendingToken, clearMfaPendingCookie, createOwnerSessionCookieValue, setOwnerSessionCookie } from "@/lib/session";
import { getPendingMfaChallenge, recordFailedMfaAttempt, consumePendingMfaChallenge, MFA_MAX_ATTEMPTS } from "@/lib/mfaPending";
import { findOwnerMembership, bumpSessionEpoch } from "@/lib/signupProvisioning";
import { finishOwnerSecurity, lockOwnerSecurity, unlockOwnerSecurity, removeAllAuthenticators } from "@/lib/ownerSecurityStore";
import { generateRecoveryCodes, lockHolderFor, SECURITY_LOCK_SECONDS } from "@/lib/ownerSecurity";
import { sendAccountSecurityEmail, TWO_STEP_OFF_EMAIL } from "@/lib/securityEmail";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";

const GENERIC_ERROR = "Invalid code. Please try again.";
const EXPIRED_ERROR = "Your session has expired. Please sign in again.";
const LOCKED_ERROR = "Too many attempts. Please sign in again.";
const CODES_NOT_SAVED =
  "Two-step sign-in is on and sign-in will ask for a code, but your recovery codes couldn't be created. Create them in Settings > Sign-in Security.";

// Migration 045: completes a security change (setting, recovery codes, and
// signing out every other device, in one transaction). null = nothing was
// changed (the lock was lost, or the database failed) -- never thrown, so
// each caller decides what is still true and says so.
async function finishChange(authUserId: string, holder: string, required: boolean | null, codeHashes: string[] | null) {
  try {
    const epoch = await finishOwnerSecurity(authUserId, holder, required, codeHashes);
    if (epoch === null) await unlockOwnerSecurity(authUserId, holder).catch(() => {});
    return epoch;
  } catch {
    console.error("OWNER_SECURITY_FINISH_FAILED");
    await unlockOwnerSecurity(authUserId, holder).catch(() => {});
    return null;
  }
}

function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

// The one route that ever issues an owner sft_session. Nothing upstream of
// this point (signup, email confirmation, MFA enrollment, password login)
// ever sets sft_session — see the Phase 5.7D-R1/R2 audits' "no owner
// session before aal2" requirement.
export async function POST(req: Request) {
  try {
    // Phase 5.7D-R4: durable, IP-keyed rate limiting as defense-in-depth
    // ON TOP OF the existing per-challenge attempt counter
    // (pending_mfa_challenges.attempt_count, still enforced below). The
    // per-challenge counter alone bounds attempts against ONE specific
    // pending token; this bounds attempts against the endpoint itself
    // regardless of how many different pending challenges an attacker
    // rotates through (e.g. by repeatedly re-triggering login with a
    // stolen password to mint a fresh challenge each time).
    const limited = await checkAndRecordRateLimit("mfaVerify", clientIpFor(req));
    if (limited.limited) {
      return NextResponse.json(
        { error: LOCKED_ERROR },
        { status: 429, headers: limited.retryAfterSeconds ? { "Retry-After": String(limited.retryAfterSeconds) } : undefined }
      );
    }

    const token = await getMfaPendingToken();
    if (!token) {
      return NextResponse.json({ error: EXPIRED_ERROR }, { status: 401 });
    }

    const challenge = await getPendingMfaChallenge(token);
    if (!challenge) {
      return NextResponse.json({ error: EXPIRED_ERROR }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const code = String(body.code || "").trim();

    const client = await createScopedAuthClient(challenge.supabaseAccessToken, challenge.supabaseRefreshToken);

    // factorId: the pending row's own recorded value (set at enrollment,
    // or at challenge-initiation for a returning login — see
    // app/api/auth/login/route.ts) is always the source of truth. A
    // client-supplied factorId is only ever considered when the pending row
    // has none recorded (the "multiple verified factors -> allow selection"
    // case), and even then only after confirming it against a fresh,
    // server-side listFactors() call — never trusted blindly.
    let factorId = challenge.factorId;
    if (!factorId) {
      const requestedFactorId = String(body.factorId || "");
      const { data: factorsData } = await client.auth.mfa.listFactors();
      const verifiedIds = (factorsData?.totp ?? []).filter((f) => f.status === "verified").map((f) => f.id);
      if (!requestedFactorId || !verifiedIds.includes(requestedFactorId)) {
        return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
      }
      factorId = requestedFactorId;
    }

    if (!code) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
    }

    const { data: challengeData, error: challengeErr } = await client.auth.mfa.challenge({ factorId });
    if (challengeErr || !challengeData) {
      console.error("MFA_CHALLENGE_ERROR");
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
    }

    const { data: verifyData, error: verifyErr } = await client.auth.mfa.verify({
      factorId,
      challengeId: challengeData.id,
      code,
    });

    if (verifyErr || !verifyData) {
      const attempts = await recordFailedMfaAttempt(token);
      if (attempts >= MFA_MAX_ATTEMPTS) {
        // Lockout: destroy the challenge outright (its returned data isn't
        // needed here — the request is being denied either way).
        await consumePendingMfaChallenge(token);
        const res = NextResponse.json({ error: LOCKED_ERROR }, { status: 401 });
        clearMfaPendingCookie(res);
        return res;
      }
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    // Server-side re-check, never a client claim (Phase 5.7D-R2 audit:
    // "client claims about MFA/AAL are never trusted"). A successful
    // verify() call already implies aal2 in practice, but this is the one
    // gate that matters most, so it's checked explicitly and independently
    // rather than inferred from a 200 status alone.
    const { data: aalData } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalData?.currentLevel !== "aal2") {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
    }

    // Phase 5.7D-R7: atomic delete-and-return consumption is the actual
    // gate for session issuance, placed immediately once the server has
    // independently confirmed aal2 — not an afterthought performed once
    // everything else has already succeeded. Whichever concurrent
    // request's delete actually removes the row is the only one permitted
    // to proceed; every other request (replay, race, browser retry) gets
    // null back here and fails closed, before ever reaching membership
    // lookup or session issuance. If anything below this point fails
    // (e.g. no membership found), the challenge is already gone — there
    // is no path back to retry it; a fresh login is required.
    const consumed = await consumePendingMfaChallenge(token);
    if (!consumed) {
      const res = NextResponse.json({ error: EXPIRED_ERROR }, { status: 401 });
      clearMfaPendingCookie(res);
      return res;
    }

    // Workspace identity match: looked up fresh, keyed by the SAME
    // authUserId the just-consumed row itself confirms — the resulting
    // session's workspaceId/authUserId/sessionEpoch all come from this one
    // row, so the Auth identity and the workspace it's granted access to
    // can never drift apart (Phase 5.7D-R2 audit: "workspace membership
    // and MFA identity must refer to the same Auth user").
    //
    // Migration 045: what this verification completes (consumed.purpose).
    // Every branch either finishes its whole change or reports exactly what
    // is still true; none leaves sign-in weaker than before after an error.
    const authUserId = consumed.authUserId;
    const holder = lockHolderFor(token);
    const purpose = consumed.purpose ?? "login";
    let recoveryCodes: string[] | undefined;
    let notice: string | undefined;
    let failure: { status: number; error: string } | undefined;

    if (purpose === "enable" || (purpose === "login" && (consumed.enrolled || consumed.recovered))) {
      // A new authenticator was just verified (turning two-step on, a first
      // setup, or setup after recovery): two-step on, new recovery codes,
      // every other device signed out. The authenticator is already
      // verified, so if saving fails sign-in still asks for a code; other
      // devices are still signed out separately.
      if (purpose === "enable" && !consumed.enrolled) {
        return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
      }
      const fresh = generateRecoveryCodes();
      if ((await finishChange(authUserId, holder, true, fresh.hashes)) !== null) {
        recoveryCodes = fresh.codes;
      } else {
        notice = CODES_NOT_SAVED;
        await bumpSessionEpoch(authUserId).catch(() => console.error("OWNER_SECURITY_EPOCH_BUMP_FAILED"));
      }
    } else if (purpose === "disable") {
      // Three steps, ordered so that a failure at any point leaves sign-in
      // at least as strict as before AND the owner able to get back in:
      //   1. setting off (signs out other devices); recovery codes KEPT.
      //      Fails -> nothing changed.
      //   2. the authenticator removed, still under the change lock. Fails
      //      -> it still exists, so sign-in still asks for its code, the
      //      recovery codes still work, the lock is released, and turning
      //      off can be retried at once.
      //   3. recovery codes cleared. Fails -> they are left over but unused
      //      by sign-in (two-step is off, no authenticator); turning on
      //      again replaces them.
      if ((await finishChange(authUserId, holder, false, null)) === null) {
        const res = NextResponse.json({ error: "Two-step sign-in is still on. Nothing was changed. Please try again." }, { status: 409 });
        clearMfaPendingCookie(res);
        return res;
      }
      let removed = false;
      try {
        if (await lockOwnerSecurity(authUserId, holder, SECURITY_LOCK_SECONDS)) {
          await removeAllAuthenticators(authUserId);
          removed = true;
        }
      } catch {
        console.error("OWNER_TWO_STEP_OFF_FACTOR_REMOVAL_FAILED");
      }
      if (removed) {
        if ((await finishChange(authUserId, holder, null, [])) === null) console.error("OWNER_TWO_STEP_OFF_CODES_LEFT_OVER");
        await sendAccountSecurityEmail(authUserId, TWO_STEP_OFF_EMAIL.subject, TWO_STEP_OFF_EMAIL.text);
      } else {
        await unlockOwnerSecurity(authUserId, holder).catch(() => {});
        failure = {
          status: 500,
          error:
            "Two-step sign-in is still on because your authenticator couldn't be removed. Sign-in still asks for a code and your recovery codes still work. Please try again.",
        };
      }
    } else if (purpose === "codes") {
      // Only offered while an authenticator exists, so the setting is also
      // (re)affirmed on -- this repairs a turn-on whose save failed.
      const fresh = generateRecoveryCodes();
      if ((await finishChange(authUserId, holder, true, fresh.hashes)) === null) {
        const res = NextResponse.json({ error: "New recovery codes couldn't be created. Your existing codes still work. Please try again." }, { status: 409 });
        clearMfaPendingCookie(res);
        return res;
      }
      recoveryCodes = fresh.codes;
    }

    const membership = await findOwnerMembership(authUserId);
    if (!membership) {
      console.error("MFA_VERIFY_MEMBERSHIP_MISSING");
      return NextResponse.json({ error: "Unable to complete sign-in. Please try again." }, { status: 500 });
    }

    // This device stays signed in (with the session epoch read after any
    // change above); "keep me signed in" applies only to signing in.
    const trusted = purpose === "login" && body.trustDevice === true;
    const sessionValue = await createOwnerSessionCookieValue({
      workspaceId: membership.workspaceId,
      authUserId,
      sessionEpoch: membership.sessionEpoch,
      trusted,
    });

    const res = failure
      ? NextResponse.json({ error: failure.error }, { status: failure.status })
      : NextResponse.json({ ok: true, redirect: "/dashboard", ...(recoveryCodes ? { recoveryCodes } : {}), ...(notice ? { notice } : {}) });
    setOwnerSessionCookie(res, sessionValue, trusted);
    clearMfaPendingCookie(res);
    return res;
  } catch (e) {
    console.error("MFA_VERIFY_ERROR", e);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
