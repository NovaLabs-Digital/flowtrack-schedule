// Phase 5.7D: focused tests for lib/sessionEpoch.ts's requireCurrentOwnerSession
// -- the central fail-closed re-verification every owner-only route/page
// must call before touching business data. Exercises the real function
// against a fake "workspace_memberships" table. No real Supabase/network
// call is reachable. Run with --experimental-test-module-mocks (see
// package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

const { requireCurrentOwnerSession } = await import("./sessionEpoch.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

const AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const WORKSPACE_ID = "wwwwwwww-0000-0000-0000-000000000001";

describe("requireCurrentOwnerSession -- non-owner sessions are a complete no-op", () => {
  for (const session of [
    { role: "employee" as const, employeeId: "e1", workspaceId: WORKSPACE_ID },
    { role: "tester" as const, workspaceId: WORKSPACE_ID },
    { role: "none" as const },
  ]) {
    test(`${session.role} session resolves ok with zero workspace_memberships queries`, async () => {
      resetFixtures({});
      const result = await requireCurrentOwnerSession(session);
      assert.equal(result.ok, true);
      assert.equal(currentFake.calls.filter((c) => c.table === "workspace_memberships").length, 0);
    });
  }
});

describe("requireCurrentOwnerSession -- owner sessions are re-verified against workspace_memberships", () => {
  test("matching workspace_id and session_epoch resolves ok", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: WORKSPACE_ID, session_epoch: 3 } }],
    });
    const result = await requireCurrentOwnerSession({
      role: "owner",
      workspaceId: WORKSPACE_ID,
      authUserId: AUTH_USER_ID,
      sessionEpoch: 3,
    });
    assert.equal(result.ok, true);
  });

  test("queries workspace_memberships scoped by profile_id = authUserId and role = 'owner', never by any other value", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: WORKSPACE_ID, session_epoch: 1 } }],
    });
    await requireCurrentOwnerSession({ role: "owner", workspaceId: WORKSPACE_ID, authUserId: AUTH_USER_ID, sessionEpoch: 1 });
    const eqCalls = currentFake.calls.filter((c) => c.table === "workspace_memberships" && c.method === "eq");
    assert.ok(eqCalls.some((c) => c.args[0] === "profile_id" && c.args[1] === AUTH_USER_ID));
    assert.ok(eqCalls.some((c) => c.args[0] === "role" && c.args[1] === "owner"));
  });

  test("a database error fails closed to the service-unavailable 503 shape, never a silent pass or a lifecycle-style denial", async () => {
    resetFixtures({
      workspace_memberships: [{ error: { message: "simulated Supabase outage" } }],
    });
    const result = await requireCurrentOwnerSession({
      role: "owner",
      workspaceId: WORKSPACE_ID,
      authUserId: AUTH_USER_ID,
      sessionEpoch: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 503);
      const body = await result.response.json();
      assert.equal(body.code, "ENTITLEMENT_SERVICE_UNAVAILABLE");
    }
  });

  test("a missing membership row fails closed to a generic 403, never revealing why", async () => {
    resetFixtures({
      workspace_memberships: [{ data: null }],
    });
    const result = await requireCurrentOwnerSession({
      role: "owner",
      workspaceId: WORKSPACE_ID,
      authUserId: AUTH_USER_ID,
      sessionEpoch: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 403);
      const body = await result.response.json();
      assert.deepEqual(body, { error: "Unauthorized" });
    }
  });

  test("a workspace_id mismatch (session claims a different workspace than the membership row has) fails closed to a generic 403", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: "different-workspace-id", session_epoch: 1 } }],
    });
    const result = await requireCurrentOwnerSession({
      role: "owner",
      workspaceId: WORKSPACE_ID,
      authUserId: AUTH_USER_ID,
      sessionEpoch: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 403);
  });

  test("a session_epoch mismatch (the stored epoch has been bumped since this session was issued) fails closed to a generic 403", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: WORKSPACE_ID, session_epoch: 2 } }],
    });
    const result = await requireCurrentOwnerSession({
      role: "owner",
      workspaceId: WORKSPACE_ID,
      authUserId: AUTH_USER_ID,
      sessionEpoch: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 403);
  });

  test("the generic 403 denial never distinguishes missing-membership from workspace-mismatch from epoch-mismatch in its body", async () => {
    const scenarios = [
      { workspace_memberships: [{ data: null }] },
      { workspace_memberships: [{ data: { workspace_id: "different", session_epoch: 1 } }] },
      { workspace_memberships: [{ data: { workspace_id: WORKSPACE_ID, session_epoch: 99 } }] },
    ];
    const bodies = [];
    for (const fixture of scenarios) {
      resetFixtures(fixture);
      const result = await requireCurrentOwnerSession({
        role: "owner",
        workspaceId: WORKSPACE_ID,
        authUserId: AUTH_USER_ID,
        sessionEpoch: 1,
      });
      if (!result.ok) bodies.push(await result.response.json());
    }
    assert.equal(bodies.length, 3);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[1], bodies[2]);
  });
});
