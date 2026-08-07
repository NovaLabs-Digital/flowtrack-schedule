export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { provisionOwnerWorkspace } from "@/lib/signupProvisioning";
import { beginMfaFlow } from "@/lib/mfaFlow";
import { setMfaPendingCookie } from "@/lib/session";

// Receives Supabase's own confirmation-email redirect and proves email
// ownership — this is the one place that happens. Supports two mechanisms:
//
// - token_hash (primary): Supabase's stateless OTP-style verification,
//   verified directly against Supabase Auth with no local state required.
//   This is the only mechanism that can actually work with this app's
//   architecture -- signUp() runs server-side (app/api/auth/signup/route.ts)
//   and this callback runs in a separate, later serverless invocation, so
//   there is no shared browser/storage for a PKCE code_verifier to survive
//   in between (see lib/signupAuth.ts's createOwnerAuthClient, which holds
//   no session storage at all). `type` is always hardcoded to "signup"
//   here, never trusted from the URL -- this route only ever handles
//   signup confirmations.
// - code (legacy): the original PKCE exchange path, kept only for
//   backward compatibility with any link already in flight. Requires
//   flowType "pkce" and a persisted code_verifier to actually succeed,
//   neither of which this app's server-side signup client provides -- see
//   the token_hash path above for why this can't reliably work here.
//
// Never issues sft_session itself; hands off into the same MFA
// enrollment/challenge gate every returning owner login uses.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;

  if (!code && !tokenHash) {
    return NextResponse.redirect(`${appUrl}/signup?error=invalid_link`);
  }

  try {
    const client = createOwnerAuthClient();
    const { data, error } = tokenHash
      ? await client.auth.verifyOtp({ token_hash: tokenHash, type: "signup" })
      : await client.auth.exchangeCodeForSession(code!);
    if (error || !data.session || !data.user) {
      return NextResponse.redirect(`${appUrl}/signup?error=invalid_link`);
    }

    // Never trust the exchange response alone — re-fetch the user
    // server-side (service-role) as the authoritative proof that
    // email_confirmed_at is actually set (Phase 5.7D-R1 audit's "Proof
    // that email_confirmed_at is present").
    const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.getUserById(data.user.id);
    if (userErr || !userData.user || !userData.user.email_confirmed_at) {
      return NextResponse.redirect(`${appUrl}/signup?error=not_confirmed`);
    }

    // Idempotent — a retried callback (double-clicked link, network retry)
    // for an identity that already owns a workspace returns that same
    // workspace_id rather than creating a second one (migration 017's own
    // guard).
    await provisionOwnerWorkspace(data.user.id);

    const flow = await beginMfaFlow(client, {
      authUserId: data.user.id,
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
    });

    const dest = flow.step === "enroll" ? `${appUrl}/mfa/enroll` : `${appUrl}/mfa/challenge`;
    const res = NextResponse.redirect(dest);
    await setMfaPendingCookie(res, flow.pendingToken);
    return res;
  } catch (e) {
    console.error("SIGNUP_CONFIRM_ERROR", e);
    return NextResponse.redirect(`${appUrl}/signup?error=server_error`);
  }
}
