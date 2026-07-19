export const runtime = "nodejs";

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { createSessionCookieValue, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import { safeEqual } from "@/lib/safeEqual";
import { isRateLimited, recordFailedAttempt, recordSuccessfulAttempt } from "@/lib/rateLimit";
import { REAL_WORKSPACE_ID, DEMO_WORKSPACE_ID } from "@/lib/workspace";

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

    const validEmail = process.env.ADMIN_EMAIL;
    const validPassword = process.env.ADMIN_PASSWORD;
    const ownerOk =
      !!validEmail && !!validPassword && safeEqual(email, validEmail) && safeEqual(password, validPassword);

    if (!ownerOk) {
      recordFailedAttempt(clientKey);
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }

    recordSuccessfulAttempt(clientKey);
    const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
    setCookie(res, await createSessionCookieValue("owner", REAL_WORKSPACE_ID));
    return res;
  } catch (e: any) {
    console.error("LOGIN_ERROR", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
