import "server-only";
import { createOwnerAuthClient } from "@/lib/supabaseAuthClient";

// Thin wrapper around the two Supabase Auth SDK calls the signup route
// needs, factored into their own module (rather than injected parameters
// on the route's exported POST handler) so route-level tests can fake them
// with mock.module("@/lib/signupAuth", ...) — the same convention every
// other route test in this codebase already uses for its external
// dependencies (mock.module("@/lib/notify", ...), mock.module("@/lib/session", ...)).
//
// The exact Supabase Auth SDK response shape for signUp against an
// already-registered, confirmed email needs verification against the
// installed @supabase/supabase-js version at implementation time (see the
// Phase 5.7D-R1 audit's "remaining decisions") — Supabase's documented
// anti-enumeration behavior is to return success with an EMPTY identities
// array rather than a distinct error, which is what defaultSignUp checks
// for below, but this should be re-confirmed against a real signup attempt
// in a non-production environment before this ships.

export interface SignInResult {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export interface SignUpResult {
  outcome: "created" | "already_registered";
  userId?: string;
  accessToken?: string;
  refreshToken?: string;
}

export async function signInWithPassword(email: string, password: string): Promise<SignInResult | null> {
  const client = createOwnerAuthClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) return null;
  return { userId: data.user.id, accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
}

// The confirmation email's redirect target -- without this, where Supabase
// sends the browser after confirming is governed entirely by the Supabase
// Dashboard's Site URL / redirect-allow-list, outside this app's control
// (see the 2026-08-06 Journey Inpsyred and 2026-08-07 SFT Signup Test
// incidents: both confirmed emails without ever reaching
// /api/auth/signup/confirm). Falls back to leaving emailRedirectTo unset
// (today's behavior) only if the env var is somehow missing.
function confirmRedirectUrl(): string | undefined {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  return appUrl ? `${appUrl}/api/auth/signup/confirm` : undefined;
}

export async function signUp(email: string, password: string): Promise<SignUpResult> {
  const client = createOwnerAuthClient();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: confirmRedirectUrl() },
  });
  if (error) {
    return { outcome: "already_registered" };
  }
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    return { outcome: "already_registered" };
  }
  const session = data.session;
  return {
    outcome: "created",
    userId: data.user.id,
    accessToken: session?.access_token,
    refreshToken: session?.refresh_token,
  };
}
