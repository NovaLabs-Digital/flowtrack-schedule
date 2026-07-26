import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { MFA_PENDING_MAX_AGE_SECONDS } from "@/lib/sessionCrypto";

// Phase 5.7D-R3 — server-side claim record for the window between password
// verification and completed TOTP verification. The browser is handed only
// the `token` value (inside a signed, HttpOnly, 5-minute sft_mfa_pending
// cookie — see lib/sessionCrypto.ts) — the actual Supabase access/refresh
// token pair lives here, server-side, and is never sent to the browser.
// Same lease/claim shape already proven in this schema by
// stripe_webhook_events/billing_email_log (migrations/015).

export const MFA_MAX_ATTEMPTS = 5;

function generateOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface CreatePendingMfaChallengeParams {
  authUserId: string;
  supabaseAccessToken: string;
  supabaseRefreshToken: string;
  factorId?: string | null;
}

// Creates a fresh, single-use pending-challenge row and returns its opaque
// token — the only value the caller should put in the sft_mfa_pending
// cookie.
export async function createPendingMfaChallenge(params: CreatePendingMfaChallengeParams): Promise<string> {
  const token = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + MFA_PENDING_MAX_AGE_SECONDS * 1000).toISOString();
  const { error } = await supabaseAdmin.from("pending_mfa_challenges").insert({
    token,
    auth_user_id: params.authUserId,
    factor_id: params.factorId ?? null,
    supabase_access_token: params.supabaseAccessToken,
    supabase_refresh_token: params.supabaseRefreshToken,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return token;
}

export interface PendingMfaChallenge {
  token: string;
  authUserId: string;
  factorId: string | null;
  supabaseAccessToken: string;
  supabaseRefreshToken: string;
  attemptCount: number;
}

// Reads and validates a pending challenge by its opaque token. Returns null
// for anything missing, expired, or already consumed — callers treat this
// exactly like "no pending challenge at all," never distinguishing why, so
// an attacker who doesn't already hold a valid token learns nothing from
// the response shape.
export async function getPendingMfaChallenge(token: string): Promise<PendingMfaChallenge | null> {
  const { data, error } = await supabaseAdmin
    .from("pending_mfa_challenges")
    .select("token, auth_user_id, factor_id, supabase_access_token, supabase_refresh_token, attempt_count, expires_at, consumed_at")
    .eq("token", token)
    .maybeSingle();

  if (error || !data) return null;
  if (data.consumed_at) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  return {
    token: data.token,
    authUserId: data.auth_user_id,
    factorId: data.factor_id,
    supabaseAccessToken: data.supabase_access_token,
    supabaseRefreshToken: data.supabase_refresh_token,
    attemptCount: data.attempt_count,
  };
}

// Increments attempt_count and returns the new count. Callers compare
// against MFA_MAX_ATTEMPTS and invalidate the challenge outright once
// reached (see consumePendingMfaChallenge) — this function alone does not
// enforce the limit, matching the same "count, then decide" separation
// lib/rateLimit.ts already uses.
export async function recordFailedMfaAttempt(token: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("pending_mfa_challenges")
    .select("attempt_count")
    .eq("token", token)
    .maybeSingle();
  if (error || !data) return MFA_MAX_ATTEMPTS;
  const next = data.attempt_count + 1;
  await supabaseAdmin.from("pending_mfa_challenges").update({ attempt_count: next }).eq("token", token);
  return next;
}

// Records which factor a pending enrollment is for, once auth.mfa.enroll()
// creates it — so the follow-up verify step reads factorId from this
// server-held row rather than trusting whatever a client request supplies.
export async function setPendingMfaFactorId(token: string, factorId: string): Promise<void> {
  await supabaseAdmin.from("pending_mfa_challenges").update({ factor_id: factorId }).eq("token", token);
}

// Single-use consumption: marks the row consumed so it can never be
// presented again, even before its own 5-minute expiry. Called the instant
// MFA succeeds (immediately before sft_session is issued) or once the
// attempt limit is exceeded (forcing a fresh password login).
export async function consumePendingMfaChallenge(token: string): Promise<void> {
  await supabaseAdmin
    .from("pending_mfa_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("token", token);
}
