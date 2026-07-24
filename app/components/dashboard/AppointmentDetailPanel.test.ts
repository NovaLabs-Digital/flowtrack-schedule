// Phase 5.5E-E1B: AppointmentDetailPanel.tsx is a .tsx file. Node's built-in
// test runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content -- the same well-documented limitation
// AppointmentModal.test.ts (Phase 5.5E-E1A) hit. A full extraction/rewrite
// into a .ts/React.createElement component would be a far larger change than
// this narrowly-scoped phase authorizes (this panel is a single production
// file used across the whole desktop dashboard). So, exactly like
// AppointmentModal.test.ts, this file proves what SOURCE INSPECTION can
// actually prove -- prop wiring, guard placement/ordering, exact wording,
// and structural absence of forbidden content -- and explicitly does NOT
// claim to exercise real DOM rendering, real mouse/keyboard events, or real
// network calls for THIS component. The one thing that genuinely needs real
// rendered mouse/keyboard/aria interaction proof -- whether a restricted
// CapabilityGatedButton actually blocks a click/Enter/Space and remains
// disabled/aria-disabled -- is already proven exhaustively, for the exact
// same component this file wires in, by CapabilityGatedButton.test.ts's 20
// real rendered-DOM tests. That proof is not re-executed here; it is cited
// as already covering the shared primitive this component now uses.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  fileURLToPath(new URL("./AppointmentDetailPanel.tsx", import.meta.url)),
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
      /export default function AppointmentDetailPanel\(\{[^}]*canMutateOperationalData[^}]*\}: Props\)/
    );
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to AppointmentDetailPanel", () => {
    const idx = shellSource.indexOf("<AppointmentDetailPanel");
    assert.notEqual(idx, -1, "AppointmentDetailPanel must be rendered in DashboardShell");
    const nextTagEnd = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, nextTagEnd);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });
});

describe("handler guard placement", () => {
  test("handleCancel guards on canMutateOperationalData before the confirm() prompt and before the fetch call", () => {
    const fnStart = source.indexOf("async function handleCancel()");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const confirmIdx = source.indexOf("confirm(", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/appointments/delete"', fnStart);
    assert.notEqual(guardIdx, -1, "handleCancel must contain the capability guard");
    assert.ok(guardIdx < confirmIdx, "guard must run before the confirm() prompt");
    assert.ok(guardIdx < fetchIdx, "guard must run before the fetch call");
  });

  test("the guard is the first statement inside handleCancel (defense-in-depth, independent of the button's own disabled state)", () => {
    const fnStart = source.indexOf("async function handleCancel()");
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 400);
    const firstNonCommentNonBlank = afterBrace
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
  });
});

describe("Cancel Appointment control", () => {
  test("the cancel control is a CapabilityGatedButton, not a plain <button>", () => {
    assert.ok(source.includes("import CapabilityGatedButton from"));
    assert.match(source, /<CapabilityGatedButton[\s\S]{0,300}onClick=\{handleCancel\}/);
  });

  test("allowed is wired to canMutateOperationalData", () => {
    const idx = source.indexOf("onClick={handleCancel}");
    const block = source.slice(Math.max(0, idx - 200), idx + 50);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
  });

  test("the existing loading-protection disabled={cancelling} prop is preserved unchanged", () => {
    const idx = source.indexOf("onClick={handleCancel}");
    const block = source.slice(idx, idx + 200);
    assert.match(block, /disabled=\{cancelling\}/);
  });

  test("the cancel button's className is byte-identical to the pre-existing className (styling preserved)", () => {
    assert.ok(
      source.includes(
        'className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"'
      )
    );
  });

  test("ariaDescribedBy points at this panel's own notice id", () => {
    const idx = source.indexOf("onClick={handleCancel}");
    const block = source.slice(idx, idx + 200);
    assert.match(block, /ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/);
  });
});

describe("Edit control remains ungoverned (reveal-only, no mutation of its own)", () => {
  test("the Edit button is still a plain <button>, not wrapped in CapabilityGatedButton", () => {
    const idx = source.indexOf("onClick={handleEdit}");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 60), idx);
    assert.ok(before.includes("<button"), "Edit control must remain a plain button element");
  });

  test("handleEdit contains no capability guard -- it only opens AppointmentModal, whose own submit path is already governed (Phase 5.5E-E1A)", () => {
    const fnStart = source.indexOf("function handleEdit()");
    const fnEnd = source.indexOf("\n  }", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("canMutateOperationalData"));
  });
});

describe("notice block", () => {
  test("exact approved wording constant", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("notice only renders when restricted (negated condition, not the positive form)", () => {
    assert.match(source, /\{!canMutateOperationalData && \(/);
  });

  test("notice element id's declared value is unique to this component (not appointment-modal-restricted-notice or move-confirm-dialog-restricted-notice)", () => {
    // Checked against the DECLARED VALUE specifically, not a whole-file
    // substring search -- this file's own header comment legitimately names
    // the sibling components' notice ids by way of explaining why they must
    // differ, which a naive whole-file .includes() check would misread as a
    // collision.
    const declared = source.match(/const RESTRICTED_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "appointment-detail-restricted-notice");
    assert.notEqual(declared, "appointment-modal-restricted-notice");
    assert.notEqual(declared, "move-confirm-dialog-restricted-notice");
  });

  test("only one notice block exists in this file (shown once, not per control)", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });
});

describe("read-only data remains unconditional", () => {
  test("appointment/client/employee detail rendering (service type, time range, notes, client name/address/phone) is not wrapped in a canMutateOperationalData check", () => {
    const detailBlockStart = source.indexOf('<div className="mt-3 grid grid-cols-2 gap-4">');
    const detailBlockEnd = source.indexOf("{error &&", detailBlockStart);
    const block = source.slice(detailBlockStart, detailBlockEnd);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("Call/Text links (tel:/sms:) remain unconditional", () => {
    assert.ok(source.includes("href={`tel:${client.phone}`}"));
    assert.ok(source.includes("href={`sms:${client.phone}`}"));
    const idx = source.indexOf("href={`tel:");
    const block = source.slice(Math.max(0, idx - 300), idx);
    assert.ok(!block.includes("canMutateOperationalData &&"));
  });
});

describe("no duplicated billing surface, no leaked internal detail, no re-derivation of the boolean", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in this file's new restricted-state code", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `AppointmentDetailPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `AppointmentDetailPanel.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("mouse/keyboard/repeated-activation guarantee (delegated proof)", () => {
  test("documents that CapabilityGatedButton.test.ts already proves, for the exact primitive used here, that a restricted button is disabled+aria-disabled and that mouse click / Enter / Space / repeated activation each invoke onClick zero times", () => {
    // This test intentionally makes no DOM assertion of its own -- .tsx
    // files cannot be rendered by this repo's test runner (see file header).
    // It exists to make the delegation explicit and keep it from silently
    // going unverified: CapabilityGatedButton.test.ts's "restricted -- no
    // click can initiate a request" describe block (7 tests) is the actual
    // interaction proof, and it applies unmodified here because this file's
    // "Cancel Appointment" control renders that exact component with
    // allowed={canMutateOperationalData} and no additional onClick wrapping
    // that could reintroduce a bypass.
    const idx = source.indexOf("onClick={handleCancel}");
    const block = source.slice(Math.max(0, idx - 200), idx + 50);
    assert.match(block, /<CapabilityGatedButton/);
    assert.ok(!block.includes("onClick={() =>"), "onClick must be passed directly (handleCancel), not wrapped, so CapabilityGatedButton's own guard is the only gate");
  });
});
