export const runtime = "nodejs";

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { createSessionCookieValue, SESSION_MAX_AGE_SECONDS, setMfaPendingCookie } from "@/lib/session";
import { beginMfaFlow } from "@/lib/mfaFlow";
import { safeEqual } from "@/lib/safeEqual";
import { checkAndRecordRateLimit, clearRateLimit } from "@/lib/durableRateLimit";
import { DEMO_WORKSPACE_ID } from "@/lib/workspace";

const GENERIC_AUTH_ERROR = "Invalid email or password";

// A precomputed bcrypt hash of an arbitrary string, compared against when no
// employee matches the submitted email. This keeps a "no such account"
// response taking the same time as a "wrong password" response — without
// it, the missing bcrypt.compare() call would make nonexistent-account
// responses measurably faster, letting an attacker enumerate real emails by
// timing alone even though both cases return the same error text.
const DUMMY_PASSWORD_HASH = "$2b$10$kSPv921oLeSBUU7sdaHSWe9XzorYI./qVsIgqbcbH.hEBrYcrWeqy";

// Employee/tester only — UNCHANGED by Phase 5.7D (owner sessions no longer
// use this cookie shape at all; see setOwnerSessionCookie in lib/session.ts).
function setCookie(res: NextResponse, value: string) {
  res.cookies.set("sft_session", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

function clientIpFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

export async function POST(req: Request) {
  const clientIp = clientIpFor(req);

  try {
    // Phase 5.7D-R4: durable, repository-backed rate limiting (migration
    // 017), replacing the previous in-memory-only Map, which cannot
    // protect a public login endpoint across Vercel's multiple concurrent
    // serverless instances. This one atomic call both checks AND records
    // the current attempt; a successful login clears the bucket below
    // (clearRateLimit), preserving the pre-existing "only failures count"
    // semantics rather than the stricter "every attempt counts" rule used
    // for signup/confirmation-resend/MFA-verify.
    const limited = await checkAndRecordRateLimit("login", clientIp);
    if (limited.limited) {
      return NextResponse.json(
        { error: "Too many attempts. Please try again later." },
        {
          status: 429,
          headers: limited.retryAfterSeconds ? { "Retry-After": String(limited.retryAfterSeconds) } : undefined,
        }
      );
    }

    const body = await req.json();
    const email = (body.email || "").trim();
    const password = (body.password || "").trim();
    const role = (body.role || "").trim();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }

    // Employee and tester authentication: UNCHANGED by Phase 5.7D. MFA
    // applies to owners only.
    if (role === "employee") {
      const { data: emp, error } = await supabaseAdmin
        .from("employees")
        .select("id, password_hash, active, workspace_id")
        .eq("email", email)
        .maybeSingle();

      if (error) throw error;

      const hashToCheck = emp?.password_hash || DUMMY_PASSWORD_HASH;
      const passwordMatches = await bcrypt.compare(password, hashToCheck);
      const ok = !!emp && emp.active && !!emp.password_hash && passwordMatches;

      if (!ok) {
        return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
      }

      await clearRateLimit("login", clientIp);
      const res = NextResponse.json({ ok: true, redirect: "/schedule" });
      setCookie(res, await createSessionCookieValue("employee", emp!.id, emp!.workspace_id));
      return res;
    }

    const testerEmail = process.env.TESTER_EMAIL;
    const testerPassword = process.env.TESTER_PASSWORD;
    if (
      testerEmail &&
      testerPassword &&
      safeEqual(email, testerEmail) &&
      safeEqual(password, testerPassword)
    ) {
      await clearRateLimit("login", clientIp);
      const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
      setCookie(res, await createSessionCookieValue("tester", DEMO_WORKSPACE_ID));
      return res;
    }

    // Owner login, step 1 of 2 (Phase 5.7D — mandatory MFA). Password
    // verification alone is only aal1; sft_session is NEVER issued from
    // this branch. Supabase Auth remains the sole credential verifier (the
    // workspace is always resolved from workspace_memberships, never a
    // hardcoded constant), but a correct password now only advances the
    // owner to an MFA challenge/enrollment step, handed off via the
    // short-lived sft_mfa_pending cookie — see lib/mfaFlow.ts.
    const ownerAuthClient = createOwnerAuthClient();
    const { data: authData, error: authErr } = await ownerAuthClient.auth.signInWithPassword({ email, password });
    let workspaceId: string | null = null;
    let sessionEpoch: number | null = null;
    if (!authErr && authData?.user) {
      const { data: membership, error: membershipErr } = await supabaseAdmin
        .from("workspace_memberships")
        .select("workspace_id, session_epoch")
        .eq("profile_id", authData.user.id)
        .eq("role", "owner")
        .maybeSingle();

      if (membershipErr) {
        // Fixed tag only — no identifiers or DB error details, which could
        // otherwise leak schema/data information into logs.
        console.error("OWNER_AUTH_MEMBERSHIP_QUERY_ERROR");
      } else if (membership?.workspace_id) {
        workspaceId = membership.workspace_id;
        sessionEpoch = membership.session_epoch;
      } else {
        console.error("OWNER_AUTH_MEMBERSHIP_MISSING");
      }
    }

    if (!workspaceId || sessionEpoch === null || !authData?.session || !authData.user) {
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }

    await clearRateLimit("login", clientIp);

    // Phase 5.7D: no factor enrolled -> mandatory enrollment (this is the
    // same gate that safely transitions an existing pre-MFA owner account
    // and the same one used for post-recovery re-enrollment — see the
    // Phase 5.7D-R2 audit's "Existing-owner rollout"); one verified factor
    // -> challenge it; multiple -> the client is told every verified
    // factorId so it can offer a picker.
    const flow = await beginMfaFlow(ownerAuthClient, {
      authUserId: authData.user.id,
      accessToken: authData.session.access_token,
      refreshToken: authData.session.refresh_token,
    });
    const res = NextResponse.json({
      ok: true,
      next: flow.step,
      factorIds: flow.step === "challenge" ? flow.factorIds : undefined,
    });
    await setMfaPendingCookie(res, flow.pendingToken);
    return res;
  } catch (e: any) {
    console.error("LOGIN_ERROR", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
