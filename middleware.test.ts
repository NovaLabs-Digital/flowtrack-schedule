// Phase 5.7D-R10-R2: behavioral tests for middleware.ts, exercising the
// REAL middleware() function against real NextRequest objects and
// real, correctly-signed session cookies (via lib/sessionCrypto.ts's own
// sign/verify -- no mock.module stand-in for the crypto layer, since
// proving the actual signature/shape validation matters here). Run with
// --experimental-test-module-mocks (see package.json).
process.env.SESSION_SECRET = "test-session-secret-middleware";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { signSessionPayload, newExpiry } from "./lib/sessionCrypto.ts";
import { middleware, config } from "./middleware.ts";

function reqFor(path: string, sessionCookieValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (sessionCookieValue) headers.cookie = `sft_session=${sessionCookieValue}`;
  return new NextRequest(`http://localhost${path}`, { headers });
}

async function ownerCookie(): Promise<string> {
  return signSessionPayload({
    role: "owner",
    workspaceId: "ws-1",
    authUserId: "auth-1",
    mfa: true,
    sessionEpoch: 1,
    exp: newExpiry(),
  });
}
async function employeeCookie(): Promise<string> {
  return signSessionPayload({ role: "employee", employeeId: "emp-1", workspaceId: "ws-1", exp: newExpiry() });
}
async function testerCookie(): Promise<string> {
  return signSessionPayload({ role: "tester", workspaceId: "ws-1", exp: newExpiry() });
}

function isRedirectTo(res: Response, path: string): boolean {
  const location = res.headers.get("location");
  return res.status >= 300 && res.status < 400 && !!location && new URL(location).pathname === path;
}

describe("middleware.ts -- matcher scope (Phase 5.7D-R10-R2 correction)", () => {
  // Phase 5.7D-R10-R2 correction: an earlier report assumed middleware
  // gates /mfa/enroll. It does not -- the matcher below only ever runs
  // this middleware for /dashboard/:path* and /schedule. Access control
  // for /mfa/enroll happens entirely inside app/api/auth/mfa/enroll/
  // route.ts's own getMfaPendingToken() check (see that route's own
  // route.test.ts), never at the middleware layer. This test exists so
  // that false premise can never be silently reintroduced.
  test("the matcher covers only /dashboard/:path* and /schedule -- NOT /mfa/enroll, /mfa/challenge, /login, or /signup", () => {
    assert.deepEqual(config.matcher, ["/dashboard/:path*", "/schedule"]);
  });
});

describe("middleware.ts -- /dashboard gating (real signed cookies, real middleware function)", () => {
  test("no session cookie at all -> redirects to /login", async () => {
    const res = await middleware(reqFor("/dashboard"));
    assert.ok(isRedirectTo(res, "/login"));
  });

  test("an invalid/garbage cookie value -> redirects to /login (treated as no session)", async () => {
    const res = await middleware(reqFor("/dashboard", "not-a-valid-signed-value"));
    assert.ok(isRedirectTo(res, "/login"));
  });

  test("a valid owner session -> allowed through (not redirected)", async () => {
    const res = await middleware(reqFor("/dashboard", await ownerCookie()));
    assert.ok(!isRedirectTo(res, "/login"));
    assert.ok(!isRedirectTo(res, "/schedule"));
  });

  test("a valid tester session -> allowed through", async () => {
    const res = await middleware(reqFor("/dashboard", await testerCookie()));
    assert.ok(!isRedirectTo(res, "/login"));
  });

  test("a valid employee session requesting /dashboard -> redirected to /schedule, never allowed through", async () => {
    const res = await middleware(reqFor("/dashboard", await employeeCookie()));
    assert.ok(isRedirectTo(res, "/schedule"));
  });

  test("a nested /dashboard/anything path is covered identically", async () => {
    const res = await middleware(reqFor("/dashboard/settings"));
    assert.ok(isRedirectTo(res, "/login"));
  });
});

describe("middleware.ts -- /schedule gating", () => {
  test("a valid owner session requesting /schedule -> redirected to /dashboard", async () => {
    const res = await middleware(reqFor("/schedule", await ownerCookie()));
    assert.ok(isRedirectTo(res, "/dashboard"));
  });

  test("a valid employee session requesting /schedule -> allowed through", async () => {
    const res = await middleware(reqFor("/schedule", await employeeCookie()));
    assert.ok(!isRedirectTo(res, "/login"));
    assert.ok(!isRedirectTo(res, "/dashboard"));
  });

  test("no session at all requesting /schedule -> redirected to /login", async () => {
    const res = await middleware(reqFor("/schedule"));
    assert.ok(isRedirectTo(res, "/login"));
  });

  test("a tester session requesting /schedule -> redirected to /login (tester is not employee)", async () => {
    const res = await middleware(reqFor("/schedule", await testerCookie()));
    assert.ok(isRedirectTo(res, "/login"));
  });
});
