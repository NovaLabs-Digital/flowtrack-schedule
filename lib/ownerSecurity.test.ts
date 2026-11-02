// Migration 045: optional two-step sign-in and recovery codes.
//   * lib/ownerSecurity.ts's pure rules and recovery-code helpers;
//   * app/api/auth/security/route.ts (Settings > Sign-in Security: status,
//     and starting a change after the password is checked again);
//   * app/api/auth/mfa/recover/route.ts (lost authenticator).
// The routes run against one stateful fake of the database functions
// (lock / finish / single-use codes, with the same semantics migration 045
// implements -- proven against real PostgreSQL in
// test-db/owner_security_045.test.ts) and of Supabase Auth's authenticators.
// No real Supabase/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  signInStep,
  twoStepStatus,
  needsSecondStep,
  lockHolderFor,
} from "./ownerSecurity.ts";

const OWNER = "aaaaaaaa-0000-0000-0000-00000000owna";
const EMAIL = "owner@example.test";
const PASSWORD = "correct horse battery";

// ---------- the fake world ----------
type Pending = { token: string; authUserId: string; factorId: string | null; purpose: string; enrolled: boolean; recovered: boolean; attemptCount: number; supabaseAccessToken: string; supabaseRefreshToken: string };
const world = {
  factors: [] as Array<{ id: string; status: string }>,
  required: true,
  codes: new Map<string, boolean>(), // hash -> used
  lock: null as string | null,
  pending: new Map<string, Pending>(),
  session: { role: "owner", workspaceId: "ws-1", authUserId: OWNER, sessionEpoch: 1, mfa: true } as Record<string, unknown>,
  sessionCurrent: true,
  rateLimitKeys: [] as string[],
  limited: new Set<string>(),
  emails: [] as string[],
  deleteFails: false,
  signIns: 0,
  seq: 0,
  // Fault injection for the partial-failure tests: fail the Nth database
  // finish from now (0 = none), or every recovery-code use.
  epoch: 1,
  finishCalls: 0,
  failFinishAt: 0,
  failConsume: false,
};
function reset() {
  world.factors = [{ id: "factor-1", status: "verified" }];
  world.required = true;
  world.codes = new Map();
  world.lock = null;
  world.pending = new Map();
  world.session = { role: "owner", workspaceId: "ws-1", authUserId: OWNER, sessionEpoch: 1, mfa: true };
  world.sessionCurrent = true;
  world.rateLimitKeys = [];
  world.limited = new Set();
  world.emails = [];
  world.deleteFails = false;
  world.signIns = 0;
  world.epoch = 1;
  world.finishCalls = 0;
  world.failFinishAt = 0;
  world.failConsume = false;
}
const state = () => ({
  required: world.required,
  codesTotal: world.codes.size,
  codesUnused: [...world.codes.values()].filter((used) => !used).length,
});
const tick = () => new Promise((r) => setImmediate(r));

let currentPendingToken: string | null = null;
// Concurrent requests: each takes the next queued pending token, in the
// order the requests reach that point.
const pendingQueue: string[] = [];
let lastSetPendingToken: string | null = null;

