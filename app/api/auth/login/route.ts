export const runtime = "nodejs";

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { createSessionCookieValue, SESSION_MAX_AGE_SECONDS, setMfaPendingCookie, setEmployeeWorkspaceSelectionCookie } from "@/lib/session";
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

    // Employee and tester authentication.
    //
    // Migration 019: employees.email is now unique only per workspace, not
    // globally -- the same real person can be an employee of more than one
    // business/workspace, deliberately using the SAME email and the SAME
    // password in each (the approved product design; requiring a distinct
    // password per workspace was explicitly rejected). A lookup that
    // assumed at most one row could ever match -- this route previously
    // used .maybeSingle(), which throws if more than one row matches -- is
    // no longer safe on its own. There is no per-workspace login URL, so
    // the submitted password is compared against every active,
    // password-configured candidate row for this normalized email:
    //   - exactly one match -> log in directly, unchanged from before.
    //   - zero matches -> the same generic error as always.
    //   - more than one match -> no session is issued yet. A short-lived,
    //     signed, single-purpose challenge (sft_employee_workspace_pending
    //     -- see lib/session.ts/lib/sessionCrypto.ts) is set, scoped to
    //     exactly the matched candidates, and the response returns only an
    //     opaque selectionId + company display name per choice -- never a
    //     workspace/employee UUID. app/api/auth/employee/select-workspace
    //     validates that challenge and the employee's explicit choice
    //     before ever issuing the real sft_session.
    // Never a "pick the first match" fallback in any case.
    if (role === "employee") {
      const normalizedEmail = email.toLowerCase();
      const { data: candidates, error } = await supabaseAdmin
        .from("employees")
        .select("id, password_hash, active, workspace_id")
        .eq("email", normalizedEmail);

      if (error) throw error;

      const activeCandidates = (candidates ?? []).filter((c) => c.active && c.password_hash);

      // Always compares against at least two hashes (real or dummy) so the
      // response time for "this email doesn't exist at all" and "this
      // email exists in exactly one workspace" stays close to identical --
      // the same constant-time intent DUMMY_PASSWORD_HASH already served
      // for the single-candidate case, extended to the new multi-candidate
      // one. Real candidates are never padded away; only the shortfall
      // below two is filled with the dummy hash.
      const hashesToCheck = activeCandidates.map((c) => c.password_hash as string);
      while (hashesToCheck.length < 2) hashesToCheck.push(DUMMY_PASSWORD_HASH);
      const matchResults = await Promise.all(hashesToCheck.map((h) => bcrypt.compare(password, h)));
      const matchedCandidates = activeCandidates.filter((_, i) => matchResults[i]);

      if (matchedCandidates.length === 0) {
        return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
      }

      // The password was genuinely correct for at least one workspace --
      // matches the existing "only failures count" semantics regardless of
      // whether this resolves directly or needs a workspace choice next.
      await clearRateLimit("login", clientIp);

      if (matchedCandidates.length === 1) {
        const emp = matchedCandidates[0];
        const res = NextResponse.json({ ok: true, redirect: "/schedule" });
        setCookie(res, await createSessionCookieValue("employee", emp.id, emp.workspace_id));
        return res;
      }

      // More than one workspace matched -- fetch each candidate's company
      // display name (never the raw workspace id) for the selection
      // screen, build an opaque per-candidate selectionId, and hand back
      // only {selectionId, companyName} pairs.
      const workspaceIds = Array.from(new Set(matchedCandidates.map((c) => c.workspace_id)));
      const { data: companyRows, error: companyErr } = await supabaseAdmin
        .from("company_settings")
        .select("workspace_id, company_name")
        .in("workspace_id", workspaceIds);
      if (companyErr) throw companyErr;
      const companyNameByWorkspace = new Map((companyRows ?? []).map((c) => [c.workspace_id, c.company_name as string]));

      const selectionCandidates = matchedCandidates.map((c) => ({
        selectionId: crypto.randomUUID(),
        employeeId: c.id as string,
        workspaceId: c.workspace_id as string,
      }));
      const choices = selectionCandidates.map((c) => ({
        selectionId: c.selectionId,
        companyName: companyNameByWorkspace.get(c.workspaceId) ?? "Unnamed company",
      }));

      const res = NextResponse.json({ ok: true, next: "select_workspace", choices });
      await setEmployeeWorkspaceSelectionCookie(res, selectionCandidates);
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
