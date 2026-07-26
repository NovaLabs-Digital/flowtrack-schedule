export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createScopedAuthClient } from "@/lib/supabaseAuthClient";
import { getMfaPendingToken, clearMfaPendingCookie, createOwnerSessionCookieValue, setOwnerSessionCookie } from "@/lib/session";
import { getPendingMfaChallenge, recordFailedMfaAttempt, consumePendingMfaChallenge, MFA_MAX_ATTEMPTS } from "@/lib/mfaPending";
import { findOwnerMembership } from "@/lib/signupProvisioning";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";

const GENERIC_ERROR = "Invalid code. Please try again.";
const EXPIRED_ERROR = "Your session has expired. Please sign in again.";
const LOCKED_ERROR = "Too many attempts. Please sign in again.";

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

    // Workspace identity match: looked up fresh, keyed by the SAME
    // authUserId that was just challenged — the resulting session's
    // workspaceId/authUserId/sessionEpoch all come from this one row, so
    // the Auth identity and the workspace it's granted access to can never
    // drift apart (Phase 5.7D-R2 audit: "workspace membership and MFA
    // identity must refer to the same Auth user").
    const membership = await findOwnerMembership(challenge.authUserId);
    if (!membership) {
      console.error("MFA_VERIFY_MEMBERSHIP_MISSING");
      return NextResponse.json({ error: "Unable to complete sign-in. Please try again." }, { status: 500 });
    }

    const trusted = body.trustDevice === true;
    const sessionValue = await createOwnerSessionCookieValue({
      workspaceId: membership.workspaceId,
      authUserId: challenge.authUserId,
      sessionEpoch: membership.sessionEpoch,
      trusted,
    });

    // Single-use: this pending challenge can never be presented again after
    // this point, even before its own 5-minute expiry.
    await consumePendingMfaChallenge(token);

    const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
    setOwnerSessionCookie(res, sessionValue, trusted);
    clearMfaPendingCookie(res);
    return res;
  } catch (e) {
    console.error("MFA_VERIFY_ERROR", e);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