mock.module("@/lib/session", {
  namedExports: {
    getSession: async () => world.session,
    requireOwner: (s: { role: string }) => (s.role === "owner" ? null : new Response(null, { status: 401 })),
    setMfaPendingCookie: async (_res: unknown, token: string) => {
      lastSetPendingToken = token;
    },
    getMfaPendingToken: async () => (pendingQueue.length ? pendingQueue.shift()! : currentPendingToken),
    clearMfaPendingCookie: () => {},
    createOwnerSessionCookieValue: async (p: { sessionEpoch: number }) => {
      world.session = { ...world.session, sessionEpoch: p.sessionEpoch };
      return "signed";
    },
    setOwnerSessionCookie: () => {},
  },
});
mock.module("@/lib/sessionEpoch", {
  namedExports: {
    requireCurrentOwnerSession: async () =>
      world.sessionCurrent ? { ok: true } : { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 403 }) },
  },
});
mock.module("@/lib/durableRateLimit", {
  namedExports: {
    checkAndRecordRateLimit: async (bucket: string, key: string) => {
      world.rateLimitKeys.push(`${bucket}:${key}`);
      return { limited: world.limited.has(bucket) };
    },
  },
});
mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({
      auth: {
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          await tick();
          if (email !== EMAIL || password !== PASSWORD) return { data: { user: null, session: null }, error: { message: "invalid" } };
          world.signIns++;
          return { data: { user: { id: OWNER }, session: { access_token: `at-${world.signIns}`, refresh_token: `rt-${world.signIns}` } }, error: null };
        },
        mfa: { listFactors: async () => ({ data: { totp: world.factors }, error: null }) },
      },
    }),
    // The verify route's code check: "123456" is the correct code; verifying
    // a newly set-up authenticator makes it verified (as Supabase Auth does).
    createScopedAuthClient: async () => ({
      auth: {
        mfa: {
          listFactors: async () => ({ data: { totp: world.factors }, error: null }),
          challenge: async () => ({ data: { id: "challenge" }, error: null }),
          verify: async ({ factorId, code }: { factorId: string; code: string }) => {
            const f = world.factors.find((x) => x.id === factorId);
            if (!f || code !== "123456") return { data: null, error: { message: "invalid" } };
            f.status = "verified";
            return { data: {}, error: null };
          },
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2" } }),
        },
      },
    }),
  },
});
mock.module("@/lib/signupProvisioning", {
  namedExports: {
    findOwnerMembership: async () => ({ workspaceId: "ws-1", sessionEpoch: world.epoch }),
    bumpSessionEpoch: async () => {
      world.epoch++;
    },
  },
});
mock.module("@/lib/mfaPending", {
  namedExports: {
    MFA_MAX_ATTEMPTS: 5,
    createPendingMfaChallenge: async (p: { authUserId: string; supabaseAccessToken: string; supabaseRefreshToken: string; factorId?: string | null; purpose?: string }) => {
      const token = `pending-${++world.seq}`;
      world.pending.set(token, {
        token,
        authUserId: p.authUserId,
        factorId: p.factorId ?? null,
        purpose: p.purpose ?? "login",
        enrolled: false,
        recovered: false,
        attemptCount: 0,
        supabaseAccessToken: p.supabaseAccessToken,
        supabaseRefreshToken: p.supabaseRefreshToken,
      });
      return token;
    },
    getPendingMfaChallenge: async (token: string) => world.pending.get(token) ?? null,
    consumePendingMfaChallenge: async (token: string) => {
      const row = world.pending.get(token) ?? null;
      world.pending.delete(token);
      return row;
    },
    recordFailedMfaAttempt: async (token: string) => {
      const row = world.pending.get(token);
      if (!row) return 5;
      row.attemptCount++;
      return row.attemptCount;
    },
    setPendingRecovered: async (token: string, at: string, rt: string) => {
      const row = world.pending.get(token)!;
      Object.assign(row, { recovered: true, factorId: null, supabaseAccessToken: at, supabaseRefreshToken: rt });
    },
  },
});
mock.module("@/lib/ownerSecurityStore", {
  namedExports: {
    getOwnerSecurityState: async () => state(),
    getOwnerEmail: async (id: string) => (id === OWNER ? EMAIL : null),
    listAuthenticators: async () => world.factors.map((f) => ({ id: f.id, verified: f.status === "verified" })),
    lockOwnerSecurity: async (_u: string, holder: string) => {
      await tick();
      if (world.lock && world.lock !== holder) return false;
      world.lock = holder;
      return true;
    },
    unlockOwnerSecurity: async (_u: string, holder: string) => {
      if (world.lock === holder) world.lock = null;
    },
    recoveryCodeIsUnused: async (_u: string, hash: string) => world.codes.get(hash) === false,
    // Migration 045's owner_security_finish, as proven on real PostgreSQL:
    // only the lock holder; setting, codes and epoch together; lock released.
    finishOwnerSecurity: async (_u: string, holder: string, required: boolean | null, hashes: string[] | null) => {
      await tick();
      world.finishCalls++;
      if (world.finishCalls === world.failFinishAt) throw new Error("OWNER_SECURITY_FINISH_ERROR");
      if (world.lock !== holder) return null;
      world.epoch++;
      if (hashes !== null) world.codes = new Map(hashes.map((h) => [h, false]));
      if (required !== null) world.required = required;
      world.lock = null;
      return world.epoch;
    },
    consumeRecoveryCode: async (_u: string, hash: string) => {
      await tick();
      if (world.failConsume) throw new Error("OWNER_RECOVERY_CODE_ERROR");
      if (world.codes.get(hash) !== false) return false;
      world.codes.set(hash, true);
      return true;
    },
    removeAllAuthenticators: async () => {
      await tick();
      if (world.deleteFails) throw new Error("OWNER_FACTOR_DELETE_ERROR");
      world.factors = [];
    },
  },
});
mock.module("@/lib/securityEmail", {
  namedExports: {
    sendAccountSecurityEmail: async (_u: string, subject: string) => {
      world.emails.push(subject);
      return true;
    },
    RECOVERY_CODE_USED_EMAIL: { subject: "A recovery code was used on your account", text: "..." },
    TWO_STEP_OFF_EMAIL: { subject: "Two-step sign-in was turned off", text: "..." },
  },
});

