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
//
// Block 2C-1: rpcResponses is the identical FIFO-queue-per-name pattern,
// applied to .rpc(fnName, args) calls instead of .from(table) calls -- the
// activate_recurring_series Postgres function's own internal locking/
// validation logic is opaque to this fake (it runs entirely inside the SQL
// migration, proved by migrations/027a's own source-level tests, never by a
// live database here); route-level tests queue whatever outcome string the
// RPC would have returned and assert on rpcCalls (the exact fn name and
// args passed), exactly mirroring how `calls` already lets a test assert on
// a .from(table) call's exact arguments.
export interface FakeSupabaseRpcCall {
  fn: string;
  args: unknown;
}

export function createFakeSupabaseAdmin(
  responses: Record<string, FakeSupabaseFixture[]>,
  rpcResponses: Record<string, FakeSupabaseFixture[]> = {}
) {
  const calls: FakeSupabaseCall[] = [];
  const rpcCalls: FakeSupabaseRpcCall[] = [];
  const queues: Record<string, FakeSupabaseFixture[]> = {};
  for (const [table, list] of Object.entries(responses)) {
    queues[table] = [...list];
  }
  const rpcQueues: Record<string, FakeSupabaseFixture[]> = {};
  for (const [fn, list] of Object.entries(rpcResponses)) {
    rpcQueues[fn] = [...list];
  }

  function nextFixture(table: string): FakeSupabaseFixture {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`FAKE_SUPABASE_NO_QUEUED_RESPONSE for table "${table}" -- test fixture exhausted`);
    }
    return q.shift()!;
  }

  function nextRpcFixture(fn: string): FakeSupabaseFixture {
    const q = rpcQueues[fn];
    if (!q || q.length === 0) {
      throw new Error(`FAKE_SUPABASE_NO_QUEUED_RESPONSE for rpc "${fn}" -- test fixture exhausted`);
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
      neq: (...args: unknown[]) => { record("neq", args); return builder; },
      gt: (...args: unknown[]) => { record("gt", args); return builder; },
      gte: (...args: unknown[]) => { record("gte", args); return builder; },
      lt: (...args: unknown[]) => { record("lt", args); return builder; },
      lte: (...args: unknown[]) => { record("lte", args); return builder; },
      in: (...args: unknown[]) => { record("in", args); return builder; },
      // Phase 5.6E: added for app/api/clients/archived/route.ts's
      // .not("archived_at", "is", null) -- the first fixture-driven test
      // written against that route. Same no-op-filter shape as every other
      // chain method here: the fake doesn't actually filter the queued
      // fixture data, it only records the call and returns the builder.
      not: (...args: unknown[]) => { record("not", args); return builder; },
      order: (...args: unknown[]) => { record("order", args); return builder; },
      limit: (...args: unknown[]) => { record("limit", args); return builder; },
      is: (...args: unknown[]) => { record("is", args); return builder; },
      update: (...args: unknown[]) => { record("update", args); return builder; },
      insert: (...args: unknown[]) => { record("insert", args); return builder; },
      upsert: (...args: unknown[]) => { record("upsert", args); return builder; },
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
    rpc: (fn: string, args?: unknown) => {
      rpcCalls.push({ fn, args });
      const fixture = nextRpcFixture(fn);
      return Promise.resolve({ data: fixture.data ?? null, error: fixture.error ?? null });
    },
  };

  return { supabaseAdmin, calls, rpcCalls };
}

export function writeCalls(calls: FakeSupabaseCall[]): FakeSupabaseCall[] {
  return calls.filter((c) => WRITE_METHODS.has(c.method));
}

export const GENERIC_FORBIDDEN_BODY = { error: "Unauthorized" } as const;
export const SUBSCRIPTION_RESTRICTED_BODY = {
  error: "This action isn't available right now — visit Billing to restore full access.",
  code: "SUBSCRIPTION_RESTRICTED",
} as const;
// Phase 5.6F-R1: mirrors lib/entitlementServer.ts's own (private)
// SERVICE_UNAVAILABLE_BODY exactly -- the distinct 503 denial for a
// transient subscription-query failure (reason "query_error"), never the
// 403 SUBSCRIPTION_RESTRICTED body above.
export const SERVICE_UNAVAILABLE_BODY = {
  error: "We're having trouble verifying your account right now. Please try again shortly.",
  code: "ENTITLEMENT_SERVICE_UNAVAILABLE",
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
// Fake replacement for @/lib/notify's named exports, for use with
// mock.module("@/lib/notify", { namedExports: createFakeNotify(...).namedExports }).
// The REAL lib/notify.ts constructs a Twilio client at module-load time
// (new Stripe-style top-level side effect) which throws without real
// credentials, so it can never be imported (even transitively) during
// tests -- this is the "test-only import seam" contemplated for
// notification-capable routes. shouldSend/describeProviderError are
// faithful copies of the real (pure, dependency-free) logic; recordMessageSent
// routes through the SAME fake Supabase client passed in, so messages_sent
// writes show up in the ordinary call log (writeCalls/calls.filter(...))
// exactly like any other table; sendEmail/sendSms are call-tracking spies
// whose resolved value (success provider id, or a rejection to simulate a
// provider failure) is swappable per test via setSendEmailImpl/setSendSmsImpl.
export interface FakeNotifyEmailCall {
  to: string;
  subject: string;
  text: string;
  workspaceId: string;
  fromDisplayName?: string;
}
export interface FakeNotifySmsCall {
  to: string;
  body: string;
  workspaceId: string;
}

// Faithful copy of lib/notify.ts's sanitizeCompanyName (pure,
// dependency-free) -- the real module can't be imported here (see the
// Twilio-client-at-module-load comment above), so this mirrors its exact
// behavior rather than re-deriving it, matching shouldSend/
// describeProviderError's existing "faithful copy" convention below.
const FAKE_FALLBACK_COMPANY_NAME = "ScheduleFlowTrack";
export function fakeSanitizeCompanyName(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[\r\n\x00-\x1F\x7F<>]/g, "")
    .trim()
    .slice(0, 150);
  return cleaned || FAKE_FALLBACK_COMPANY_NAME;
}

