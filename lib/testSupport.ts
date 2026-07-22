// Test-only support module (never imported by production code) for Phase
// 5.4E1's route-level tests. Provides a minimal fake Supabase query-builder
// (call-tracking, queued canned responses) and mock.module()-ready fakes
// for @/lib/session and @/lib/entitlementServer, so a route handler's
// exported POST/PATCH/DELETE function can be invoked directly with a real
// Request object while every dependency stays fully in-process -- no real
// Supabase, Stripe, or network call is reachable from a test that uses
// only these helpers.
import { NextResponse } from "next/server";

export interface FakeSupabaseCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface FakeSupabaseFixture {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

const WRITE_METHODS = new Set(["insert", "update", "delete", "upsert"]);

// Each table gets its own FIFO queue of canned {data,error,count} responses,
// consumed one per terminal call (.maybeSingle()/.single()/direct await).
// An exhausted queue throws loudly rather than returning a guessed default
// -- an unexpected extra query is a real signal something is wrong, not
// something to silently paper over.
export function createFakeSupabaseAdmin(responses: Record<string, FakeSupabaseFixture[]>) {
  const calls: FakeSupabaseCall[] = [];
  const queues: Record<string, FakeSupabaseFixture[]> = {};
  for (const [table, list] of Object.entries(responses)) {
    queues[table] = [...list];
  }

  function nextFixture(table: string): FakeSupabaseFixture {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`FAKE_SUPABASE_NO_QUEUED_RESPONSE for table "${table}" -- test fixture exhausted`);
    }
    return q.shift()!;
  }

  function makeBuilder(table: string) {
    const resolve = () => {
      const fixture = nextFixture(table);
      return Promise.resolve({ data: fixture.data ?? null, error: fixture.error ?? null, count: fixture.count ?? null });
    };
    const record = (method: string, args: unknown[]) => calls.push({ table, method, args });
    const builder: Record<string, unknown> = {
      select: (...args: unknown[]) => { record("select", args); return builder; },
      eq: (...args: unknown[]) => { record("eq", args); return builder; },
      order: (...args: unknown[]) => { record("order", args); return builder; },
      limit: (...args: unknown[]) => { record("limit", args); return builder; },
      is: (...args: unknown[]) => { record("is", args); return builder; },
      update: (...args: unknown[]) => { record("update", args); return builder; },
      insert: (...args: unknown[]) => { record("insert", args); return builder; },
      delete: (...args: unknown[]) => { record("delete", args); return builder; },
      maybeSingle: () => { record("maybeSingle", []); return resolve(); },
      single: () => { record("single", []); return resolve(); },
      then: (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) => resolve().then(onFulfilled, onRejected),
    };
    return builder;
  }

  const supabaseAdmin = {
    from: (table: string) => {
      calls.push({ table, method: "from", args: [] });
      return makeBuilder(table);
    },
  };

  return { supabaseAdmin, calls };
}

export function writeCalls(calls: FakeSupabaseCall[]): FakeSupabaseCall[] {
  return calls.filter((c) => WRITE_METHODS.has(c.method));
}

export const GENERIC_FORBIDDEN_BODY = { error: "Unauthorized" } as const;
export const SUBSCRIPTION_RESTRICTED_BODY = {
  error: "This action isn't available right now — visit Billing to restore full access.",
  code: "SUBSCRIPTION_RESTRICTED",
} as const;

// Faithful, minimal re-implementations of lib/session.ts's requireRole/
// requireOwner/assertWorkspace (pure logic, no I/O in the real versions
// either) so mock.module("@/lib/session", ...) can replace getSession
// (which needs a real request-scoped cookie store, hence must be mocked)
// while these three behave identically to production.
export function fakeSessionNamedExports(getSessionImpl: () => Promise<unknown>) {
  return {
    getSession: getSessionImpl,
    requireRole: (session: { role: string }, allowed: string[]) =>
      allowed.includes(session.role) ? null : NextResponse.json(GENERIC_FORBIDDEN_BODY, { status: 403 }),
    requireOwner: (session: { role: string }) =>
      session.role === "owner" ? null : NextResponse.json(GENERIC_FORBIDDEN_BODY, { status: 403 }),
    assertWorkspace: (session: { role: string }) => {
      if (session.role === "none") throw new Error("assertWorkspace called on an unauthenticated session");
    },
  };
}

export function deniedCapabilityResponse(): NextResponse {
  return NextResponse.json(SUBSCRIPTION_RESTRICTED_BODY, { status: 403 });
}

// Raw "subscriptions" table row shape, exactly as lib/entitlementServer.ts's
// fetchEntitlementForWorkspace expects to read it (see SubscriptionRow
// there). Route-level tests queue one of these as the FIRST "subscriptions"
// table fixture so the REAL requireCapability() / fetchEntitlementForWorkspace()
// / resolveWorkspaceEntitlement() chain runs unmocked, end to end, against
// the fake Supabase client -- proving actual production entitlement logic
// gates the route, not a stand-in.
export function subscriptionRow(
  overrides: Partial<{
    billing_mode: "internal" | "stripe";
    stripe_status: string | null;
    trial_end: string | null;
    current_period_end: string | null;
    grace_until: string | null;
    cancel_at_period_end: boolean;
  }> = {}
) {
  return {
    billing_mode: "stripe" as const,
    stripe_status: "active",
    trial_end: null,
    current_period_end: null,
    grace_until: null,
    cancel_at_period_end: false,
    ...overrides,
  };
}
