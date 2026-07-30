// Phase 5.6D: source-level proof that the login page links to the new legal
// pages, and that this phase did not add a consent checkbox or otherwise
// change login submission behavior (explicitly out of scope for 5.6D).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/login/page.tsx -- password visibility (Phase 5.7D-R17)", () => {
  test("the password field uses PasswordInput with autoComplete=current-password, and no raw <input type=\"password\"> remains", () => {
    assert.ok(source.includes('import PasswordInput from "@/app/components/PasswordInput";'));
    assert.equal([...source.matchAll(/<PasswordInput/g)].length, 1);
    assert.ok(source.includes('autoComplete="current-password"'));
    assert.ok(!source.includes('type="password"'));
  });
});

describe("app/login/page.tsx -- Phase 5.6D legal links", () => {
  test("links to /terms", () => {
    assert.ok(source.includes('href="/terms"'));
  });

  test("links to /privacy", () => {
    assert.ok(source.includes('href="/privacy"'));
  });

  test("does not add a consent checkbox or otherwise alter the login submit handler", () => {
    assert.ok(!source.includes('type="checkbox"'));
    assert.ok(!source.includes("I agree"));
    // handleSubmit's own required-fields guard is unchanged from before this phase.
    assert.ok(source.includes("Please enter your email and password."));
  });
});

describe("app/login/page.tsx -- Phase 5.7D signup link and MFA hand-off", () => {
  test('links to /signup with the exact approved "Create an account" copy', () => {
    assert.ok(source.includes('href="/signup"'));
    assert.ok(source.includes("New to ScheduleFlowTrack?"));
    assert.ok(source.includes("Create an account"));
  });
});