export function createFakeNotify(supabaseAdminRef: { from: (table: string) => Record<string, unknown> }) {
  const emailCalls: FakeNotifyEmailCall[] = [];
  const smsCalls: FakeNotifySmsCall[] = [];
  let sendEmailImpl: (to: string, subject: string, text: string, workspaceId: string, fromDisplayName?: string) => Promise<string> =
    async () => "fake-email-provider-id";
  let sendSmsImpl: (to: string, body: string, workspaceId: string) => Promise<string> =
    async () => "fake-sms-provider-id";
  // Settable per-test, defaulting to the real fallback name -- deliberately
  // NOT routed through supabaseAdminRef's "company_settings" queue (unlike
  // recordMessageSent above): dozens of pre-existing tests across every
  // notification-sending route already reach this call without expecting an
  // extra queued company_settings fixture, and this keeps all of them
  // passing unchanged. The real getCompanyName's workspace-scoped Supabase
  // query and sanitization/fallback behavior is unit-tested directly and in
  // isolation in lib/notify.test.ts instead.
  let companyName = FAKE_FALLBACK_COMPANY_NAME;
  // Fails closed by default, matching the real getCompanyIdentity's
  // Boolean(undefined) === false behavior when nothing is configured --
  // existing tests that never call setBookingEnabled therefore exercise
  // the CTA-omitted path unless they explicitly opt in.
  let bookingEnabled = false;
  // Phase 5E: defaults to the same canonical NULL-fallback the real
  // getCompanyIdentity's effectiveTimezone() resolves to -- existing tests
  // that never call setTimezone therefore exercise the exact same
  // "workspace hasn't saved a Time Zone yet" behavior as before this field
  // existed, unless they explicitly opt into a different zone.
  let timezone = "America/New_York";

  const namedExports = {
    shouldSend: (channel: string | undefined, medium: "email" | "sms") => {
      if (!channel || channel === "none") return false;
      if (channel === "both") return true;
      return channel === medium;
    },
    describeProviderError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    recordMessageSent: async (row: unknown) => {
      const builder = supabaseAdminRef.from("messages_sent") as { insert: (row: unknown) => Promise<unknown> };
      await builder.insert(row);
    },
    sanitizeCompanyName: fakeSanitizeCompanyName,
    getCompanyName: async (_workspaceId: string) => companyName,
    getCompanyIdentity: async (_workspaceId: string) => ({ companyName, bookingEnabled, timezone }),
    sendEmail: async (to: string, subject: string, text: string, workspaceId: string, fromDisplayName?: string) => {
      emailCalls.push({ to, subject, text, workspaceId, fromDisplayName });
      return sendEmailImpl(to, subject, text, workspaceId, fromDisplayName);
    },
    sendSms: async (to: string, body: string, workspaceId: string) => {
      smsCalls.push({ to, body, workspaceId });
      return sendSmsImpl(to, body, workspaceId);
    },
  };

  return {
    namedExports,
    emailCalls,
    smsCalls,
    setSendEmailImpl: (fn: (to: string, subject: string, text: string, workspaceId: string, fromDisplayName?: string) => Promise<string>) => {
      sendEmailImpl = fn;
    },
    setSendSmsImpl: (fn: (to: string, body: string, workspaceId: string) => Promise<string>) => {
      sendSmsImpl = fn;
    },
    setCompanyName: (name: string) => {
      companyName = name;
    },
    setBookingEnabled: (value: boolean) => {
      bookingEnabled = value;
    },
    setTimezone: (value: string) => {
      timezone = value;
    },
  };
}

export function subscriptionRow(
  overrides: Partial<{
    billing_mode: "internal" | "stripe";
    stripe_status: string | null;
    trial_end: string | null;
    current_period_end: string | null;
    grace_until: string | null;
    cancel_at_period_end: boolean;
    canceled_at: string | null;
  }> = {}
) {
  return {
    billing_mode: "stripe" as const,
    stripe_status: "active",
    trial_end: null,
    current_period_end: null,
    grace_until: null,
    cancel_at_period_end: false,
    // Phase 5.6E: defaults to null (matches every pre-existing fixture that
    // doesn't override it). A "canceled" stripe_status with no canceled_at
    // resolves to the malformed_canceled_date state, not canceled_read_only
    // -- callers that specifically need the read-only/locked lifecycle must
    // pass an explicit canceled_at.
    canceled_at: null,
    ...overrides,
  };
}
