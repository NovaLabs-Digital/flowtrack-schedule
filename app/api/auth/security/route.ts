export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getSession, requireOwner, setMfaPendingCookie, getMfaPendingToken, clearMfaPendingCookie, type Session } from "@/lib/session";
import { requireCurrentOwnerSession } from "@/lib/sessionEpoch";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";
import { createPendingMfaChallenge, consumePendingMfaChallenge, getPendingMfaChallenge, type MfaPurpose } from "@/lib/mfaPending";
import {
  getOwnerSecurityState,
  getOwnerEmail,
  listAuthenticators,
  lockOwnerSecurity,
  unlockOwnerSecurity,
} from "@/lib/ownerSecurityStore";
import { twoStepStatus, lockHolderFor, SECURITY_LOCK_SECONDS } from "@/lib/ownerSecurity";

// Settings > Sign-in Security (migration 045).
//
// GET  -- this owner's status: two-step on / off / needs setup, and how many
//         unused recovery codes remain.
// POST -- { action: "enable" | "disable" | "codes", password } starts a
//         change. The password is checked again here (never trusted from the
//         existing session alone); the change then continues on the existing
//         verification screens:
//           enable  -> set up an authenticator (/mfa/enroll), then verify it;
//           disable -> a code from the current authenticator (/mfa/challenge);
//           codes   -> a code from the current authenticator (/mfa/challenge).
//         The change finishes in /api/auth/mfa/verify, which also signs out
//         every other device.
// DELETE -- cancels this owner's change in progress (the Cancel link on the
//         verification screens): the pending verification is used up and
//         its lock released, so another change can start right away.

const UNAVAILABLE = "Sign-in Security is temporarily unavailable. Please try again.";
const BUSY = "Another sign-in security change is in progress. Please try again in a few minutes.";

type OwnerSession = Extract<Session, { role: "owner" }>;

async function currentOwner(): Promise<{ response: NextResponse } | { session: OwnerSession }> {
  const session = await getSession();
  const deny = requireOwner(session);
  if (deny) return { response: deny };
  if (session.role !== "owner") return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const current = await requireCurrentOwnerSession(session);
  if (!current.ok) return { response: current.response };
  return { session };
}

export async function GET() {
  const owner = await currentOwner();
  if ("response" in owner) return owner.response;
  try {
    const authUserId = owner.session.authUserId;
    const [security, factors] = await Promise.all([getOwnerSecurityState(authUserId), listAuthenticators(authUserId)]);
    const verified = factors.filter((f) => f.verified).length;
    return NextResponse.json(
      { status: twoStepStatus(security, verified), codesUnused: security.codesUnused, codesTotal: security.codesTotal },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    console.error("OWNER_SECURITY_STATUS_ERROR");
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const owner = await currentOwner();
  if ("response" in owner) return owner.response;
  const authUserId = owner.session.authUserId;

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const password = typeof body?.password === "string" ? body.password : "";
  if ((action !== "enable" && action !== "disable" && action !== "codes") || !password) {
    return NextResponse.json({ error: "Enter your password." }, { status: 400 });
  }

  // Password re-checks are limited per owner (not per network), so a
  // signed-in device can't be used to guess the password.
  const limited = await checkAndRecordRateLimit("securityCheck", authUserId);
  if (limited.limited) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429, headers: limited.retryAfterSeconds ? { "Retry-After": String(limited.retryAfterSeconds) } : undefined }
    );
  }

  try {
    const email = await getOwnerEmail(authUserId);
    if (!email) return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
    const client = createOwnerAuthClient();
    const { data: auth, error: authErr } = await client.auth.signInWithPassword({ email, password });
    if (authErr || !auth?.session || auth.user?.id !== authUserId) {
      return NextResponse.json({ error: "That password isn't correct." }, { status: 401 });
    }

    const security = await getOwnerSecurityState(authUserId);
    const { data: factorsData, error: factorsErr } = await client.auth.mfa.listFactors();
    if (factorsErr) throw factorsErr;
    const verifiedIds = (factorsData?.totp ?? []).filter((f) => f.status === "verified").map((f) => f.id);
    const status = twoStepStatus(security, verifiedIds.length);

    if (action === "enable" && status !== "off") {
      return NextResponse.json({ error: "Two-step sign-in is already on." }, { status: 409 });
    }
    if (action !== "enable" && status !== "on") {
      return NextResponse.json(
        {
          error:
            status === "needs_setup"
              ? "Your authenticator isn't set up yet. Sign out and sign in again to set it up."
              : "Two-step sign-in is off.",
        },
        { status: 409 }
      );
    }

    const purpose: MfaPurpose = action;
    const pendingToken = await createPendingMfaChallenge({
      authUserId,
      supabaseAccessToken: auth.session.access_token,
      supabaseRefreshToken: auth.session.refresh_token,
      factorId: action !== "enable" && verifiedIds.length === 1 ? verifiedIds[0] : null,
      purpose,
    });
    // Turning off and new codes hold the change lock from here; turning on
    // takes it when the authenticator is set up (/api/auth/mfa/enroll).
    if (action !== "enable" && !(await lockOwnerSecurity(authUserId, lockHolderFor(pendingToken), SECURITY_LOCK_SECONDS))) {
      await consumePendingMfaChallenge(pendingToken);
      return NextResponse.json({ error: BUSY }, { status: 409 });
    }

    const res = NextResponse.json({
      ok: true,
      next: action === "enable" ? "enroll" : "challenge",
      factorIds: action === "enable" ? undefined : verifiedIds,
    });
    await setMfaPendingCookie(res, pendingToken);
    return res;
  } catch {
    console.error("OWNER_SECURITY_START_ERROR");
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
  }
}

export async function DELETE() {
  const owner = await currentOwner();
  if ("response" in owner) return owner.response;
  const token = await getMfaPendingToken();
  const challenge = token ? await getPendingMfaChallenge(token) : null;
  if (token && challenge && challenge.authUserId === owner.session.authUserId && challenge.purpose !== "login") {
    await consumePendingMfaChallenge(token);
    await unlockOwnerSecurity(owner.session.authUserId, lockHolderFor(token)).catch(() => {});
  }
  const res = NextResponse.json({ ok: true });
  clearMfaPendingCookie(res);
  return res;
}
