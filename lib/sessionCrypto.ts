// HMAC signing/verification for the sft_session cookie. Uses Web Crypto
// (globalThis.crypto.subtle) rather than Node's `crypto` module so this file
// works unmodified in both API routes (nodejs runtime) and middleware.ts
// (edge runtime) — the two places that need to verify a session cookie.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type SessionRole = "owner" | "tester" | "employee";

export type SessionPayload =
  | { role: "owner"; exp: number }
  | { role: "tester"; exp: number }
  | { role: "employee"; employeeId: string; exp: number };

// SESSION_SECRET is the only key used to sign/verify sessions — it must
// never fall back to a database or provider secret (a leak of one must not
// also compromise the other). Missing it fails closed: signSessionPayload()
// throws (no session ever gets created) and verifySessionCookie() catches
// that throw and returns null (every cookie is treated as invalid), so the
// app is unusable rather than insecurely open until it's configured.
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

export function newExpiry(): number {
  return Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
}

export async function signSessionPayload(payload: SessionPayload): Promise<string> {
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await getKey();
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

// Returns null for anything malformed, unsigned, tampered, or expired —
// callers treat null exactly like "no session" (role: none).
export async function verifySessionCookie(value: string): Promise<SessionPayload | null> {
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

    const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64))) as SessionPayload;

    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.role === "employee") {
      return typeof payload.employeeId === "string" && payload.employeeId ? payload : null;
    }
    if (payload.role === "owner" || payload.role === "tester") return payload;
    return null;
  } catch {
    return null;
  }
}
