import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Isolated, request-local Supabase client used ONLY to verify owner
// credentials and perform MFA operations against Supabase Auth
// (signInWithPassword, signUp, auth.mfa.*). Deliberately separate from the
// shared service-role supabaseAdmin client — this one holds no elevated
// database privileges and is never used for any table access. No session
// persistence/refresh/URL detection: any token pair this client receives is
// read no further than what each call site explicitly needs, and is
// discarded when the request completes — never stored, never forwarded to
// the browser, except for the one narrow, explicitly time-boxed exception
// documented in lib/mfaPending.ts (the pending-MFA-challenge window).
//
// Factored out of app/api/auth/login/route.ts (Phase 5.7D) so signup, MFA
// enrollment, and MFA verification can all share the exact same
// construction rather than three slightly-diverging copies.
export function createOwnerAuthClient(): SupabaseClient {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Constructs a client that authenticates AS a specific already-verified
// Supabase session (access/refresh token pair) — needed to call
// auth.mfa.challenge/verify/listFactors/enroll in the correct user context
// when resuming from a pending MFA challenge (the client only holds the
// opaque token; the actual Supabase session lives server-side in
// pending_mfa_challenges — see lib/mfaPending.ts).
export async function createScopedAuthClient(accessToken: string, refreshToken: string): Promise<SupabaseClient> {
  const client = createOwnerAuthClient();
  await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  return client;
}
