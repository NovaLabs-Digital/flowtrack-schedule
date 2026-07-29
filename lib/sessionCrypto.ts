// HMAC signing/verification for the sft_session and sft_mfa_pending
// cookies. Uses Web Crypto (globalThis.crypto.subtle) rather than Node's
// `crypto` module so this file works unmodified in both API routes (nodejs
// runtime) and middleware.ts (edge runtime) — the two places that need to
// verify a session cookie.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Employee/tester duration — UNCHANGED by Phase 5.7D. Owner sessions no
// longer use this constant at all (see below); this remains exported only
// because employee/tester session creation still reads it directly.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Phase 5.7D — owner session durations. "Keep me signed in" unchecked
// (default) caps the signed claim at 12 hours AND is issued as a
// browser-session cookie (no Max-Age on the Set-Cookie header at all, so
// the browser itself also drops it on close); checked issues a persistent
// cookie with Max-Age set, capped at 30 days. Both branches require the
// identical server-verified aal2 proof at issuance — only the resulting
// cookie's persistence type and the signed exp claim's duration differ.
// There is no separate trusted-device cookie.
export const OWNER_SESSION_SHORT_SECONDS = 60 * 60 * 12; // 12 hours
export const OWNER_SESSION_TRUSTED_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Hard cap on the sft_mfa_pending window — the gap between password
// verification and completed TOTP verification. Deliberately short: this
// cookie's only content is a high-entropy opaque reference into
// pending_mfa_challenges (see lib/mfaPending.ts) — the actual Supabase
// token pair never leaves the server (Phase 5.7D-R3 correction).
export const MFA_PENDING_MAX_AGE_SECONDS = 60 * 5; // 5 minutes

// Hard cap on the sft_employee_workspace_pending window — the gap between
// a correctly-verified employee password (matching more than one active
// workspace's employee row for the same normalized email) and the
// employee's explicit workspace choice. Matches MFA_PENDING_MAX_AGE_SECONDS
// exactly: same reasoning, same precedent, deliberately short.
export const EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS = 60 * 5; // 5 minutes

export type SessionRole = "owner" | "tester" | "employee";

// workspaceId is required on every role as of the Phase 2 tenant-scoping
// work — a session that predates this (signed before workspaceId existed)
// fails signature-shape validation below and is treated as no session at
// all, forcing a fresh login rather than silently running with an unscoped
// or wrong-workspace session.
//
// Phase 5.7D: the owner variant gained authUserId, mfa, and sessionEpoch.
// A payload signed under the PRE-5.7D scheme (no authUserId/mfa/
// sessionEpoch) fails the same shape validation and is treated as no
// session — every owner logged in before this shipped is required to log
// in again (and complete MFA enrollment/challenge) on their next request.
// This is the intended, safe transition: no owner session is ever
// "upgraded" in place; there is no path from an old-shaped payload to a
// trusted new one.
export type SessionPayload =
  | { role: "owner"; workspaceId: string; authUserId: string; mfa: true; sessionEpoch: number; exp: number }
  | { role: "tester"; workspaceId: string; exp: number }
  | { role: "employee"; employeeId: string; workspaceId: string; exp: number };

// Phase 5.7D — the transient credential held between password verification
// and a completed TOTP challenge. Deliberately minimal: `token` is the only
// field, an opaque reference into pending_mfa_challenges (lib/mfaPending.ts)
// where the actual Supabase access/refresh token pair, factor id, and
// attempt count live server-side only. This payload shape can never satisfy
// SessionPayload's discriminated union (it has no `role` at all), so it is
// structurally rejected by requireRole/requireOwner/requireRole — there is
// no application access reachable from this cookie on its own.
export type MfaPendingPayload = { token: string; exp: number };

// The multi-workspace employee login challenge — created only after a
// submitted password has already been verified (via bcrypt.compare)
// against every active, password-configured employees row sharing the same
// normalized email, and matched more than one of them. Each candidate
// carries a per-challenge random `selectionId` — the ONLY identifier ever
// exposed to the browser (in the login response's `choices` array); the
// real `employeeId`/`workspaceId` pair stay inside this signed, HttpOnly
// cookie and are never sent to the client in plain form. This deliberately
// mirrors MfaPendingPayload's own shape/isolation properties: it has no
// `role` field either, so it can never satisfy SessionPayload and can never
// be mistaken for (or upgraded into) a real application session by
// requireRole/requireOwner/getSession. `purpose` is an explicit extra
// discriminator (belt-and-suspenders on top of the already-distinct field
// names) so this payload can never be confused with MfaPendingPayload even
// if a future field is added to either shape.
//
// Not enforced as single-use at the database level (there is no server-side
// row for this challenge to delete, unlike pending_mfa_challenges) — this is
// a deliberate "smallest safe change" choice: the payload carries no
// credential or provider secret, only workspace/employee identifiers already
// established as legitimate for this exact login attempt, and the window is
// capped at five minutes (EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS). The
// selection route also clears this cookie immediately on a successful
// selection. A true single-use guarantee would require a new database table
// mirroring lib/mfaPending.ts — flagged as follow-up technical debt, not
// implemented here because it is not required for this payload's much lower
// sensitivity (identifiers only, never a password/token).
export type EmployeeWorkspaceSelectionCandidate = { selectionId: string; employeeId: string; workspaceId: string };
export type EmployeeWorkspaceSelectionPayload = {
  purpose: "employee_workspace_selection";
  candidates: EmployeeWorkspaceSelectionCandidate[];
  exp: number;
};