const security = await import("../app/api/auth/security/route.ts");
const recover = await import("../app/api/auth/mfa/recover/route.ts");
const verify = await import("../app/api/auth/mfa/verify/route.ts");

const post = (body: unknown) =>
  security.POST(new Request("http://localhost/api/auth/security", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const recoverWith = (token: string | null, body: unknown, ip = "198.51.100.7") => {
  currentPendingToken = token;
  return recover.POST(
    new Request("http://localhost/api/auth/mfa/recover", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) })
  );
};
function giveCodes(n = 10) {
  const fresh = generateRecoveryCodes(n);
  world.codes = new Map(fresh.hashes.map((h) => [h, false]));
  return fresh.codes;
}
async function loginPending() {
  const token = `pending-${++world.seq}`;
  world.pending.set(token, { token, authUserId: OWNER, factorId: null, purpose: "login", enrolled: false, recovered: false, attemptCount: 0, supabaseAccessToken: "at-0", supabaseRefreshToken: "rt-0" });
  return token;
}

// ---------- pure rules ----------
describe("the sign-in rule: stricter on any doubt", () => {
  test("a code is needed when the setting is on or any verified authenticator exists", () => {
    assert.equal(needsSecondStep({ required: true }, 0), true);
    assert.equal(needsSecondStep({ required: false }, 1), true);
    assert.equal(needsSecondStep({ required: false }, 0), false);
  });

  test("what sign-in asks for", () => {
    const s = (required: boolean, codesTotal: number) => ({ required, codesTotal, codesUnused: codesTotal });
    assert.equal(signInStep(s(true, 0), 1), "challenge");
    assert.equal(signInStep(s(false, 0), 1), "challenge");
    assert.equal(signInStep(s(true, 0), 0), "enroll");
    assert.equal(signInStep(s(true, 10), 0), "recover");
    assert.equal(signInStep(s(false, 0), 0), "password");
  });

  test("what Settings shows", () => {
    assert.equal(twoStepStatus({ required: true }, 1), "on");
    assert.equal(twoStepStatus({ required: false }, 1), "on");
    assert.equal(twoStepStatus({ required: true }, 0), "needs_setup");
    assert.equal(twoStepStatus({ required: false }, 0), "off");
  });
});

