// Phase 5.7D: route-level tests for app/api/auth/logout-all/route.ts --
// "sign out all devices," the ONE action (besides password reset/change,
// MFA removal/replacement, and support recovery) that increments
// session_epoch. @/lib/session and @/lib/signupProvisioning are mocked
// in-process. No real Supabase/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeSessionNamedExports } from "../../../../lib/testSupport.ts";

let sessionToReturn: unknown = { role: "none" };
let bumpedAuthUserIds: string[] = [];

mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });
mock.module("@/lib/signupProvisioning", {
  namedExports: {
    bumpSessionEpoch: async (authUserId: string) => {
      bumpedAuthUserIds.push(authUserId);
    },
  },
});

const { POST } = await import("./route.ts");

const AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const WORKSPACE_ID = "wwwwwwww-0000-0000-0000-000000000001";

describe("POST /api/auth/logout-all", () => {
  test("an owner session bumps session_epoch for exactly that authUserId and clears the current cookie", async () => {
    bumpedAuthUserIds = [];
    sessionToReturn = { role: "owner", workspaceId: WORKSPACE_ID, authUserId: AUTH_USER_ID, sessionEpoch: 1 };
    const res = await POST();
    assert.equal(res.status, 200);
    assert.deepEqual(bumpedAuthUserIds, [AUTH_USER_ID]);
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("sft_session=;") || setCookieHeader.includes("sft_session=\""));
  });

  test("a non-owner (employee/tester/none) session is denied and never bumps the epoch", async () => {
    for (const session of [
      { role: "employee", employeeId: "e1", workspaceId: WORKSPACE_ID },
      { role: "tester", workspaceId: WORKSPACE_ID },
      { role: "none" },
    ]) {
      bumpedAuthUserIds = [];
      sessionToReturn = session;
      const res = await POST();
      assert.equal(res.status, 403, JSON.stringify(session));
      assert.deepEqual(bumpedAuthUserIds, []);
    }
  });
});
