export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { checkAndRecordRateLimit } from "@/lib/durableRateLimit";
import { signInWithPassword, signUp } from "@/lib/signupAuth";
import { createPendingSignup, findOwnerMembership, provisionOwnerWorkspace } from "@/lib/signupProvisioning";
import { beginMfaFlow } from "@/lib/mfaFlow";
import { setMfaPendingCookie } from "@/lib/session";

const MIN_PASSWORD_LENGTH = 12;
const TERMS_VERSION = "2026-07-26";
const ALREADY_EXISTS_ERROR = "An account with this email already exists.";
const GENERIC_ERROR = "Unable to create your account right now. Please try again shortly.";

function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(req: Request) {
  const clientIp = clientIpFor(req);

  try {
    // Phase 5.7D-R4: durable, repository-backed rate limiting (migration
    // 017's rate_limit_counters + record_rate_limit_attempt) -- an
    // in-memory Map cannot protect a public signup endpoint across
    // Vercel's multiple concurrent serverless instances. Every attempt
    // counts toward the limit, success or failure alike (a successful
    // signup submission is itself part of the abuse this exists to bound
    // -- mass fake-account creation), unlike the password-login bucket.
    const limited = await checkAndRecordRateLimit("signup", clientIp);
    if (limited.limited) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        { status: 429, headers: limited.retryAfterSeconds ? { "Retry-After": String(limited.retryAfterSeconds) } : undefined }
      );
    }

    const body = await req.json().catch(() => ({}));

    // Every field is read individually and by name — workspace_id, role,
    // billing_mode, notifications_enabled, booking_enabled, and any trial
    // field are never read from the request body anywhere in this route,
    // which is itself the enforcement: there is no code path through which
    // a client-supplied value for any of them could reach provisioning.
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const companyName = String(body.companyName || "").trim();
    const termsAccepted = body.termsAccepted === true;

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 });
    }
    if (!companyName) {
      return NextResponse.json({ error: "Company name is required." }, { status: 400 });
    }
    if (!termsAccepted) {
      return NextResponse.json({ error: "You must accept the Terms of Service and Privacy Policy." }, { status: 400 });
    }

    // Resume path: does this requester actually know the password for an
    // existing account with this email? Never trust email equality alone
    // (see the Phase 5.7D-R1 correction) — password proof (or, for an
    // unconfirmed account, completing the email link) is required before
    // this route does anything with a pre-existing identity.
    const signIn = await signInWithPassword(email, password);
    if (signIn) {
      const membership = await findOwnerMembership(signIn.userId);
      if (membership) {
        return NextResponse.json({ error: ALREADY_EXISTS_ERROR }, { status: 409 });
      }

      // Password proven, no workspace yet, and signInWithPassword only
      // succeeds for an already-confirmed account (Supabase itself refuses
      // to sign in an unconfirmed user) — safe to provision immediately and
      // proceed straight to MFA enrollment, reusing the pending_signups row
      // if still on file, or refreshing it with the just-submitted values
      // if it's missing (this is effectively "retry signup with the same
      // email," and the requester has just re-supplied fresh consent/
      // company-name values).
      await createPendingSignup({
        authUserId: signIn.userId,
        email,
        companyName,
        termsAcceptedAt: new Date().toISOString(),
        termsVersion: TERMS_VERSION,
      }).catch(() => {
        // A pre-existing, unconsumed pending_signups row for this identity
        // is fine to leave as-is (its own unique constraint on
        // auth_user_id rejects the duplicate insert) — provisioning below
        // reads whichever row is on file.
      });
      await provisionOwnerWorkspace(signIn.userId);

      const flow = await beginMfaFlow(createOwnerAuthClient(), {
        authUserId: signIn.userId,
        accessToken: signIn.accessToken,
        refreshToken: signIn.refreshToken,
      });
      const res = NextResponse.json({ ok: true, next: flow.step, factorIds: flow.step === "challenge" ? flow.factorIds : undefined });
      await setMfaPendingCookie(res, flow.pendingToken);
      return res;
    }

    const signUpResult = await signUp(email, password);
    if (signUpResult.outcome === "already_registered") {
      return NextResponse.json({ error: ALREADY_EXISTS_ERROR }, { status: 409 });
    }

    // Fresh signup: Supabase creates the unconfirmed Auth user and (once
    // "Confirm email" is enabled for this project — see the Phase 5.7D-R1
    // audit's Supabase dashboard requirements) sends its own confirmation
    // email natively. This app writes no email-sending code for this step.
    await createPendingSignup({
      authUserId: signUpResult.userId!,
      email,
      companyName,
      termsAcceptedAt: new Date().toISOString(),
      termsVersion: TERMS_VERSION,
    });

    return NextResponse.json({ ok: true, next: "check_email" });
  } catch (e) {
    console.error("SIGNUP_ERROR", e);
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