// SESSION_SECRET is the only key used to sign/verify both cookie kinds — it
// must never fall back to a database or provider secret (a leak of one must
// not also compromise the other). Missing it fails closed: signing throws
// (no cookie of either kind is ever created) and verification catches that
// throw and returns null (every cookie is treated as invalid), so the app
// is unusable rather than insecurely open until it's configured.
let missingSecretLogged = false;

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (!missingSecretLogged) {
      missingSecretLogged = true;
      console.error(
        "[session] SESSION_SECRET is not set. No session can be created or verified until it is configured. All requests are being treated as logged out."
      );
    }
    throw new Error("SESSION_SECRET is not configured");
  }
  return secret;
}

let keyPromise: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = globalThis.crypto.subtle.importKey(
      "raw",
      encoder.encode(getSecret()),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
  }
  return keyPromise;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function newExpiry(maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS): number {
  return Math.floor(Date.now() / 1000) + maxAgeSeconds;
}

// Shared by both cookie kinds — signs an arbitrary JSON-serializable payload
// and returns the `payload.signature` string every cookie in this app uses.
async function signPayload(payload: unknown): Promise<string> {
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await getKey();
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

// Shared by both cookie kinds — verifies the signature and returns the
// decoded, still-unvalidated-by-shape payload, or null for anything
// malformed, unsigned, or tampered. Callers apply their own shape/exp
// validation on top (see verifySessionCookie / verifyMfaPendingCookie
// below) — this function alone does not check `exp`.
async function verifySignedValue(value: string): Promise<unknown | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return null;

  const payloadB64 = value.slice(0, dot);
  const sigB64 = value.slice(dot + 1);

  try {
    const key = await getKey();
    const sigBytes = base64UrlDecode(sigB64);
    const valid = await globalThis.crypto.subtle.verify("HMAC", key, sigBytes as BufferSource, encoder.encode(payloadB64));
    if (!valid) return null;
    return JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));
  } catch {
    return null;
  }
}

export async function signSessionPayload(payload: SessionPayload): Promise<string> {
  return signPayload(payload);
}

// Returns null for anything malformed, unsigned, tampered, or expired —
// callers treat null exactly like "no session" (role: none).
export async function verifySessionCookie(value: string): Promise<SessionPayload | null> {
  const decoded = await verifySignedValue(value);
  if (!decoded || typeof decoded !== "object") return null;
  const payload = decoded as Partial<SessionPayload> & { role?: unknown; exp?: unknown; workspaceId?: unknown };

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.workspaceId !== "string" || !payload.workspaceId) return null;

  if (payload.role === "employee") {
    return typeof payload.employeeId === "string" && payload.employeeId ? (payload as SessionPayload) : null;
  }
  if (payload.role === "tester") {
    return payload as SessionPayload;
  }
  if (payload.role === "owner") {
    const p = payload as { authUserId?: unknown; mfa?: unknown; sessionEpoch?: unknown };
    if (typeof p.authUserId !== "string" || !p.authUserId) return null;
    if (p.mfa !== true) return null;
    if (typeof p.sessionEpoch !== "number" || !Number.isInteger(p.sessionEpoch) || p.sessionEpoch < 1) return null;
    return payload as SessionPayload;
  }
  return null;
}

export async function signMfaPendingPayload(payload: MfaPendingPayload): Promise<string> {
  return signPayload(payload);
}

export async function verifyMfaPendingCookie(value: string): Promise<MfaPendingPayload | null> {
  const decoded = await verifySignedValue(value);
  if (!decoded || typeof decoded !== "object") return null;
  const payload = decoded as Partial<MfaPendingPayload>;
  if (typeof payload.token !== "string" || !payload.token) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  // role is intentionally never checked/accepted here — this payload shape
  // has none, and must never be treated as satisfying SessionPayload.
  return { token: payload.token, exp: payload.exp };
}

export async function signEmployeeWorkspaceSelectionPayload(payload: EmployeeWorkspaceSelectionPayload): Promise<string> {
  return signPayload(payload);
}

// Returns null for anything malformed, unsigned, tampered, expired, or
// shaped wrong (including a genuine EmployeeWorkspaceSelectionPayload whose
// candidate list was tampered with down to fewer than two entries — a
// legitimately-created challenge never has fewer than two, since it only
// exists when more than one password match occurred). Callers treat null
// exactly like "no pending selection at all."
export async function verifyEmployeeWorkspaceSelectionCookie(value: string): Promise<EmployeeWorkspaceSelectionPayload | null> {
  const decoded = await verifySignedValue(value);
  if (!decoded || typeof decoded !== "object") return null;
  const payload = decoded as Partial<EmployeeWorkspaceSelectionPayload>;
  if (payload.purpose !== "employee_workspace_selection") return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (!Array.isArray(payload.candidates) || payload.candidates.length < 2) return null;

  for (const c of payload.candidates) {
    if (!c || typeof c !== "object") return null;
    const cand = c as Partial<EmployeeWorkspaceSelectionCandidate>;
    if (typeof cand.selectionId !== "string" || !cand.selectionId) return null;
    if (typeof cand.employeeId !== "string" || !cand.employeeId) return null;
    if (typeof cand.workspaceId !== "string" || !cand.workspaceId) return null;
  }

  return payload as EmployeeWorkspaceSelectionPayload;
}
