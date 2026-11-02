import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OwnerSecurityState } from "@/lib/ownerSecurity";

// Database (migration 045) and Supabase Auth admin calls for owner sign-in
// security. Every function throws on an error it cannot rule out, so callers
// fail closed: an unknown state is never read as "two-step off".

export async function getOwnerSecurityState(authUserId: string): Promise<OwnerSecurityState> {
  const { data, error } = await supabaseAdmin.rpc("owner_security_state", { p_user: authUserId });
  if (error || !data || typeof data !== "object") throw new Error("OWNER_SECURITY_STATE_ERROR");
  const s = data as { required?: unknown; codes_total?: unknown; codes_unused?: unknown };
  if (typeof s.required !== "boolean") throw new Error("OWNER_SECURITY_STATE_ERROR");
  return { required: s.required, codesTotal: Number(s.codes_total ?? 0), codesUnused: Number(s.codes_unused ?? 0) };
}

export async function lockOwnerSecurity(authUserId: string, holder: string, seconds: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("owner_security_lock", { p_user: authUserId, p_holder: holder, p_seconds: seconds });
  if (error) throw new Error("OWNER_SECURITY_LOCK_ERROR");
  return data === true;
}

export async function unlockOwnerSecurity(authUserId: string, holder: string): Promise<void> {
  await supabaseAdmin.rpc("owner_security_unlock", { p_user: authUserId, p_holder: holder });
}

// Applies the change and signs out every other device in one transaction.
// Returns the new session epoch, or null when nothing was changed.
export async function finishOwnerSecurity(
  authUserId: string,
  holder: string,
  required: boolean | null,
  codeHashes: string[] | null
): Promise<number | null> {
  const { data, error } = await supabaseAdmin.rpc("owner_security_finish", {
    p_user: authUserId,
    p_holder: holder,
    p_required: required,
    p_code_hashes: codeHashes,
  });
  if (error) throw new Error("OWNER_SECURITY_FINISH_ERROR");
  return typeof data === "number" ? data : null;
}

export async function recoveryCodeIsUnused(authUserId: string, codeHash: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("owner_recovery_codes")
    .select("id")
    .eq("auth_user_id", authUserId)
    .eq("code_hash", codeHash)
    .is("used_at", null)
    .maybeSingle();
  if (error) throw new Error("OWNER_RECOVERY_CODE_ERROR");
  return !!data;
}

// Marks the code used; true only for the one request that used it.
export async function consumeRecoveryCode(authUserId: string, codeHash: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("owner_use_recovery_code", { p_user: authUserId, p_code_hash: codeHash });
  if (error) throw new Error("OWNER_RECOVERY_CODE_ERROR");
  return data === true;
}

export async function getOwnerEmail(authUserId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(authUserId);
  if (error || !data?.user || data.user.id !== authUserId) return null;
  return data.user.email ?? null;
}

// Every authenticator (TOTP factor) on the identity.
export async function listAuthenticators(authUserId: string): Promise<Array<{ id: string; verified: boolean }>> {
  const { data, error } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: authUserId });
  if (error || !data) throw new Error("OWNER_FACTORS_ERROR");
  return (data.factors ?? [])
    .filter((f) => f.factor_type === "totp")
    .map((f) => ({ id: f.id, verified: f.status === "verified" }));
}

export async function countVerifiedAuthenticators(authUserId: string): Promise<number> {
  return (await listAuthenticators(authUserId)).filter((f) => f.verified).length;
}

// Removes every authenticator. Throws if any removal fails (the ones that
// remain still make sign-in ask for a code).
export async function removeAllAuthenticators(authUserId: string): Promise<void> {
  for (const factor of await listAuthenticators(authUserId)) {
    const { error } = await supabaseAdmin.auth.admin.mfa.deleteFactor({ id: factor.id, userId: authUserId });
    if (error) throw new Error("OWNER_FACTOR_DELETE_ERROR");
  }
}
