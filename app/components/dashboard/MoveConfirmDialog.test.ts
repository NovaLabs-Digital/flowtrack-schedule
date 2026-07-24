// Phase 5.5E-E1B: MoveConfirmDialog.tsx is a .tsx file and cannot be loaded
// by Node's built-in test runner (this repo's only test runner) -- the same
// limitation documented in AppointmentModal.test.ts (Phase 5.5E-E1A) and
// AppointmentDetailPanel.test.ts (this phase). This file proves what source
// inspection can prove: prop wiring, guard placement/ordering, exact
// wording, and structural absence of forbidden content. It does not claim to
// exercise real DOM rendering or real mouse/keyboard events for THIS
// component. The real rendered interaction proof for the shared
// CapabilityGatedButton primitive this dialog now uses (disabled,
// aria-disabled, zero-call mouse/Enter/Space/repeated activation) already
// exists in CapabilityGatedButton.test.ts and is cited, not re-executed.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  fileURLToPath(new URL("./MoveConfirmDialog.tsx", import.meta.url)),
  "utf8"
);
const shellSource = fs.readFileSync(
  fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)),
  "utf8"
);

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("Props includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
  });

  test("the component destructures canMutateOperationalData from its props", () => {
    assert.match(
      source,
      /export default function MoveConfirmDialog\(\{[^}]*canMutateOperationalData[^}]*\}: Props\)/
    );
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to MoveConfirmDialog", () => {
    const idx = shellSource.indexOf("<MoveConfirmDialog");
    assert.notEqual(idx, -1, "MoveConfirmDialog must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });
});

describe("execute() guard placement", () => {
  test("execute is guarded before setSubmitting/setError and before the fetch call, for both mode values", () => {
    const fnStart = source.indexOf('async function execute(mode: "single" | "future")');
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const setSubmittingIdx = source.indexOf("setSubmitting(true);", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/appointments/update"', fnStart);
    assert.notEqual(guardIdx, -1, "execute must contain the capability guard");
    assert.ok(guardIdx < setSubmittingIdx, "guard must run before setSubmitting");
    assert.ok(guardIdx < fetchIdx, "guard must run before the fetch call");
  });

  test("the guard is the first statement inside execute()", () => {
    const fnStart = source.indexOf('async function execute(mode: "single" | "future")');
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 500);
    const firstNonCommentNonBlank = afterBrace
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
  });

  test("this guard protects both the recurring-scope buttons and the single non-recurring button, since all three call the same execute()", () => {
    const executeCalls = source.match(/execute\("(single|future)"\)/g) ?? [];
    assert.equal(executeCalls.length, 3, "expected exactly 3 call sites: single (recurring), future (recurring), single (non-recurring)");
  });
});

describe("commit controls governed by CapabilityGatedButton", () => {
  test("all 3 commit buttons ('Only this appointment', 'This and all future appointments', 'Move Appointment') are CapabilityGatedButton, not plain <button>", () => {
    const matches = source.match(/<CapabilityGatedButton/g) ?? [];
    assert.equal(matches.length, 3);
  });

  test("each commit button has allowed={canMutateOperationalData}", () => {
    const matches = source.match(/allowed=\{canMutateOperationalData\}/g) ?? [];
    assert.equal(matches.length, 3);
  });

  test("each commit button preserves its existing disabled={submitting} loading-protection prop", () => {
    const matches = source.match(/<CapabilityGatedButton[\s\S]{0,120}?disabled=\{submitting\}/g) ?? [];
    assert.equal(matches.length, 3);
  });

  test("each commit button references the shared notice via ariaDescribedBy={RESTRICTED_NOTICE_ID}", () => {
    const matches = source.match(/ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 3);
  });

  test("original button classNames are preserved byte-identical", () => {
    assert.ok(source.includes('className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50"'));
    assert.ok(source.includes('className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-blue-200 hover:bg-blue-50 disabled:opacity-50"'));
    assert.ok(source.includes('className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"'));
  });
});

describe("Cancel / Go Back controls remain ungoverned (non-mutating)", () => {
  test("both onClose-triggering buttons remain plain <button> elements, not CapabilityGatedButton", () => {
    const matches = source.match(/onClick=\{onClose\}/g) ?? [];
    assert.equal(matches.length, 2, "expected 2 Cancel/Go Back buttons (recurring branch + non-recurring branch)");
    for (const idx of [source.indexOf("onClick={onClose}"), source.lastIndexOf("onClick={onClose}")]) {
      const before = source.slice(Math.max(0, idx - 30), idx);
      assert.ok(before.includes("<button"), "onClose control must remain a plain button element");
    }
  });

  test("onClose itself carries no capability guard -- closing is always allowed", () => {
    assert.ok(!source.includes("canMutateOperationalData ? onClose"));
  });
});

describe("notice block", () => {
  test("exact approved wording constant", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("notice only renders when restricted (negated condition)", () => {
    assert.match(source, /\{!canMutateOperationalData && \(/);
  });

  test("notice id's declared value is unique to this component", () => {
    // Checked against the DECLARED VALUE specifically, not a whole-file
    // substring search -- see AppointmentDetailPanel.test.ts for why a
    // naive whole-file check produces a false positive against this file's
    // own explanatory header comment.
    const declared = source.match(/const RESTRICTED_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "move-confirm-dialog-restricted-notice");
    assert.notEqual(declared, "appointment-modal-restricted-notice");
    assert.notEqual(declared, "appointment-detail-restricted-notice");
  });

  test("only one notice block exists (shown once, shared across all 3 commit buttons via aria-describedby, never duplicated per button)", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });
});

describe("notification-choice state remains local-only until a governed confirmation", () => {
  test("notifyChannel/setNotifyChannel carries no capability guard of its own -- it's read only inside execute(), which is already guarded", () => {
    assert.ok(source.includes("const [notifyChannel, setNotifyChannel] = useState<NotifyChannel>("));
    assert.ok(!source.includes("setNotifyChannel(") || !/setNotifyChannel\([^)]*canMutateOperationalData/.test(source));
  });

  test("NotifyChoicePanel itself is rendered unconditionally (its own selection is never a mutation)", () => {
    const idx = source.indexOf("<NotifyChoicePanel");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 60), idx);
    assert.ok(!before.includes("canMutateOperationalData &&"));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `MoveConfirmDialog.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `MoveConfirmDialog.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("stale/programmatic invocation cannot bypass the guard", () => {
  test("execute() is only ever reachable via the 3 onClick={() => execute(...)} call sites, all now behind CapabilityGatedButton, plus the function's own first-line guard covers any other call path", () => {
    // Structural proof only: confirms there is no second, ungated call site
    // and that the function-level guard (proven above to be the first
    // statement) is unconditional regardless of caller.
    const callSites = source.match(/execute\("(single|future)"\)/g) ?? [];
    assert.equal(callSites.length, 3);
    const guardCount = (source.match(/if \(!canMutateOperationalData\) return;/g) ?? []).length;
    assert.equal(guardCount, 1, "exactly one guard, at the top of execute(), covers every call site by construction");
  });
});
