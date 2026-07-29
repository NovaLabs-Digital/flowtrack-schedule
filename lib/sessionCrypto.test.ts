// Focused tests for lib/sessionCrypto.ts, including the Phase 5.7D owner
// payload shape (authUserId/mfa/sessionEpoch) and the sft_mfa_pending
// payload. Pure crypto/logic, no I/O.
process.env.SESSION_SECRET = "test-session-secret-crypto";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  signSessionPayload,
  verifySessionCookie,
  signMfaPendingPayload,
  verifyMfaPendingCookie,
  signEmployeeWorkspaceSelectionPayload,
  verifyEmployeeWorkspaceSelectionCookie,
  newExpiry,
  OWNER_SESSION_SHORT_SECONDS,
  OWNER_SESSION_TRUSTED_SECONDS,
  MFA_PENDING_MAX_AGE_SECONDS,
  EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS,
} from "./sessionCrypto.ts";

describe("owner session payload (Phase 5.7D)", () => {
  test("round-trips a well-formed owner payload", async () => {
    const value = await signSessionPayload({
      role: "owner",
      workspaceId: "ws-1",
      authUserId: "user-1",
      mfa: true,
      sessionEpoch: 3,
      exp: newExpiry(OWNER_SESSION_SHORT_SECONDS),
    });
    const payload = await verifySessionCookie(value);
    assert.ok(payload);
    assert.equal(payload!.role, "owner");
    if (payload!.role === "owner") {
      assert.equal(payload!.workspaceId, "ws-1");
      assert.equal(payload!.authUserId, "user-1");
      assert.equal(payload!.sessionEpoch, 3);
    }
  });

  test("a pre-5.7D-shaped owner payload (no authUserId/mfa/sessionEpoch) is rejected outright -- forces re-login after this ships", async () => {
    // Signed directly (bypassing signSessionPayload's type check) to
    // simulate a real cookie issued by the old code, still cryptographically
    // valid under the same SESSION_SECRET.
    const oldShaped = { role: "owner", workspaceId: "ws-1", exp: newExpiry() };
    const encoder = new TextEncoder();
    const payloadB64 = Buffer.from(JSON.stringify(oldShaped)).toString("base64url");
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      encoder.encode("test-session-secret-crypto"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    const sigB64 = Buffer.from(new Uint8Array(sig)).toString("base64url");
    const value = `${payloadB64}.${sigB64}`;

    const payload = await verifySessionCookie(value);
    assert.equal(payload, null);
  });

  test("mfa: false is rejected -- an owner session can never claim aal2 without the literal true marker", async () => {
    const value = await signSessionPayload({
      role: "owner",
      workspaceId: "ws-1",
      authUserId: "user-1",
      // @ts-expect-error -- deliberately constructing an invalid payload to prove verification rejects it
      mfa: false,
      sessionEpoch: 1,
      exp: newExpiry(),
    });
    const payload = await verifySessionCookie(value);
    assert.equal(payload, null);
  });

  test("a non-integer or zero sessionEpoch is rejected", async () => {
    for (const badEpoch of [0, -1, 1.5]) {
      const value = await signSessionPayload({
        role: "owner",
        workspaceId: "ws-1",
        authUserId: "user-1",
        mfa: true,
        sessionEpoch: badEpoch,
        exp: newExpiry(),
      });
      const payload = await verifySessionCookie(value);
      assert.equal(payload, null, `sessionEpoch ${badEpoch} should be rejected`);
    }
  });

  test("a tampered signature is rejected", async () => {
    const value = await signSessionPayload({
      role: "owner",
      workspaceId: "ws-1",
      authUserId: "user-1",
      mfa: true,
      sessionEpoch: 1,
      exp: newExpiry(),
    });
    const tampered = value.slice(0, -4) + "abcd";
    const payload = await verifySessionCookie(tampered);
    assert.equal(payload, null);
  });

  test("an expired exp claim is rejected even with a valid signature", async () => {
    const value = await signSessionPayload({
      role: "owner",
      workspaceId: "ws-1",
      authUserId: "user-1",
      mfa: true,
      sessionEpoch: 1,
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const payload = await verifySessionCookie(value);
    assert.equal(payload, null);
  });

  test("OWNER_SESSION_SHORT_SECONDS is 12 hours and OWNER_SESSION_TRUSTED_SECONDS is 30 days", () => {
    assert.equal(OWNER_SESSION_SHORT_SECONDS, 60 * 60 * 12);
    assert.equal(OWNER_SESSION_TRUSTED_SECONDS, 60 * 60 * 24 * 30);
  });
});

describe("employee/tester session payloads remain unchanged", () => {
  test("round-trips an employee payload", async () => {
    const value = await signSessionPayload({ role: "employee", employeeId: "emp-1", workspaceId: "ws-1", exp: newExpiry() });
    const payload = await verifySessionCookie(value);
    assert.ok(payload);
    assert.equal(payload!.role, "employee");
  });

  test("round-trips a tester payload", async () => {
    const value = await signSessionPayload({ role: "tester", workspaceId: "ws-1", exp: newExpiry() });
    const payload = await verifySessionCookie(value);
    assert.ok(payload);
    assert.equal(payload!.role, "tester");
  });
});

describe("sft_mfa_pending payload (Phase 5.7D-R3)", () => {
  test("round-trips a well-formed pending payload, holding only the opaque token -- never a role, never anything requireRole could mistake for a session", async () => {
    const value = await signMfaPendingPayload({ token: "opaque-token-abc", exp: newExpiry(MFA_PENDING_MAX_AGE_SECONDS) });
    const payload = await verifyMfaPendingCookie(value);
    assert.ok(payload);
    assert.equal(payload!.token, "opaque-token-abc");
    assert.equal("role" in payload!, false);
  });

  test("MFA_PENDING_MAX_AGE_SECONDS is 5 minutes", () => {
    assert.equal(MFA_PENDING_MAX_AGE_SECONDS, 60 * 5);
  });

  test("an expired pending payload is rejected", async () => {
    const value = await signMfaPendingPayload({ token: "x", exp: Math.floor(Date.now() / 1000) - 1 });
    const payload = await verifyMfaPendingCookie(value);
    assert.equal(payload, null);
  });

  test("a tampered pending cookie is rejected", async () => {
    const value = await signMfaPendingPayload({ token: "x", exp: newExpiry(MFA_PENDING_MAX_AGE_SECONDS) });
    const payload = await verifyMfaPendingCookie(value.slice(0, -4) + "zzzz");
    assert.equal(payload, null);
  });

  test("an owner sft_session value is never accepted as a valid sft_mfa_pending payload, and vice versa", async () => {
    const ownerSessionValue = await signSessionPayload({
      role: "owner",
      workspaceId: "ws-1",
      authUserId: "user-1",
      mfa: true,
      sessionEpoch: 1,
      exp: newExpiry(),
    });
    assert.equal(await verifyMfaPendingCookie(ownerSessionValue), null);

    const pendingValue = await signMfaPendingPayload({ token: "x", exp: newExpiry(MFA_PENDING_MAX_AGE_SECONDS) });
    assert.equal(await verifySessionCookie(pendingValue), null);
  });
});

describe("sft_employee_workspace_pending payload (multi-workspace employee login)", () => {
  const twoCandidates = [
    { selectionId: "sel-1", employeeId: "emp-admin", workspaceId: "ws-admin" },
    { selectionId: "sel-2", employeeId: "emp-acs", workspaceId: "ws-acs" },
  ];

  test("round-trips a well-formed two-candidate payload, holding only opaque identifiers -- never a role, never anything requireRole could mistake for a session", async () => {
    const value = await signEmployeeWorkspaceSelectionPayload({
      purpose: "employee_workspace_selection",
      candidates: twoCandidates,
      exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
    });
    const payload = await verifyEmployeeWorkspaceSelectionCookie(value);
    assert.ok(payload);
    assert.deepEqual(payload!.candidates, twoCandidates);
    assert.equal("role" in payload!, false);
  });

  test("EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS is 5 minutes, matching the MFA-pending precedent", () => {
    assert.equal(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS, 60 * 5);
  });

  test("three or more candidates round-trip correctly too -- not hardcoded to exactly two", async () => {
    const three = [
      ...twoCandidates,
      { selectionId: "sel-3", employeeId: "emp-gna", workspaceId: "ws-gna" },
    ];
    const value = await signEmployeeWorkspaceSelectionPayload({
      purpose: "employee_workspace_selection",
      candidates: three,
      exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
    });
    const payload = await verifyEmployeeWorkspaceSelectionCookie(value);
    assert.deepEqual(payload!.candidates, three);
  });

  test("an expired challenge is rejected", async () => {
    const value = await signEmployeeWorkspaceSelectionPayload({
      purpose: "employee_workspace_selection",
      candidates: twoCandidates,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    assert.equal(await verifyEmployeeWorkspaceSelectionCookie(value), null);
  });

  test("a tampered (altered signature) challenge is rejected", async () => {
    const value = await signEmployeeWorkspaceSelectionPayload({
      purpose: "employee_workspace_selection",
      candidates: twoCandidates,
      exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
    });
    assert.equal(await verifyEmployeeWorkspaceSelectionCookie(value.slice(0, -4) + "zzzz"), null);
  });

  test("a forged payload with the wrong purpose string is rejected even if otherwise well-formed and signed with the real key", async () => {
    const value = await signEmployeeWorkspaceSelectionPayload({
      // @ts-expect-error -- deliberately wrong purpose to prove the
      // discriminator is actually checked, not just present in the type.
      purpose: "something_else",
      candidates: twoCandidates,
      exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
    });
    assert.equal(await verifyEmployeeWorkspaceSelectionCookie(value), null);
  });

  test("a candidate list tampered down to fewer than two entries is rejected -- a legitimate challenge never has fewer than two", async () => {
    const value = await signEmployeeWorkspaceSelectionPayload({
      purpose: "employee_workspace_selection",
      // A single candidate is type-valid (the type only requires an array
      // of the right element shape, not a minimum length) but must still
      // be rejected at runtime -- a legitimately-created challenge is
      // never shorter than two.
      candidates: [twoCandidates[0]],
      exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
    });
    assert.equal(await verifyEmployeeWorkspaceSelectionCookie(value), null);
  });

  test("a candidate missing a required field (selectionId/employeeId/workspaceId) is rejected", async () => {
    for (const badCandidates of [
      [{ employeeId: "emp-1", workspaceId: "ws-1" }, twoCandidates[1]],
      [{ selectionId: "sel-1", workspaceId: "ws-1" }, twoCandidates[1]],
      [{ selectionId: "sel-1", employeeId: "emp-1" }, twoCandidates[1]],
    ]) {
      const value = await signEmployeeWorkspaceSelectionPayload({
        purpose: "employee_workspace_selection",
        // @ts-expect-error -- deliberately malformed candidate shapes.
        candidates: badCandidates,
        exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
      });
      assert.equal(await verifyEmployeeWorkspaceSelectionCookie(value), null);
    }
  });

  test("an owner sft_session value and an sft_mfa_pending value are never accepted as a valid workspace-selection challenge, and vice versa", async () => {
    const ownerSessionValue = await signSessionPayload({
      role: "owner",
      workspaceId: "ws-1",
      authUserId: "user-1",
      mfa: true,
      sessionEpoch: 1,
      exp: newExpiry(),
    });
    assert.equal(await verifyEmployeeWorkspaceSelectionCookie(ownerSessionValue), null);

    const mfaPendingValue = await signMfaPendingPayload({ token: "x", exp: newExpiry(MFA_PENDING_MAX_AGE_SECONDS) });
    assert.equal(await verifyEmployeeWorkspaceSelectionCookie(mfaPendingValue), null);

    const selectionValue = await signEmployeeWorkspaceSelectionPayload({
      purpose: "employee_workspace_selection",
      candidates: twoCandidates,
      exp: newExpiry(EMPLOYEE_WORKSPACE_SELECTION_MAX_AGE_SECONDS),
    });
    assert.equal(await verifySessionCookie(selectionValue), null);
    assert.equal(await verifyMfaPendingCookie(selectionValue), null);
  });
});
