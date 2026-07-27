import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPendingMfaChallenge } from "@/lib/mfaPending";

// Phase 5.7D — the one shared decision point for "what does this Auth user
// need to do next to reach aal2," used identically by both entry points:
// the signup confirmation callback (always zero factors, first-time
// enrollment) and the returning-owner login route (zero, one, or multiple
// factors). Reusing one function for both is deliberate — it's the same
// mechanism the Phase 5.7D-R2 audit's rollout/recovery design already
// depends on ("existing owner with zero factors" and "post-recovery
// re-enrollment" converge to the identical enrollment gate, not a special
// case).
//
// Establishes a pending_mfa_challenges row (lib/mfaPending.ts) holding the
// Supabase access/refresh token pair the caller already obtained (from
// signInWithPassword or the confirmation exchange) — the browser only ever
// receives the resulting opaque token, never the pair itself.

export type MfaFlowStep =
  | { step: "enroll"; pendingToken: string }
  | { step: "challenge"; pendingToken: string; factorIds: string[] };

export interface MfaListFactorsClient {
  auth: {
    mfa: {
      listFactors: () => Promise<{ data: { totp?: Array<{ id: string; status: string }> } | null; error: unknown }>;
    };
  };
}

export async function beginMfaFlow(
  client: MfaListFactorsClient | SupabaseClient,
  params: { authUserId: string; accessToken: string; refreshToken: string }
): Promise<MfaFlowStep> {
  const { data, error } = await (client as MfaListFactorsClient).auth.mfa.listFactors();
  if (error) throw error;

  const verifiedTotp = (data?.totp ?? []).filter((f) => f.status === "verified");

  // Phase 5.7D-R12: when exactly one verified factor exists (the common
  // case), record its id on the pending row now, at creation time — the
  // same thing app/api/auth/mfa/enroll/route.ts's GET handler already does
  // via setPendingMfaFactorId immediately after enroll() succeeds. Without
  // this, a single-factor login's pending row was left with factor_id:
  // null, and /api/auth/mfa/verify's client-supplied-factorId fallback
  // path had nothing to fall back to (lib/loginNavigation.ts only ever
  // put a factor id in the challenge URL for factorIds.length > 1) --
  // every fresh, correct TOTP code was rejected with a generic 400 before
  // Supabase's real challenge/verify endpoints were ever called. Left
  // unset (null) for zero or multiple factors, matching prior behavior:
  // zero has nothing to select, and multiple is still an explicit
  // client-selection case the verify route already validates correctly.
  const soleVerifiedFactorId = verifiedTotp.length === 1 ? verifiedTotp[0].id : null;

  const pendingToken = await createPendingMfaChallenge({
    authUserId: params.authUserId,
    supabaseAccessToken: params.accessToken,
    supabaseRefreshToken: params.refreshToken,
    factorId: soleVerifiedFactorId,
  });

  if (verifiedTotp.length === 0) {
    return { step: "enroll", pendingToken };
  }
  return { step: "challenge", pendingToken, factorIds: verifiedTotp.map((f) => f.id) };
}
