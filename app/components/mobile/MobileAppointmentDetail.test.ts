// Phase 5.5E-E1D: MobileAppointmentDetail.tsx is a .tsx file. Node's built-in
// test runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content -- the same well-documented limitation hit by
// every .tsx production file in this entitlement-enforcement effort
// (AppointmentModal.test.ts, AppointmentDetailPanel.test.ts, MoveConfirmDialog
// .test.ts, ScheduleGrid.test.ts, TopBar.test.ts, MobileDashboard.test.ts).
// This file proves what SOURCE INSPECTION can actually prove -- prop wiring,
// guard placement/ordering, exact wording, and structural absence of
// forbidden content -- and does not claim to exercise real DOM rendering or
// real mouse/touch/keyboard events for THIS component.
//
// The one thing that genuinely needs real rendered interaction proof --
// whether a restricted CapabilityGatedButton actually blocks a
// click/touch/Enter/Space and remains disabled/aria-disabled -- is already
// proven exhaustively, for the exact same component this file wires in, by
// CapabilityGatedButton.test.ts's 20 real rendered-DOM tests. That proof is
// not re-executed here; it is cited as already covering the shared
// primitive both of this component's governed controls (Edit and Cancel
// Appointment) now use.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  fileURLToPath(new URL("./MobileAppointmentDetail.tsx", import.meta.url)),
  "utf8"
);
const mobileDashboardSource = fs.readFileSync(
  fileURLToPath(new URL("./MobileDashboard.tsx", import.meta.url)),
  "utf8"
);

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("Props includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
  });

  test("the component destructures canMutateOperationalData from its props", () => {
    const fnStart = source.indexOf("export default function MobileAppointmentDetail({");
    const fnParamsEnd = source.indexOf("}: Props)", fnStart);
    const params = source.slice(fnStart, fnParamsEnd);
    assert.match(params, /^\s*canMutateOperationalData,$/m);
  });

  test("MobileDashboard passes its own canMutateOperationalData prop straight through to MobileAppointmentDetail -- no re-derivation, no new resolution path", () => {
    const idx = mobileDashboardSource.indexOf("<MobileAppointmentDetail");
    assert.notEqual(idx, -1, "MobileAppointmentDetail must be rendered in MobileDashboard");
    const closeIdx = mobileDashboardSource.indexOf("/>", idx);
    const jsx = mobileDashboardSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{canMutateOperationalData\}/);
  });

  test("MobileDashboard's own entry-control wiring for canMutateOperationalData (E-E1C, the '+ Add Appointment' CapabilityGatedButton) is unmodified by this phase", () => {
    const matches = mobileDashboardSource.match(/allowed=\{canMutateOperationalData\}/g) ?? [];
    // Exactly one CapabilityGatedButton call site in MobileDashboard.tsx
    // itself uses `allowed={...}` -- the E-E1C "+ Add Appointment" button.
    // MobileAppointmentDetail's own governed button lives in a different
    // file and is asserted separately below.
    assert.equal(matches.length, 1);
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
        'className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 active:bg-rose-100 disabled:opacity-50 transition-colors"'
      )
    );
  });

  test("ariaDescribedBy points at this component's own notice id", () => {
    const idx = source.indexOf("onClick={handleCancel}");
    const block = source.slice(idx, idx + 200);
    assert.match(block, /ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/);
  });

  test("the loading label text (Cancelling... / Cancel Appointment) is unchanged", () => {
    assert.ok(source.includes('{cancelling ? "Cancelling..." : "Cancel Appointment"}'));
  });
});