// Phase 5.7D-R10-R2: the post-login navigation DECISION itself was extracted
// to lib/loginNavigation.ts (a plain, non-JSX module the test runner can
// import and call directly -- see lib/loginNavigation.test.ts for the real,
// behavioral proof of every enroll/challenge/normal/fail-closed case). What
// remains here, provable only via source inspection (this file cannot be
// rendered by the test runner), is: this page calls that single function
// exactly once per submission and acts on its result, never reimplements
// or duplicates the dispatch logic inline, and never reads data.redirect
// itself.
describe("app/login/page.tsx -- delegates navigation dispatch to lib/loginNavigation.ts (Phase 5.7D-R10-R2)", () => {
  test("imports resolvePostLoginNavigation from @/lib/loginNavigation and calls it exactly once in handleSubmit", () => {
    assert.ok(source.includes('import { resolvePostLoginNavigation, type LoginRole } from "@/lib/loginNavigation";'));
    const calls = [...source.matchAll(/resolvePostLoginNavigation\(/g)];
    assert.equal(calls.length, 1);
  });

  test("does not reimplement the MFA_STEP_DESTINATIONS map or any next==='enroll'/'challenge' comparison inline -- the old dispatch logic cannot silently reappear in this file", () => {
    assert.ok(!source.includes("MFA_STEP_DESTINATIONS"));
    assert.ok(!source.includes('data.next === "enroll"'));
    assert.ok(!source.includes('data.next === "challenge"'));
  });

  test("never reads data.redirect anywhere in this file -- no open redirect is possible from this page", () => {
    assert.ok(!source.includes("data.redirect"));
  });

  test("acts on the decision by checking decision.type === 'fail-closed' first, and otherwise pushes decision.path -- a single, exhaustive branch, not a re-derived chain of ifs", () => {
    assert.ok(source.includes('if (decision.type === "fail-closed")'));
    assert.ok(source.includes("router.push(decision.path)"));
    // Exactly one router.push call in the whole file's success path -- proves
    // there is no second, parallel navigation site that could diverge from
    // lib/loginNavigation.ts's decision.
    const handleSubmitStart = source.indexOf("async function handleSubmit");
    const handleSubmitEnd = source.indexOf("async function handleSelectWorkspace");
    const pushCalls = [...source.slice(handleSubmitStart, handleSubmitEnd).matchAll(/router\.push\(/g)];
    assert.equal(pushCalls.length, 1);
  });

  test("employee login behavior is unchanged: role=employee is still sent conditionally to the API", () => {
    assert.ok(source.includes('...(role === "employee" ? { role: "employee" } : {})'));
  });
});

// Multi-workspace employee login: a password matching more than one active
// employee row (same normalized email, different workspaces) returns
// next: "select_workspace" instead of a navigable outcome. Provable only via
// source inspection (this page cannot be rendered by the test runner) --
// the real behavioral proof of the two API routes themselves lives in
// app/api/auth/login/route.test.ts and
// app/api/auth/employee/select-workspace/route.test.ts.
describe("app/login/page.tsx -- multi-workspace employee workspace selection", () => {
  test("checks for next === 'select_workspace' with an array of choices BEFORE calling resolvePostLoginNavigation, and stores only what the response itself returned", () => {
    const selectCheckIdx = source.indexOf('data?.next === "select_workspace"');
    const dispatchCallIdx = source.indexOf("resolvePostLoginNavigation(");
    assert.ok(selectCheckIdx > -1 && dispatchCallIdx > -1);
    assert.ok(selectCheckIdx < dispatchCallIdx, "the selection check must short-circuit before the normal navigation dispatch runs");
    assert.ok(source.includes("setWorkspaceChoices(data.choices)"));
  });

  test("never reads or stores an employeeId or workspaceId from the login response -- only the opaque choices array the server already sanitized", () => {
    const handleSubmitBody = source.slice(source.indexOf("async function handleSubmit"), source.indexOf("async function handleSelectWorkspace"));
    assert.ok(!handleSubmitBody.toLowerCase().includes("workspaceid"));
    assert.ok(!handleSubmitBody.toLowerCase().includes("employeeid"));
  });

  test("handleSelectWorkspace posts only the chosen selectionId to /api/auth/employee/select-workspace, never an employee or workspace id", () => {
    const body = source.slice(source.indexOf("async function handleSelectWorkspace"), source.indexOf("function switchRole"));
    assert.ok(body.includes('fetch("/api/auth/employee/select-workspace"'));
    assert.ok(body.includes("JSON.stringify({ selectionId })"));
  });

  test("handleSelectWorkspace has a synchronous ref guard (selectingRef) preventing a double-submit, matching the same pattern already established for handleSubmit's submittingRef", () => {
    assert.ok(source.includes("const selectingRef = useRef(false);"));
    const body = source.slice(source.indexOf("async function handleSelectWorkspace"), source.indexOf("function switchRole"));
    const guardIdx = body.indexOf("if (selectingRef.current) return;");
    const fetchIdx = body.indexOf('fetch("/api/auth/employee/select-workspace"');
    assert.ok(guardIdx > -1 && fetchIdx > -1 && guardIdx < fetchIdx);
  });

  test("on success, navigates using the server's own redirect value via router.push, not a hardcoded path re-derived on this page", () => {
    const body = source.slice(source.indexOf("async function handleSelectWorkspace"), source.indexOf("function switchRole"));
    assert.ok(body.includes('router.push(data?.redirect || "/schedule")'));
  });

  test("the picker renders only choice.companyName per option, keyed by choice.selectionId -- never any other field from a choice", () => {
    const pickerIdx = source.indexOf("workspaceChoices.map((choice)");
    assert.ok(pickerIdx > -1);
    const pickerBlock = source.slice(pickerIdx, pickerIdx + 700);
    assert.ok(pickerBlock.includes("key={choice.selectionId}"));
    assert.ok(pickerBlock.includes("onClick={() => handleSelectWorkspace(choice.selectionId)}"));
    assert.ok(pickerBlock.includes("{choice.companyName}"));
  });

  test("a 'Back to login' control clears workspaceChoices and the error, returning to the normal form without a network call", () => {
    const backIdx = source.indexOf("← Back to login");
    assert.ok(backIdx > -1);
    const before = source.slice(Math.max(0, backIdx - 300), backIdx);
    assert.ok(before.includes("setWorkspaceChoices(null)"));
    assert.ok(!before.includes("fetch("));
  });

  test("the picker is rendered instead of the role toggle and normal form, never alongside them", () => {
    const ternaryIdx = source.indexOf("{workspaceChoices ? (");
    assert.ok(ternaryIdx > -1);
    const roleToggleIdx = source.indexOf("{/* Role toggle */}");
    assert.ok(roleToggleIdx > ternaryIdx, "the role toggle must be inside the ternary's else branch, after the picker's own branch");
  });
});

// Phase 5.7D-R10-R2: investigated whether the login form can submit twice
// from a single user action (fast double-click, or a click racing an
// Enter-key submit) before React's `loading` state re-render has disabled
// the submit button. It can, in principle -- `loading` is React state,
// which only takes effect after a commit; two events dispatched within the
// same tick can both enter handleSubmit before that commit happens. Fixed
// with a synchronous ref guard that has no dependency on the render cycle.
describe("app/login/page.tsx -- duplicate-submission guard (Phase 5.7D-R10-R2)", () => {
  test("uses a useRef-based guard (submittingRef), not state alone, checked synchronously as the first statement inside handleSubmit after e.preventDefault()", () => {
    assert.ok(source.includes("const submittingRef = useRef(false);"));
    const handleSubmitBody = source.slice(source.indexOf("async function handleSubmit"), source.indexOf("async function handleSelectWorkspace"));
    const preventDefaultIdx = handleSubmitBody.indexOf("e.preventDefault();");
    const guardCheckIdx = handleSubmitBody.indexOf("if (submittingRef.current) return;");
    assert.ok(preventDefaultIdx > -1 && guardCheckIdx > -1);
    assert.ok(guardCheckIdx > preventDefaultIdx, "the guard check must come right after preventDefault, before any state read/validation");
    // Nothing besides preventDefault appears between the two -- no `await`,
    // no state update, that could let a second synchronous event slip in
    // before the check.
    const between = handleSubmitBody.slice(preventDefaultIdx + "e.preventDefault();".length, guardCheckIdx).trim();
    assert.equal(between, "");
  });

  test("the guard is set to true only after the email/password validation passes -- a validation error does not block an immediate retry", () => {
    const handleSubmitBody = source.slice(source.indexOf("async function handleSubmit"), source.indexOf("async function handleSelectWorkspace"));
    const validationErrorIdx = handleSubmitBody.indexOf("Please enter your email and password.");
    const guardSetIdx = handleSubmitBody.indexOf("submittingRef.current = true;");
    assert.ok(validationErrorIdx > -1 && guardSetIdx > -1);
    assert.ok(validationErrorIdx < guardSetIdx);
  });

  test("the guard is always reset in the finally block, alongside setLoading(false), so a completed or failed request never leaves the form permanently blocked", () => {
    const handleSubmitBody = source.slice(source.indexOf("async function handleSubmit"), source.indexOf("async function handleSelectWorkspace"));
    const finallyIdx = handleSubmitBody.indexOf("} finally {");
    const finallyBlock = handleSubmitBody.slice(finallyIdx);
    assert.match(finallyBlock, /setLoading\(false\);\s*\n\s*submittingRef\.current = false;/);
  });

  test("the submit button remains disabled by the existing loading state -- the ref guard is a second, independent layer, not a replacement for it", () => {
    assert.ok(source.includes("disabled={loading}"));
  });
});