describe("recovery codes", () => {
  test("10 distinct codes of 16 characters from a 32-symbol alphabet (80 bits each), shown in groups of four", () => {
    const { codes, hashes } = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    assert.equal(new Set(hashes).size, 10);
    for (const c of codes) assert.match(c, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });

  test("only hashes are stored: never the code, and the same code always gives the same hash", () => {
    const { codes, hashes } = generateRecoveryCodes(1);
    const normalized = normalizeRecoveryCode(codes[0])!;
    assert.equal(hashes[0], hashRecoveryCode(normalized));
    assert.match(hashes[0], /^[0-9a-f]{64}$/);
    assert.ok(!hashes[0].includes(normalized.toLowerCase()));
  });

  test("typed codes are accepted in any case, with spaces or dashes; anything else is not a code", () => {
    const { codes } = generateRecoveryCodes(1);
    const raw = codes[0].replace(/-/g, "");
    assert.equal(normalizeRecoveryCode(codes[0].toLowerCase()), raw);
    assert.equal(normalizeRecoveryCode(` ${raw.slice(0, 8)} ${raw.slice(8)} `), raw);
    for (const bad of ["", "SHORT", `${raw}X`, raw.replace(/./, "0"), raw.replace(/./, "I"), 1234, null]) {
      assert.equal(normalizeRecoveryCode(bad), null, String(bad));
    }
  });

  test("the lock holder is derived from the pending token, never the token itself", () => {
    assert.match(lockHolderFor("pending-token"), /^[0-9a-f]{64}$/);
    assert.notEqual(lockHolderFor("a"), lockHolderFor("b"));
  });
});

// ---------- Settings > Sign-in Security ----------
describe("GET /api/auth/security", () => {
  test("reports on / off / needs setup and unused codes", async () => {
    reset();
    giveCodes(10);
    world.codes.set([...world.codes.keys()][0], true);
    assert.deepEqual(await (await security.GET()).json(), { status: "on", codesUnused: 9, codesTotal: 10 });
    world.factors = [];
    world.required = false;
    assert.equal((await (await security.GET()).json()).status, "off");
    world.required = true;
    assert.equal((await (await security.GET()).json()).status, "needs_setup");
  });

  test("a revoked (stale) session sees nothing", async () => {
    reset();
    world.sessionCurrent = false;
    assert.equal((await security.GET()).status, 403);
  });
});

describe("POST /api/auth/security -- every change re-checks the password", () => {
  test("a wrong password starts nothing; attempts are limited per owner, not per network", async () => {
    reset();
    const res = await post({ action: "disable", password: "wrong" });
    assert.equal(res.status, 401);
    assert.equal(world.pending.size, 0);
    assert.equal(world.lock, null);
    assert.deepEqual(world.rateLimitKeys, [`securityCheck:${OWNER}`]);
    world.limited.add("securityCheck");
    assert.equal((await post({ action: "disable", password: PASSWORD })).status, 429);
  });

  test("a revoked session cannot even try the password", async () => {
    reset();
    world.sessionCurrent = false;
    assert.equal((await post({ action: "disable", password: PASSWORD })).status, 403);
    assert.equal(world.signIns, 0);
  });

  test("turning off: the change lock is taken, then the authenticator's code is asked for", async () => {
    reset();
    const res = await post({ action: "disable", password: PASSWORD });
    const body = await res.json();
    assert.deepEqual(body, { ok: true, next: "challenge", factorIds: ["factor-1"] });
    const pending = world.pending.get(lastSetPendingToken!)!;
    assert.equal(pending.purpose, "disable");
    assert.equal(pending.factorId, "factor-1");
    assert.equal(world.lock, lockHolderFor(lastSetPendingToken!));
  });

  test("turning on: only while off; continues to authenticator setup (the lock is taken there)", async () => {
    reset();
    assert.equal((await post({ action: "enable", password: PASSWORD })).status, 409);
    world.factors = [];
    world.required = false;
    const body = await (await post({ action: "enable", password: PASSWORD })).json();
    assert.equal(body.next, "enroll");
    assert.equal(world.pending.get(lastSetPendingToken!)!.purpose, "enable");
    assert.equal(world.lock, null);
  });

  test("turning off or new codes without an authenticator set up is refused", async () => {
    reset();
    world.factors = [];
    const res = await post({ action: "disable", password: PASSWORD });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /isn't set up yet/);
    world.required = false;
    assert.equal((await post({ action: "codes", password: PASSWORD })).status, 409);
  });

  test("two changes started at once: exactly one proceeds; the other is refused and leaves no pending verification behind", async () => {
    reset();
    const [a, b] = await Promise.all([post({ action: "disable", password: PASSWORD }), post({ action: "codes", password: PASSWORD })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(world.pending.size, 1);
  });

  test("an unknown action is refused", async () => {
    reset();
    assert.equal((await post({ action: "everything", password: PASSWORD })).status, 400);
  });
});

describe("DELETE /api/auth/security -- cancelling a change", () => {
  test("releases the lock and uses up the pending verification, so another change can start right away", async () => {
    reset();
    await post({ action: "disable", password: PASSWORD });
    const token = lastSetPendingToken!;
    assert.ok(world.lock);
    currentPendingToken = token;
    assert.equal((await security.DELETE()).status, 200);
    assert.equal(world.lock, null);
    assert.equal(world.pending.has(token), false);
    assert.equal((await post({ action: "codes", password: PASSWORD })).status, 200);
  });

  test("never touches a sign-in in progress", async () => {
    reset();
    const token = await loginPending();
    world.lock = lockHolderFor(token);
    currentPendingToken = token;
    await security.DELETE();
    assert.equal(world.pending.has(token), true);
    assert.equal(world.lock, lockHolderFor(token));
  });

  test("a revoked session cancels nothing", async () => {
    reset();
    await post({ action: "disable", password: PASSWORD });
    world.sessionCurrent = false;
    currentPendingToken = lastSetPendingToken;
    assert.equal((await security.DELETE()).status, 403);
    assert.ok(world.lock);
  });
});

// ---------- lost authenticator ----------
describe("POST /api/auth/mfa/recover", () => {
  test("a valid unused code and the password: authenticator removed, code used once, fresh setup session, email sent", async () => {
    reset();
    const codes = giveCodes();
    const token = await loginPending();
    const res = await recoverWith(token, { code: codes[3].toLowerCase(), password: PASSWORD });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, next: "enroll" });
    assert.deepEqual(world.factors, []);
    assert.equal(state().codesUnused, 9);
    const pending = world.pending.get(token)!;
    assert.equal(pending.recovered, true);
    assert.notEqual(pending.supabaseAccessToken, "at-0", "the old session ended with the authenticator; a fresh one replaces it");
    assert.equal(world.required, true, "two-step stays on");
    assert.deepEqual(world.emails, ["A recovery code was used on your account"]);
    assert.equal(world.lock, lockHolderFor(token), "the change stays locked until the new authenticator is verified");
  });

  test("a used code never works again", async () => {
    reset();
    const codes = giveCodes();
    await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD });
    world.factors = [{ id: "new", status: "verified" }];
    world.lock = null;
    const again = await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD });
    assert.equal(again.status, 401);
    assert.deepEqual(world.factors, [{ id: "new", status: "verified" }]);
  });

  test("the same code in two sign-ins at once: exactly one succeeds", async () => {
    reset();
    const codes = giveCodes();
    pendingQueue.push(await loginPending(), await loginPending());
    currentPendingToken = null;
    const call = () =>
      recover.POST(
        new Request("http://localhost/api/auth/mfa/recover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: codes[5], password: PASSWORD }),
        })
      );
    const results = (await Promise.all([call(), call()])).map((r) => r.status).sort((a, b) => a - b);
    assert.ok(results[0] === 200 && results[1] !== 200, `exactly one succeeds (got ${results})`);
    assert.equal(state().codesUnused, 9);
  });

  test("a wrong password (with a valid code) changes nothing: code unused, authenticator kept", async () => {
    reset();
    const codes = giveCodes();
    const res = await recoverWith(await loginPending(), { code: codes[1], password: "wrong" });
    assert.equal(res.status, 401);
    assert.equal(state().codesUnused, 10);
    assert.equal(world.factors.length, 1);
    assert.deepEqual(world.emails, []);
  });

  test("wrong codes are counted; the fifth ends the sign-in attempt", async () => {
    reset();
    giveCodes();
    const token = await loginPending();
    for (let i = 0; i < 4; i++) assert.equal((await recoverWith(token, { code: "2222-2222-2222-2222", password: PASSWORD })).status, 401);
    assert.equal((await recoverWith(token, { code: "2222-2222-2222-2222", password: PASSWORD })).status, 401);
    assert.equal(world.pending.has(token), false);
    assert.equal(world.factors.length, 1);
  });

  test("attempts are limited per network and per owner", async () => {
    reset();
    const codes = giveCodes();
    await recoverWith(await loginPending(), { code: "2222-2222-2222-2222", password: PASSWORD });
    assert.ok(world.rateLimitKeys.includes(`recoveryCode:${OWNER}`));
    assert.ok(world.rateLimitKeys.includes("mfaVerify:198.51.100.7"));
    world.limited.add("recoveryCode");
    assert.equal((await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD })).status, 429);
    assert.equal(state().codesUnused, 10);
  });

  test("if removing the authenticator fails, the code still works and nothing else changed", async () => {
    reset();
    const codes = giveCodes();
    world.deleteFails = true;
    const res = await recoverWith(await loginPending(), { code: codes[2], password: PASSWORD });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /recovery code still works/);
    assert.equal(state().codesUnused, 10);
    assert.equal(world.lock, null);
  });

  test("no unused codes left: refused, pointing to support", async () => {
    reset();
    const codes = giveCodes(1);
    world.codes.set([...world.codes.keys()][0], true);
    const res = await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /contact support/);
  });

  test("only during sign-in: never from a Settings change, an unknown, or a missing pending verification", async () => {
    reset();
    const codes = giveCodes();
    const token = await loginPending();
    world.pending.get(token)!.purpose = "disable";
    assert.equal((await recoverWith(token, { code: codes[0], password: PASSWORD })).status, 401);
    assert.equal((await recoverWith(null, { code: codes[0], password: PASSWORD })).status, 401);
    assert.equal((await recoverWith("nope", { code: codes[0], password: PASSWORD })).status, 401);
    assert.equal(state().codesUnused, 10);
  });

  test("another security change in progress: refused before anything is removed", async () => {
    reset();
    const codes = giveCodes();
    world.lock = "someone-else";
    const res = await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD });
    assert.equal(res.status, 409);
    assert.equal(world.factors.length, 1);
    assert.equal(state().codesUnused, 10);
  });
});

