// Phase 5.7D-R10-R2: BEHAVIORAL tests for lib/loginNavigation.ts --
// real function calls with real inputs, asserting on real return values.
// This is the first genuinely executable proof of the login page's
// post-login dispatch decision in this repository; every prior guarantee
// about this logic was provable only via regex/string matching against
// app/login/page.tsx's source text (a .tsx file the node test runner
// cannot execute at all). Extracting the pure decision into this plain
// .ts module is what makes real behavioral testing possible here.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolvePostLoginNavigation } from "./loginNavigation.ts";

describe("resolvePostLoginNavigation -- next:'enroll'", () => {
  test("produces exactly one navigation decision, of type 'mfa', to exactly /mfa/enroll", () => {
    const decision = resolvePostLoginNavigation({ ok: true, next: "enroll" }, "owner");
    assert.deepEqual(decision, { type: "mfa", path: "/mfa/enroll" });
  });

  test("never produces a navigation to /dashboard for next:'enroll', regardless of role", () => {
    for (const role of ["owner", "employee"] as const) {
      const decision = resolvePostLoginNavigation({ ok: true, next: "enroll" }, role);
      assert.equal(decision.type, "mfa");
      assert.equal((decision as { path: string }).path, "/mfa/enroll");
    }
  });

  test("is unaffected by an extraneous data.redirect field -- that field is never read", () => {
    const decision = resolvePostLoginNavigation({ ok: true, next: "enroll", redirect: "/dashboard" }, "owner");
    assert.deepEqual(decision, { type: "mfa", path: "/mfa/enroll" });
  });
});

describe("resolvePostLoginNavigation -- next:'challenge'", () => {
  test("produces exactly one navigation decision, of type 'mfa', to exactly /mfa/challenge with no query when zero or one factorIds", () => {
    assert.deepEqual(resolvePostLoginNavigation({ ok: true, next: "challenge" }, "owner"), { type: "mfa", path: "/mfa/challenge" });
    assert.deepEqual(resolvePostLoginNavigation({ ok: true, next: "challenge", factorIds: ["f1"] }, "owner"), {
      type: "mfa",
      path: "/mfa/challenge",
    });
  });

  test("appends a factors query only when more than one factorId is present", () => {
    const decision = resolvePostLoginNavigation({ ok: true, next: "challenge", factorIds: ["f1", "f2"] }, "owner");
    assert.deepEqual(decision, { type: "mfa", path: "/mfa/challenge?factors=f1,f2" });
  });

  test("a non-array factorIds is ignored (no query appended) rather than throwing or producing a malformed URL", () => {
    // factorIds is typed `unknown` on LoginApiResponse specifically so this
    // kind of malformed-at-runtime value (a string instead of an array,
    // e.g. from a hand-crafted or corrupted response) can be passed here
    // and proven safe, without fighting the type checker.
    const decision = resolvePostLoginNavigation({ ok: true, next: "challenge", factorIds: "f1,f2" }, "owner");
    assert.deepEqual(decision, { type: "mfa", path: "/mfa/challenge" });
  });

  test("never produces a navigation to /dashboard for next:'challenge'", () => {
    const decision = resolvePostLoginNavigation({ ok: true, next: "challenge" }, "owner");
    assert.ok(decision.type !== "normal" || decision.path !== "/dashboard");
  });
});

describe("resolvePostLoginNavigation -- normal completed login (next undefined)", () => {
  test("owner role -> exactly /dashboard", () => {
    assert.deepEqual(resolvePostLoginNavigation({ ok: true }, "owner"), { type: "normal", path: "/dashboard" });
  });

  test("employee role -> exactly /schedule", () => {
    assert.deepEqual(resolvePostLoginNavigation({ ok: true }, "employee"), { type: "normal", path: "/schedule" });
  });

  test("ignores data.redirect entirely -- the destination is derived from role, not the server-supplied field, even when redirect disagrees with role", () => {
    const decision = resolvePostLoginNavigation({ ok: true, redirect: "/some-other-page" }, "owner");
    assert.deepEqual(decision, { type: "normal", path: "/dashboard" });
  });

  test("ok:true with an explicit redirect and no next (the tester-through-owner-tab case) still resolves from role, not from redirect", () => {
    const decision = resolvePostLoginNavigation({ ok: true, redirect: "/dashboard" }, "owner");
    assert.deepEqual(decision, { type: "normal", path: "/dashboard" });
  });
});

describe("resolvePostLoginNavigation -- fail-closed on anything else (Phase 5.7D-R10-R2 regression proof)", () => {
  const malformed: Array<[string, unknown]> = [
    ["next is an unrecognized string", { ok: true, next: "verified" }],
    ["next is null", { ok: true, next: null }],
    ["next is a number", { ok: true, next: 1 }],
    ["next is an object", { ok: true, next: { step: "enroll" } }],
    ["next is an empty string", { ok: true, next: "" }],
    ["next is 'Enroll' (wrong case)", { ok: true, next: "Enroll" }],
    ["ok is missing entirely alongside a missing next", { }],
    ["ok is false but next is undefined", { ok: false }],
    ["ok is the string 'true', not the boolean", { ok: "true", next: undefined }],
    ["next is '__proto__'", { ok: true, next: "__proto__" }],
    ["next is 'constructor'", { ok: true, next: "constructor" }],
  ];

  for (const [label, data] of malformed) {
    test(`${label} -> fail-closed, zero navigation`, () => {
      const decision = resolvePostLoginNavigation(data as never, "owner");
      assert.deepEqual(decision, { type: "fail-closed" });
    });
  }

  test("fail-closed results never carry a path property at all -- there is no path a caller could accidentally navigate to", () => {
    const decision = resolvePostLoginNavigation({ ok: true, next: "unknown-future-value" }, "owner");
    assert.equal(decision.type, "fail-closed");
    assert.ok(!("path" in decision));
  });
});

describe("resolvePostLoginNavigation -- exhaustiveness (every call produces exactly one decision)", () => {
  test("the function is total (never throws) across a wide sample of inputs, including empty and prototype-shaped objects", () => {
    const samples: unknown[] = [{}, { ok: true }, { ok: true, next: "enroll" }, { ok: true, next: "challenge", factorIds: [] }, null, undefined, { toString: () => "enroll" }];
    for (const sample of samples) {
      assert.doesNotThrow(() => resolvePostLoginNavigation((sample ?? {}) as never, "owner"));
    }
  });
});
