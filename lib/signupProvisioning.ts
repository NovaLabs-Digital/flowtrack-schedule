import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Phase 5.7D — server-controlled pending signup data (company name, Terms
// acceptance evidence) between initial signup submission and email
// confirmation. Deliberately NOT stored in Supabase Auth's user_metadata:
// that field is browser-updatable in default Supabase configurations, and
// mixing loosely-typed "claimed intent" with the identity record itself is
// exactly the risk this table exists to avoid. Read only by
// provisionOwnerWorkspace below, keyed by the server-verified auth_user_id
// — never by anything a browser supplies at confirmation time.

export interface CreatePendingSignupParams {
  authUserId: string;
  email: string;
  companyName: string;
  termsAcceptedAt: string;
  termsVersion: string;
}

export async function createPendingSignup(params: CreatePendingSignupParams): Promise<void> {
  const { error } = await supabaseAdmin.from("pending_signups").insert({
    auth_user_id: params.authUserId,
    email: params.email,
    company_name: params.companyName,
    terms_accepted_at: params.termsAcceptedAt,
    terms_version: params.termsVersion,
  });
  if (error) throw error;
}

export interface OwnerMembership {
  workspaceId: string;
  sessionEpoch: number;
}

// Looks up an existing owner membership for a given Auth user id — used by
// both the signup route's duplicate-email recovery path and the login
// route's post-password-verification flow. Returns null if the identity
// has no workspace yet (a genuinely new signup, or an orphaned partial
// signup awaiting provisioning/enrollment).
export async function findOwnerMembership(authUserId: string): Promise<OwnerMembership | null> {
  const { data, error } = await supabaseAdmin
    .from("workspace_memberships")
    .select("workspace_id, session_epoch")
    .eq("profile_id", authUserId)
    .eq("role", "owner")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { workspaceId: data.workspace_id, sessionEpoch: data.session_epoch };
}

// Invokes the transactional provisioning function (migration 017). The
// ONLY input is the server-verified Auth user id — never a workspace id,
// role, billing mode, or toggle value from the browser. Idempotent: a
// second invocation for an identity that already owns a workspace returns
// that same workspace_id rather than creating a second one (see the
// function's own idempotency guard) — safe to call more than once for the
// same identity (a retried confirmation callback, a browser that lost the
// response after the transaction already committed).
export async function provisionOwnerWorkspace(authUserId: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("provision_owner_workspace", { p_auth_user_id: authUserId });
  if (error) throw error;
  return data as string;
}

// Increments session_epoch for a given owner identity — the one mechanism
// that makes an otherwise-stateless sft_session cookie revocable. Called
// only by: "sign out all devices," password reset/change, email change,
// MFA removal/replacement, and support/security recovery. Ordinary
// sign-out never calls this (see app/api/auth/logout/route.ts).
export async function bumpSessionEpoch(authUserId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("workspace_memberships")
    .select("session_epoch")
    .eq("profile_id", authUserId)
    .eq("role", "owner")
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  await supabaseAdmin
    .from("workspace_memberships")
    .update({ session_epoch: data.session_epoch + 1 })
    .eq("profile_id", authUserId)
    .eq("role", "owner");
}