// ---------- partial failures: what is left, and that a retry recovers ----------
// After each injected failure: what the next sign-in asks for (never weaker
// than before), whether the owner can still get in (an authenticator or an
// unused recovery code exists while two-step is on), and that simply
// retrying finishes the job.
describe("partial failures between the authenticator and the database", () => {
  const verified = () => world.factors.filter((f) => f.status === "verified").length;
  const nextSignIn = () => signInStep(state(), verified());
  const canGetIn = () => !world.required || verified() > 0 || state().codesUnused > 0;
  const verifyCode = (token: string, code = "123456") => {
    currentPendingToken = token;
    return verify.POST(
      new Request("http://localhost/api/auth/mfa/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
    );
  };
  async function turnOff() {
    assert.equal((await post({ action: "disable", password: PASSWORD })).status, 200);
    world.finishCalls = 0;
    return verifyCode(lastSetPendingToken!);
  }
  function onWithCodes() {
    reset();
    return giveCodes();
  }
  function pendingFor(purpose: string, factorId: string | null, enrolled: boolean) {
    const token = `pending-${++world.seq}`;
    world.pending.set(token, { token, authUserId: OWNER, factorId, purpose, enrolled, recovered: false, attemptCount: 0, supabaseAccessToken: "a", supabaseRefreshToken: "r" });
    return token;
  }

  test("turning off, the database step fails (before any authenticator change): nothing changed; retry turns it off", async () => {
    onWithCodes();
    world.failFinishAt = 1;
    assert.equal((await turnOff()).status, 409);
    assert.equal(nextSignIn(), "challenge");
    assert.deepEqual([world.factors.length, state().codesUnused, world.lock], [1, 10, null]);
    world.failFinishAt = 0;
    assert.equal((await turnOff()).status, 200);
    assert.equal(nextSignIn(), "password");
  });

  test("turning off, the database changed but removing the authenticator fails: still asks for its code, recovery codes still work, retry finishes", async () => {
    onWithCodes();
    world.deleteFails = true;
    const res = await turnOff();
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /still on.*recovery codes still work/);
    assert.equal(world.required, false, "the setting did change");
    assert.equal(nextSignIn(), "challenge", "the remaining authenticator keeps sign-in strict");
    assert.equal(state().codesUnused, 10, "codes kept: losing the phone now is still recoverable");
    assert.ok(canGetIn());
    assert.equal(world.lock, null, "released, so the owner can retry at once");
    assert.deepEqual(world.emails, [], "no 'turned off' email for a turn-off that didn't finish");
    world.deleteFails = false;
    assert.equal((await turnOff()).status, 200);
    assert.equal(nextSignIn(), "password");
    assert.equal(state().codesTotal, 0);
    assert.deepEqual(world.emails, ["Two-step sign-in was turned off"]);
  });

  test("turning off, the authenticator removed but clearing the codes fails: off as intended; left-over codes don't affect sign-in", async () => {
    onWithCodes();
    world.failFinishAt = 2; // step 3, after the authenticator is gone
    assert.equal((await turnOff()).status, 200);
    assert.deepEqual([world.factors.length, world.required], [0, false]);
    assert.equal(nextSignIn(), "password");
    assert.ok(state().codesTotal > 0, "left over");
  });

  test("turning on, the authenticator verified but saving fails: sign-in asks for a code, other devices still signed out, 'new recovery codes' repairs it", async () => {
    reset();
    world.required = false;
    world.factors = [{ id: "new", status: "unverified" }];
    const token = pendingFor("enable", "new", true);
    world.lock = lockHolderFor(token);
    world.failFinishAt = 1;
    const epochBefore = world.epoch;
    const res = await verifyCode(token);
    assert.equal(res.status, 200);
    assert.match((await res.json()).notice, /recovery codes couldn't be created/);
    assert.equal(nextSignIn(), "challenge", "the verified authenticator keeps sign-in strict though the setting still says off");
    assert.ok(world.epoch > epochBefore, "other devices signed out anyway");
    assert.equal(world.lock, null);
    world.failFinishAt = 0;
    assert.equal((await post({ action: "codes", password: PASSWORD })).status, 200);
    assert.equal((await verifyCode(lastSetPendingToken!)).status, 200);
    assert.deepEqual([world.required, state().codesUnused], [true, 10]);
  });

  test("recovery, the authenticator removed but using up the code fails: never password-only, the code still works, retry completes", async () => {
    const codes = onWithCodes();
    world.failConsume = true;
    assert.equal((await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD })).status, 500);
    assert.equal(world.factors.length, 0);
    assert.equal(nextSignIn(), "recover", "setting on, no authenticator: a recovery code is required");
    assert.equal(state().codesUnused, 10, "the code wasn't used up");
    world.failConsume = false;
    world.lock = null; // that attempt's lock expires
    assert.equal((await recoverWith(await loginPending(), { code: codes[0], password: PASSWORD })).status, 200);
    assert.equal(state().codesUnused, 9);
  });

  test("recovery, the new authenticator verified but saving new codes fails: the old unused codes still work", async () => {
    const codes = onWithCodes();
    const token = await loginPending();
    assert.equal((await recoverWith(token, { code: codes[0], password: PASSWORD })).status, 200);
    Object.assign(world.pending.get(token)!, { factorId: "replacement", enrolled: true });
    world.factors = [{ id: "replacement", status: "unverified" }];
    world.finishCalls = 0;
    world.failFinishAt = 1;
    const res = await verifyCode(token);
    assert.equal(res.status, 200);
    assert.match((await res.json()).notice, /recovery codes couldn't be created/);
    assert.equal(nextSignIn(), "challenge");
    assert.equal(state().codesUnused, 9, "the previous codes, minus the used one, still work");
  });

  test("an abandoned change blocks another only until its lock expires", async () => {
    onWithCodes();
    assert.equal((await post({ action: "disable", password: PASSWORD })).status, 200);
    assert.equal((await post({ action: "codes", password: PASSWORD })).status, 409);
    world.lock = null; // expired (owner_security_lock takes over an expired lock; proven on PostgreSQL)
    assert.equal((await post({ action: "codes", password: PASSWORD })).status, 200);
  });
});