describe("Edit control governed by CapabilityGatedButton (corrected from the initial E-E1D implementation)", () => {
  // Edit is a mutation-workflow entry control (it opens AppointmentModal in
  // edit mode) and must be governed here, not treated as read-only
  // navigation. It does not itself call the mutation route, but a
  // restricted owner must never be able to reach the edit workflow through
  // this control -- AppointmentModal's own E-E1A submit-time guard remains
  // defense-in-depth for any stale/programmatic path into it, unchanged.
  test("the Edit control is a CapabilityGatedButton, not a plain <button>", () => {
    assert.match(source, /<CapabilityGatedButton[\s\S]{0,300}onClick=\{handleEditClick\}/);
  });

  test("allowed is wired to canMutateOperationalData", () => {
    const idx = source.indexOf("onClick={handleEditClick}");
    const block = source.slice(Math.max(0, idx - 200), idx + 50);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
  });

  test("onClick is the local guarded wrapper (handleEditClick), not onEdit directly -- CapabilityGatedButton's own guard is not the only gate", () => {
    assert.ok(source.includes("onClick={handleEditClick}"));
    assert.ok(!source.includes("onClick={onEdit}"));
  });

  test("ariaDescribedBy points at the same shared notice id used by Cancel", () => {
    const idx = source.indexOf("onClick={handleEditClick}");
    const block = source.slice(Math.max(0, idx - 200), idx + 150);
    assert.match(block, /ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/);
  });

  test("the Edit label's core className (text size/weight/color) is preserved, with disabled:opacity-50 added", () => {
    assert.ok(source.includes('className="text-sm font-medium text-blue-600 disabled:opacity-50"'));
  });

  test("the label text (Edit) is unchanged", () => {
    const idx = source.indexOf("onClick={handleEditClick}");
    const block = source.slice(idx, idx + 200);
    assert.ok(block.includes(">\n          Edit\n") || block.includes(">Edit<") || source.includes("Edit\n        </CapabilityGatedButton>"));
  });
});

describe("handleEditClick guard (direct guard against stale/programmatic invocation)", () => {
  test("handleEditClick guards on canMutateOperationalData before calling onEdit", () => {
    const fnStart = source.indexOf("function handleEditClick()");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const onEditIdx = source.indexOf("onEdit();", fnStart);
    assert.notEqual(guardIdx, -1, "handleEditClick must contain the capability guard");
    assert.ok(guardIdx < onEditIdx, "guard must run before onEdit() is invoked");
  });

  test("the guard is the first statement inside handleEditClick", () => {
    const fnStart = source.indexOf("function handleEditClick()");
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 200);
    const firstNonCommentNonBlank = afterBrace
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
  });

  test("restricted Edit cannot open AppointmentModal: onEdit (the caller-supplied callback that opens it) is unreachable from this file while restricted, since handleEditClick returns before calling it, and CapabilityGatedButton's own internal guard independently blocks the click that would invoke handleEditClick in the first place", () => {
    // Two independent layers proven above: (1) CapabilityGatedButton itself
    // (allowed={canMutateOperationalData}) never calls its onClick prop
    // while restricted -- proven generically in CapabilityGatedButton.test
    // .ts; (2) handleEditClick's own guard blocks onEdit() even if somehow
    // invoked directly. Since onEdit is the ONLY path this file has to the
    // caller's edit-mode AppointmentModal trigger, both layers must be
    // defeated for the modal to open -- neither is.
    const onEditCallSites = source.match(/onEdit\(\)/g) ?? [];
    assert.equal(onEditCallSites.length, 1, "onEdit() must be called from exactly one place: inside the guarded handleEditClick");
  });
});

