// Owner sign-in security (migration 045): optional two-step sign-in with
// single-use recovery codes. Pure helpers only -- the database and Supabase
// Auth calls live in lib/ownerSecurityStore.ts.
//
// The setting belongs to the owner's sign-in identity (Supabase Auth user),
// like the authenticator itself; an identity owns at most one workspace.
//
// The one rule every sign-in follows (needsSecondStep): a code is required
// when the setting is on OR a verified authenticator exists. Any partial
// failure between an authenticator change and the database update therefore
// leaves sign-in stricter, never weaker.
import { createHash, randomInt } from "node:crypto";

export type OwnerSecurityState = { required: boolean; codesTotal: number; codesUnused: number };

// 32 symbols (no 0/O, 1/I) x 16 characters = 80 bits per code.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const RECOVERY_CODE_COUNT = 10;
const CODE_LENGTH = 16;

export function needsSecondStep(state: Pick<OwnerSecurityState, "required">, verifiedFactors: number): boolean {
  return state.required || verifiedFactors > 0;
}

// What sign-in asks for after a correct password:
//   challenge -- a code from the authenticator;
//   enroll    -- set up an authenticator (two-step on, none set up yet);
//   recover   -- a recovery code first (two-step on, no authenticator, and
//                this identity has had recovery codes -- so a password alone
//                can never set up a new authenticator for it);
//   password  -- nothing more (two-step off and no authenticator).
export type SignInStep = "challenge" | "enroll" | "recover" | "password";
export function signInStep(state: OwnerSecurityState, verifiedFactors: number): SignInStep {
  if (verifiedFactors > 0) return "challenge";
  if (!state.required) return "password";
  return state.codesTotal > 0 ? "recover" : "enroll";
}

// What Sign-in Security shows.
export type TwoStepStatus = "on" | "off" | "needs_setup";
export function twoStepStatus(state: Pick<OwnerSecurityState, "required">, verifiedFactors: number): TwoStepStatus {
  if (verifiedFactors > 0) return "on";
  return state.required ? "needs_setup" : "off";
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): { codes: string[]; hashes: string[] } {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = "";
    for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
    codes.add(raw);
  }
  const list = Array.from(codes);
  return { codes: list.map(formatRecoveryCode), hashes: list.map(hashRecoveryCode) };
}

export function formatRecoveryCode(raw: string): string {
  return raw.match(/.{1,4}/g)!.join("-");
}

// Accepts what a person types: any case, spaces or dashes. Returns null when
// it cannot be a recovery code at all.
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
  return raw;
}

export function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(`sft-recovery:${normalized}`).digest("hex");
}

// The per-identity security-change lock is held by one pending verification;
// its holder id is a hash of that pending token (never the token itself).
export function lockHolderFor(pendingToken: string): string {
  return createHash("sha256").update(`sft-lock:${pendingToken}`).digest("hex");
}

// How long one security change may hold the lock: the life of its pending
// verification (5 minutes, MFA_PENDING_MAX_AGE_SECONDS) plus a margin --
// after that the change can no longer finish anyway, so an abandoned one
// blocks a new one for at most this long.
export const SECURITY_LOCK_SECONDS = 5 * 60 + 30;
