// Phase 5.7D: focused tests for lib/signupProvisioning.ts. Exercises the
// real functions (including the provision_owner_workspace RPC call) against
// a fake Supabase admin client. No real Supabase/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let rpcCalls: Array<{ fn: string; args: unknown }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: "new-workspace-id", error: null };

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve(rpcResult);
      },
    },
  },
});

const { createPendingSignup, findOwnerMembership, provisionOwnerWorkspace, bumpSessionEpoch } = await import(
  "./signupProvisioning.ts"
);

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function resetRpc() {
  rpcCalls = [];
  rpcResult = { data: "new-workspace-id", error: null };
}

describe("createPendingSignup", () => {
  test("inserts exactly the five fields, normalized email included, no extra fields", async () => {
    resetFixtures({ pending_signups: [{ error: null }] });
    await createPendingSignup({
      authUserId: "user-1",
      email: "owner@example.com",
      companyName: "Acme",
      termsAcceptedAt: "2026-07-26T00:00:00.000Z",
      termsVersion: "v1",
    });
    const insertCall = currentFake.calls.find((c) => c.table === "pending_signups" && c.method === "insert");
    assert.deepEqual(insertCall!.args[0], {
      auth_user_id: "user-1",
      email: "owner@example.com",
      company_name: "Acme",
      terms_accepted_at: "2026-07-26T00:00:00.000Z",
      terms_version: "v1",
    });
  });

  test("throws on a database error rather than silently succeeding", async () => {
    resetFixtures({ pending_signups: [{ error: { message: "unique violation" } }] });
    await assert.rejects(() =>
      createPendingSignup({
        authUserId: "user-1",
        email: "owner@example.com",
        companyName: "Acme",
        termsAcceptedAt: "2026-07-26T00:00:00.000Z",
        termsVersion: "v1",
      })
    );
  });
});

describe("findOwnerMembership", () => {
  test("returns workspaceId/sessionEpoch when a membership exists", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: "ws-1", session_epoch: 4 } }] });
    const result = await findOwnerMembership("user-1");
    assert.deepEqual(result, { workspaceId: "ws-1", sessionEpoch: 4 });
  });

  test("returns null when no membership exists", async () => {
    resetFixtures({ workspace_memberships: [{ data: null }] });
    const result = await findOwnerMembership("user-1");
    assert.equal(result, null);
  });

  test("scopes strictly by profile_id and role='owner'", async () => {
    resetFixtures({ workspace_memberships: [{ data: null }] });
    await findOwnerMembership("user-42");
    const eqCalls = currentFake.calls.filter((c) => c.table === "workspace_memberships" && c.method === "eq");
    assert.ok(eqCalls.some((c) => c.args[0] === "profile_id" && c.args[1] === "user-42"));
    assert.ok(eqCalls.some((c) => c.args[0] === "role" && c.args[1] === "owner"));
  });
});

describe("provisionOwnerWorkspace", () => {
  test("invokes the provision_owner_workspace RPC with only the auth user id, and returns the workspace_id it produces", async () => {
    resetRpc();
    rpcResult = { data: "workspace-abc", error: null };
    const workspaceId = await provisionOwnerWorkspace("user-1");
    assert.equal(workspaceId, "workspace-abc");
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fn, "provision_owner_workspace");
    assert.deepEqual(rpcCalls[0].args, { p_auth_user_id: "user-1" });
  });

  test("throws on an RPC error rather than returning a falsy workspace id", async () => {
    resetRpc();
    rpcResult = { data: null, error: { message: "rpc failed" } };
    await assert.rejects(() => provisionOwnerWorkspace("user-1"));
  });
});

describe("bumpSessionEpoch", () => {
  test("increments the stored session_epoch by exactly one", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { session_epoch: 5 } }, { error: null }],
    });
    await bumpSessionEpoch("user-1");
    const updateCall = currentFake.calls.find((c) => c.table === "workspace_memberships" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { session_epoch: 6 });
  });

  test("is a no-op when no membership exists (nothing to bump)", async () => {
    resetFixtures({ workspace_memberships: [{ data: null }] });
    await bumpSessionEpoch("user-1");
    const updateCall = currentFake.calls.find((c) => c.table === "workspace_memberships" && c.method === "update");
    assert.equal(updateCall, undefined);
  });
});