describe("notice block", () => {
  test("exact approved wording constant", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("notice only renders when restricted (negated condition, not the positive form)", () => {
    assert.match(source, /\{!canMutateOperationalData && \(/);
  });

  test("notice id's declared value is unique to this component", () => {
    const declared = source.match(/const RESTRICTED_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "mobile-appointment-detail-restricted-notice");
    assert.notEqual(declared, "appointment-modal-restricted-notice");
    assert.notEqual(declared, "appointment-detail-restricted-notice");
    assert.notEqual(declared, "move-confirm-dialog-restricted-notice");
    assert.notEqual(declared, "topbar-restricted-notice");
    assert.notEqual(declared, "mobile-dashboard-restricted-notice");
  });

  test("only one notice block exists in this file (shown once, not per control)", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("both governed controls (Edit and Cancel Appointment) reference that single notice via ariaDescribedBy -- exactly two references to one notice, never a second notice", () => {
    const describedByMatches = source.match(/ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(describedByMatches.length, 2, "expected exactly 2 ariaDescribedBy references (Edit + Cancel) to the 1 shared notice");
  });
});

describe("read-only data and navigation remain unconditional", () => {
  test("Back button remains a plain, unconditional button", () => {
    assert.ok(source.includes("onClick={onBack}"));
    const idx = source.indexOf("onClick={onBack}");
    const block = source.slice(Math.max(0, idx - 60), idx);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("appointment summary (service, date, time, employee, address) rendering is not wrapped in a canMutateOperationalData check", () => {
    const summaryStart = source.indexOf('{/* Summary */}');
    const summaryEnd = source.indexOf('{/* Client */}');
    assert.notEqual(summaryStart, -1);
    assert.notEqual(summaryEnd, -1);
    const block = source.slice(summaryStart, summaryEnd);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("client viewing (onViewClient), Call/Text links (tel:/sms:), and Communication badges remain unconditional", () => {
    assert.ok(source.includes("onClick={onViewClient}"));
    assert.ok(source.includes("href={`tel:${client.phone}`}"));
    assert.ok(source.includes("href={`sms:${client.phone}`}"));
    const clientBlockStart = source.indexOf('{/* Client */}');
    const clientBlockEnd = source.indexOf('{/* Notes */}');
    const commBlockStart = source.indexOf('{/* Communication */}');
    const commBlockEnd = source.indexOf("{error &&");
    const clientBlock = source.slice(clientBlockStart, clientBlockEnd);
    const commBlock = source.slice(commBlockStart, commBlockEnd);
    assert.ok(!clientBlock.includes("canMutateOperationalData"));
    assert.ok(!commBlock.includes("canMutateOperationalData"));
  });

  test("Notes section remains unconditional", () => {
    const notesStart = source.indexOf('{/* Notes */}');
    const notesEnd = source.indexOf('{/* Communication */}');
    assert.notEqual(notesStart, -1);
    const block = source.slice(notesStart, notesEnd);
    assert.ok(!block.includes("canMutateOperationalData"));
  });
});

describe("no navigation/map action exists in this file to separately govern", () => {
  test("this file has no map/directions link or button beyond the tel:/sms: contact links already asserted as unconditional read-only actions", () => {
    assert.ok(!source.includes("maps.google") && !source.includes("geo:") && !/href=\{`https?:\/\/[^`]*map/i.test(source));
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
      assert.ok(!source.includes(forbidden), `MobileAppointmentDetail.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `MobileAppointmentDetail.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("mouse/touch/keyboard/repeated-activation guarantee (delegated proof)", () => {
  // These tests intentionally make no DOM assertion of their own -- .tsx
  // files cannot be rendered by this repo's test runner (see file header).
  // They exist to make the delegation explicit and keep it from silently
  // going unverified: CapabilityGatedButton.test.ts's "restricted -- no
  // click can initiate a request" describe block (7 tests, covering mouse
  // click, keyboard Enter, keyboard Space, and repeated activation all
  // invoking onClick zero times while restricted, plus disabled/aria-
  // disabled attribute presence) is the actual rendered interaction proof,
  // and it applies unmodified to BOTH of this file's governed controls,
  // since each renders that exact component with
  // allowed={canMutateOperationalData} and no additional inline-arrow
  // wrapping beyond its own named local handler that could reintroduce a
  // bypass.
  test("Cancel: onClick is passed as the named handleCancel handler, not an inline arrow wrapper", () => {
    const idx = source.indexOf("onClick={handleCancel}");
    const block = source.slice(Math.max(0, idx - 200), idx + 50);
    assert.match(block, /<CapabilityGatedButton/);
    assert.ok(!block.includes("onClick={() =>"), "onClick must be passed directly (handleCancel), not wrapped, so CapabilityGatedButton's own guard is the only gate");
  });

  test("Edit: onClick is passed as the named handleEditClick handler, not an inline arrow wrapper", () => {
    const idx = source.indexOf("onClick={handleEditClick}");
    const block = source.slice(Math.max(0, idx - 200), idx + 50);
    assert.match(block, /<CapabilityGatedButton/);
    assert.ok(!block.includes("onClick={() =>"), "onClick must be passed directly (handleEditClick), not wrapped, so CapabilityGatedButton's own guard is the only gate");
  });
});
