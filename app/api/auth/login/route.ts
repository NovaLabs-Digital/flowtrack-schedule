export const runtime = "nodejs";

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createSessionCookieValue, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import { safeEqual } from "@/lib/safeEqual";
import { isRateLimited, recordFailedAttempt, recordSuccessfulAttempt } from "@/lib/rateLimit";
import { DEMO_WORKSPACE_ID } from "@/lib/workspace";

// Isolated, request-local client used ONLY to verify owner credentials
// against Supabase Auth (auth.signInWithPassword). Deliberately separate
// from the shared service-role supabaseAdmin client — this one holds no
// elevated database privileges and is never used for any table access.
// No session persistence/refresh/URL detection: the token pair this client
// may receive is read no further than checking for success and is
// discarded when the request completes — never stored, never forwarded to
// the browser.
function createOwnerAuthClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

const GENERIC_AUTH_ERROR = "Invalid email or password";

// A precomputed bcrypt hash of an arbitrary string, compared against when no
// employee matches the submitted email. This keeps a "no such account"
// response taking the same time as a "wrong password" response — without
// it, the missing bcrypt.compare() call would make nonexistent-account
// responses measurably faster, letting an attacker enumerate real emails by
// timing alone even though both cases return the same error text.
const DUMMY_PASSWORD_HASH = "$2b$10$kSPv921oLeSBUU7sdaHSWe9XzorYI./qVsIgqbcbH.hEBrYcrWeqy";

function setCookie(res: NextResponse, value: string) {
  res.cookies.set("sft_session", value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

function clientKeyFor(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

export async function POST(req: Request) {
  const clientKey = clientKeyFor(req);

  try {
    const limited = isRateLimited(clientKey);
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
        recordFailedAttempt(clientKey);
        return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
      }

      recordSuccessfulAttempt(clientKey);
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
      recordSuccessfulAttempt(clientKey);
      const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
      setCookie(res, await createSessionCookieValue("tester", DEMO_WORKSPACE_ID));
      return res;
    }

    // Owner login is verified exclusively through Supabase Auth (the
    // temporary ADMIN_EMAIL/ADMIN_PASSWORD fallback was removed after
    // production verification — see docs/SECURITY.md). The workspace is
    // always resolved from workspace_memberships, never a hardcoded
    // constant, so both conditions below must hold for login to succeed.
    const ownerAuthClient = createOwnerAuthClient();
    const { data: authData, error: authErr } = await ownerAuthClient.auth.signInWithPassword({ email, password });
    // authData.session (access_token/refresh_token) is intentionally never
    // read past this point — only authData.user.id (an identifier, not a
    // credential) is used below.
    let workspaceId: string | null = null;
    if (!authErr && authData?.user) {
      const { data: membership, error: membershipErr } = await supabaseAdmin
        .from("workspace_memberships")
        .select("workspace_id")
        .eq("profile_id", authData.user.id)
        .eq("role", "owner")
        .maybeSingle();

      if (membershipErr) {
        // Fixed tag only — no identifiers or DB error details, which could
        // otherwise leak schema/data information into logs.
        console.error("OWNER_AUTH_MEMBERSHIP_QUERY_ERROR");
      } else if (membership?.workspace_id) {
        workspaceId = membership.workspace_id;
      } else {
        console.error("OWNER_AUTH_MEMBERSHIP_MISSING");
      }
    }

    if (!workspaceId) {
      recordFailedAttempt(clientKey);
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }

    console.log("OWNER_LOGIN_SUCCESS");
    recordSuccessfulAttempt(clientKey);
    const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
    setCookie(res, await createSessionCookieValue("owner", workspaceId));
    return res;
  } catch (e: any) {
    console.error("LOGIN_ERROR", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
