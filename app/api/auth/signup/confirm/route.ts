export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { provisionOwnerWorkspace } from "@/lib/signupProvisioning";
import { beginMfaFlow } from "@/lib/mfaFlow";
import { setMfaPendingCookie } from "@/lib/session";

// Receives Supabase's own confirmation-email redirect (the `code` query
// param from its PKCE flow) and exchanges it for a session — this is the
// one place email ownership is actually proven. Never issues sft_session
// itself; hands off into the same MFA enrollment/challenge gate every
// returning owner login uses.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || url.origin;

  if (!code) {
    return NextResponse.redirect(`${appUrl}/signup?error=invalid_link`);
  }

  try {
    const client = createOwnerAuthClient();
    const { data, error } = await client.auth.exchangeCodeForSession(code);
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
