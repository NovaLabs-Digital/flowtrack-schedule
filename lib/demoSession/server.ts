// Guided Demo Session -- server-side identity and database access.
//
// Host: only the owner whose auth user id equals DEMO_HOST_AUTH_USER_ID
// (server-only setting), with a current owner session (session epoch). The
// visitor: the signed sft_demo_visitor cookie issued when they claimed the
// invitation. Either way, the database functions of migration 042 re-check
// the identity (and the session's lifecycle) on every call, under a row lock.
//
// Nothing in this module reads or writes real business data: the only tables
// touched are demo_sessions/demo_session_ops (through migration 042's
// functions) and, for the host's session-epoch check, the owner's own
// workspace_memberships row (lib/sessionEpoch.ts).
import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { requireCurrentOwnerSession } from "@/lib/sessionEpoch";
import { signDemoVisitorPayload, verifyDemoVisitorCookie } from "@/lib/sessionCrypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const DEMO_VISITOR_COOKIE = "sft_demo_visitor";
export const DEMO_VISITOR_COOKIE_PATH = "/api/demo-session";

export type DemoRole = "host" | "visitor";
export type DemoCaller = { p_role: DemoRole; p_host: string | null; p_visitor: string | null; p_epoch: number | null };

const FORBIDDEN = { error: "Unauthorized" } as const;

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

// The configured host, or null when unset (then nobody can host).
export function configuredHostId(): string | null {
  const value = process.env.DEMO_HOST_AUTH_USER_ID?.trim();
  return value ? value : null;
}

export async function requireDemoHost(): Promise<{ hostId: string } | { response: NextResponse }> {
  const session = await getSession();
  const hostId = configuredHostId();
  if (session.role !== "owner" || !hostId || session.authUserId !== hostId) {
    return { response: json(FORBIDDEN, 403) };
  }
  const current = await requireCurrentOwnerSession(session);
  if (!current.ok) return { response: current.response };
  return { hostId };
}

export async function readDemoVisitor(sessionId: string): Promise<{ visitorId: string; epoch: number } | null> {
  const store = await cookies();
  const payload = await verifyDemoVisitorCookie(store.get(DEMO_VISITOR_COOKIE)?.value ?? "");
  if (!payload || payload.sessionId !== sessionId) return null;
  return { visitorId: payload.visitorId, epoch: payload.epoch };
}

// Resolves who is calling, for the role the page says it is acting as.
export async function resolveCaller(sessionId: string, role: unknown): Promise<{ caller: DemoCaller } | { response: NextResponse }> {
  if (role === "host") {
    const host = await requireDemoHost();
    if ("response" in host) return host;
    return { caller: { p_role: "host", p_host: host.hostId, p_visitor: null, p_epoch: null } };
  }
  if (role === "visitor") {
    const visitor = await readDemoVisitor(sessionId);
    if (!visitor) return { response: json(FORBIDDEN, 403) };
    return { caller: { p_role: "visitor", p_host: null, p_visitor: visitor.visitorId, p_epoch: visitor.epoch } };
  }
  return { response: json({ error: "Invalid request" }, 400) };
}

export async function setVisitorCookie(res: NextResponse, sessionId: string, visitorId: string, epoch: number, expiresAtIso: string) {
  const exp = Math.floor(new Date(expiresAtIso).getTime() / 1000);
  const maxAge = Math.max(0, exp - Math.floor(Date.now() / 1000));
  const value = await signDemoVisitorPayload({ purpose: "demo_visitor", sessionId, visitorId, epoch, exp });
  res.cookies.set(DEMO_VISITOR_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: DEMO_VISITOR_COOKIE_PATH,
    maxAge,
  });
}

// 256-bit random invitation token; only its SHA-256 is stored.
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function newVisitorId(): string {
  return randomUUID();
}

export type DemoSessionView = {
  id: string;
  status: "live" | "ended";
  end_reason: string | null;
  expires_at: string;
  controller: DemoRole;
  control_gen: number;
  state_version: number;
  invite_pending: boolean;
  invite_expires_at: string | null;
  visitor_joined: boolean;
  visitor_online: boolean;
  visitor_display_name: string | null;
  host_online: boolean;
};
export type DemoRpcResult = {
  outcome: string;
  session?: DemoSessionView;
  state?: unknown;
  visitor_epoch?: number;
  result_version?: number;
  response_status?: number;
  response?: unknown;
};

// Database errors from a migration-042 function. `notInstalled` is true when
// the function (or table) does not exist yet -- i.e. the code is deployed
// before migration 042 is applied -- so callers can answer clearly (503)
// instead of failing with a generic 500.
export class DemoRpcError extends Error {
  readonly notInstalled: boolean;
  constructor(fn: string, code: string | undefined) {
    super(`DEMO_SESSION_RPC_ERROR ${fn}`);
    // PGRST202: PostgREST cannot find the function; 42883 undefined_function;
    // 42P01 undefined_table.
    this.notInstalled = code === "PGRST202" || code === "42883" || code === "42P01";
  }
}

export async function demoRpc(fn: string, args: Record<string, unknown>): Promise<DemoRpcResult> {
  const { data, error } = await supabaseAdmin.rpc(fn, args);
  if (error) throw new DemoRpcError(fn, (error as { code?: string }).code);
  return data as DemoRpcResult;
}

// Guided Demo Sessions are switched off until DEMO_HOST_AUTH_USER_ID is set:
// every session route then answers 404 without touching the database.
export function guidedDemoEnabled(): boolean {
  return configuredHostId() !== null;
}
export const NOT_AVAILABLE = { error: "Guided Demo Sessions are not available." } as const;
export const NOT_SET_UP = { error: "Guided Demo Sessions aren't set up yet." } as const;

// The response for an unexpected error in a session route.
export function errorResponse(e: unknown, tag: string): NextResponse {
  if (e instanceof DemoRpcError && e.notInstalled) {
    console.error(`${tag}_NOT_INSTALLED`);
    return json(NOT_SET_UP, 503);
  }
  console.error(tag);
  return json({ error: "Server error" }, 500);
}

// HTTP status for a non-ok outcome.
export function statusForOutcome(outcome: string): number {
  switch (outcome) {
    case "unauthorized": return 403;
    case "ended": return 410;
    case "invalid_input": return 400;
    case "invite_unavailable": return 404;
    default: return 409;
  }
}