// ---------- recovery-code reminder ----------
describe("recovery-code reminder (existing owners with two-step on and no codes)", async () => {
  const { readFileSync } = await import("node:fs");
  const reminder = readFileSync(new URL("../app/components/dashboard/RecoveryCodesReminder.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../app/components/dashboard/DashboardShell.tsx", import.meta.url), "utf8");
  const mobile = readFileSync(new URL("../app/components/mobile/MobileDashboard.tsx", import.meta.url), "utf8");

  test("shows only when two-step is on and no recovery codes exist", () => {
    assert.ok(reminder.includes('data?.status === "on" && data.codesTotal === 0'));
  });

  test("never shows codes: it reads only the status endpoint's counts", () => {
    assert.ok(!/recoveryCodes|codesUnused/.test(reminder));
    assert.ok(reminder.includes('fetch("/api/auth/security"'));
  });

  test("dismissible, remembered per owner in this browser, and safe when storage is blocked", () => {
    assert.ok(reminder.includes("sft:recovery-codes-reminder-dismissed:${userId}"));
    assert.equal((reminder.match(/try \{/g) ?? []).length, 2);
  });

  test("links to Sign-in Security; real owners only on desktop and mobile (never a demo, tester or Guided Demo Session)", () => {
    assert.ok(reminder.includes('document.getElementById("sign-in-security-card")'));
    assert.ok(shell.includes("{!isTester && !isLocalDemo && !guidedSession && (\n        <RecoveryCodesReminder") || shell.includes("{!isTester && !isLocalDemo && !guidedSession && (\r\n        <RecoveryCodesReminder"));
    assert.ok(mobile.includes('{!isTester && !isLocalDemo && <RecoveryCodesReminder userId={userId} onOpen={() => handleTabChange("settings")} />}'));
  });
});
