// Phase 5.7D-R10-R2: pure, behaviorally-testable extraction of
// app/login/page.tsx's post-login navigation decision. Kept in a plain
// .ts module (no "use client", no JSX) specifically so the node test
// runner can import and call it directly with real inputs and assert on
// real outputs -- this repo's .tsx pages cannot be executed by the test
// runner at all (see app/login/page.test.ts's own header comment), so
// every guarantee about this dispatch logic was previously provable only
// by regex/string matching against the page's source text. This function
// is now the single source of truth both the page and its tests use.

export type LoginRole = "owner" | "employee";

export type LoginNavigationDecision =
  | { type: "mfa"; path: string }
  | { type: "normal"; path: string }
  | { type: "fail-closed" };

// Explicit allowlist from the login API's `next` discriminator to a
// LOCAL, hardcoded navigation path. The server SELECTS which entry
// applies (by sending "enroll" or "challenge"); it never supplies a
// navigable URL itself, and this function never returns a server-supplied
// string as a path. A `next` value that is not exactly one of these two
// keys resolves to `undefined` -- deliberately, so it can never be
// mistaken for a known step. A plain Map (not an object literal) is used
// so a value like "__proto__" or "constructor" can never resolve to
// anything but undefined either.
const MFA_STEP_DESTINATIONS = new Map<string, string>([
  ["enroll", "/mfa/enroll"],
  ["challenge", "/mfa/challenge"],
]);

export interface LoginApiResponse {
  ok?: unknown;
  next?: unknown;
  factorIds?: unknown;
  redirect?: unknown;
  error?: unknown;
}

// Decides where (if anywhere) to navigate after a successful (res.ok)
// POST /api/auth/login response.
//
// Phase 5.7D-R10-R2: `data.redirect` is never read here. See
// app/api/auth/login/route.ts -- only the employee and tester branches
// ever send that field (the owner MFA branch never does); this function
// derives the identical destination from local `role` state instead of
// trusting a server-supplied string, even though the value happens to
// match today.
//
// Any `next` value that is not exactly "enroll" or "challenge", and any
// response that is not ok:true with next===undefined, resolves to
// "fail-closed" -- callers must not navigate anywhere for that result.
export function resolvePostLoginNavigation(data: LoginApiResponse, role: LoginRole): LoginNavigationDecision {
  const mfaPath = typeof data.next === "string" ? MFA_STEP_DESTINATIONS.get(data.next) : undefined;
  if (mfaPath) {
    if (data.next === "challenge") {
      const query = Array.isArray(data.factorIds) && data.factorIds.length > 1 ? `?factors=${data.factorIds.join(",")}` : "";
      return { type: "mfa", path: `${mfaPath}${query}` };
    }
    return { type: "mfa", path: mfaPath };
  }

  if (data.ok === true && data.next === undefined) {
    return { type: "normal", path: role === "employee" ? "/schedule" : "/dashboard" };
  }

  return { type: "fail-closed" };
}
