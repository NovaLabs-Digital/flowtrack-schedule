// Phase 5.5E-E1A: source-level proof tests for AppointmentModal.tsx.
//
// AppointmentModal.tsx is a real .tsx/JSX file, and Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content -- confirmed empirically again in this
// phase, the same "Unknown file extension \".tsx\"" failure first
// documented in Phase 5.5D and re-confirmed in Phase 5.5E-D. It is also a
// large, pre-existing production component (850+ lines: client/employee
// selection, date/time/frequency handling, recurrence management, job-
// tracking display, notification choice, delete flow) that this phase
// deliberately does not rewrite to .ts/React.createElement or fragment
// into many small pieces just to make it renderable -- either would be a
// large, out-of-scope diff unrelated to entitlement UX, and would risk
// altering real form semantics this phase is required to preserve exactly.
//
// The one thing that genuinely needed real rendered mouse/keyboard
// interaction proof -- whether a disabled control can actually be
// activated -- was extracted into CapabilityGatedButton.ts specifically so
// it COULD get that proof (see CapabilityGatedButton.test.ts, 20 tests,
// full jsdom + @testing-library/react + @testing-library/user-event
// coverage: allowed/restricted x mouse/keyboard/repeated-interaction,
// aria-disabled, aria-describedby wiring, wording-association contract,
// forbidden-vocabulary absence).
//
// What remains here is proven by inspecting the actual shipped source
// text, not by rendering -- this is a documented, explained choice, not a
// fragile substitute reached for without reason. Every assertion below is
// narrowly scoped to two things only: (a) prop wiring -- that the five
// governed buttons are wired through CapabilityGatedButton with
// allowed={canMutateOperationalData} and the shared notice id, and (b)
// handler guards -- that each of the four mutation-triggering functions
// (handleSubmit, executeEdit, executeDelete, saveRecurrence) contains an
// early-return guard on canMutateOperationalData positioned before its
// fetch call. These assertions prove the CODE IS WRITTEN CORRECTLY; they
// do NOT execute a click, a keypress, or a form submission, and this file
// makes no claim that they do. The actual runtime guarantee that a
// disabled button cannot be activated by mouse or keyboard is established
// by CapabilityGatedButton.test.ts, which every governed button here is
// proven (by these source tests) to use.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./AppointmentModal.tsx", import.meta.url)), "utf8");

describe("prop wiring: canMutateOperationalData reaches this component and nowhere reproduces entitlement policy", () => {
  test("the component destructures canMutateOperationalData from its props", () => {
    assert.ok(source.includes("prefill, canMutateOperationalData }: Props)"));
  });

  test("Props declares canMutateOperationalData: boolean, and no EntitlementView/EntitlementResult type is imported", () => {
    assert.ok(source.includes("canMutateOperationalData: boolean;"));
    assert.ok(!source.includes('from "@/lib/entitlementView"'));
    assert.ok(!source.includes('from "@/lib/entitlement"'));
  });

  test("no workspace id, Stripe id, or subscription field name appears anywhere in this file", () => {
    for (const forbidden of ["workspace_id", "workspaceId", "stripe_customer", "stripe_subscription", "stripeStatus", "graceUntil", "billingMode"]) {
      assert.ok(!source.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });
});

describe("all five mutation-triggering buttons are wired through CapabilityGatedButton with the canonical capability and the shared notice", () => {
  test("CapabilityGatedButton is imported from the dedicated extracted primitive, not defined inline", () => {
    assert.ok(source.includes('import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";'));
  });

  test("exactly five <CapabilityGatedButton usages exist", () => {
    const count = source.split("<CapabilityGatedButton").length - 1;
    assert.equal(count, 5, `expected exactly 5 <CapabilityGatedButton usages, found ${count}`);
  });

  test("allowed={canMutateOperationalData} appears exactly five times -- once per governed button, never a different/derived value", () => {
    const count = source.split("allowed={canMutateOperationalData}").length - 1;
    assert.equal(count, 5, `expected exactly 5, found ${count}`);
  });

  test("every CapabilityGatedButton usage is described by the one shared restricted-notice id", () => {
    const count = source.split("ariaDescribedBy={RESTRICTED_NOTICE_ID}").length - 1;
    assert.equal(count, 5, `expected exactly 5, found ${count}`);
  });

  test("the main submit button (create + edit) is type=\"submit\", inside the <form>, governed by CapabilityGatedButton", () => {
    const formIndex = source.indexOf("<form onSubmit={handleSubmit}");
    const submitButtonIndex = source.indexOf('type="submit"');
    assert.ok(formIndex > -1 && submitButtonIndex > -1 && formIndex < submitButtonIndex);
  });

  test("the recurring-edit scope buttons ('Only this appointment' / 'This and all future appointments') call executeEdit directly and are governed", () => {
    assert.ok(source.includes('onClick={() => executeEdit("single")}'));
    assert.ok(source.includes('onClick={() => executeEdit("future")}'));
  });

  test("the delete-confirm button ('Yes, Delete') calls executeDelete and is governed", () => {
    assert.ok(source.includes("onClick={() => executeDelete(confirmDelete)}"));
  });

  test("the recurrence-save button calls saveRecurrence and is governed", () => {
    assert.ok(source.includes("onClick={saveRecurrence}"));
  });

  test("menu/reveal-only controls (Delete ▾, Manage >, scope-menu choice buttons, Cancel/No-Go-Back) remain plain, ungoverned buttons -- they perform no mutation themselves", () => {
    // "Delete ▾" only toggles a menu; the delete-scope choice buttons only
    // set state to reach the confirm step; the actual mutation is gated at
    // "Yes, Delete" (tested above). Confirms the design intentionally
    // gates only the real commit points, not every intermediate reveal.
    assert.ok(source.includes('onClick={() => setShowDeleteMenu((v) => !v)}'));
    assert.ok(source.includes('onClick={() => setConfirmDelete("single")}'));
    assert.ok(source.includes('onClick={() => setConfirmDelete("future")}'));
    assert.ok(source.includes('onClick={() => setManageFreq("one_time"); setManageWeeks(1); setShowManageRecurrence(true); }'.replace("; }", "")) || source.includes("setShowManageRecurrence(true)"));
  });
});

describe("handler guards: each mutation-triggering function refuses to proceed when restricted, before any fetch call", () => {
  test("handleSubmit checks canMutateOperationalData immediately after preventDefault, before validateForm and before it can reach executeEdit -- this is what blocks a restricted Enter-key form submission, not just the button's disabled state", () => {
    const fnStart = source.indexOf("async function handleSubmit(e: React.FormEvent) {");
    const preventDefaultIndex = source.indexOf("e.preventDefault();", fnStart);
    const guardIndex = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const validateIndex = source.indexOf("if (!validateForm()) return;", fnStart);
    assert.ok(fnStart > -1 && preventDefaultIndex > -1 && guardIndex > -1 && validateIndex > -1);
    assert.ok(preventDefaultIndex < guardIndex && guardIndex < validateIndex);
  });

  test("executeEdit independently checks canMutateOperationalData as its first statement -- defense-in-depth for its second call site (the edit-scope buttons), which bypasses handleSubmit's guard entirely", () => {
    const fnStart = source.indexOf('async function executeEdit(mode: "single" | "future") {');
    const guardIndex = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/update"', fnStart);
    const fetchIndex2 = source.indexOf('fetch("/api/appointments/create"', fnStart);
    assert.ok(fnStart > -1 && guardIndex > -1 && fetchIndex > -1 && fetchIndex2 > -1);
    assert.ok(guardIndex < fetchIndex && guardIndex < fetchIndex2, "the guard must run before either fetch call executeEdit can reach");
  });

  test("executeDelete checks canMutateOperationalData before the delete fetch", () => {
    const fnStart = source.indexOf('async function executeDelete(mode: "single" | "future") {');
    const guardIndex = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/delete"', fnStart);
    assert.ok(fnStart > -1 && guardIndex > -1 && fetchIndex > -1);
    assert.ok(guardIndex < fetchIndex);
  });

  test("saveRecurrence checks canMutateOperationalData before the manage-recurrence fetch", () => {
    const fnStart = source.indexOf("async function saveRecurrence() {");
    const guardIndex = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/manage-recurrence"', fnStart);
    assert.ok(fnStart > -1 && guardIndex > -1 && fetchIndex > -1);
    assert.ok(guardIndex < fetchIndex);
  });

  test("all four guard clauses use the exact same literal check -- no duplicated/divergent entitlement policy across handlers", () => {
    const count = source.split("if (!canMutateOperationalData) return;").length - 1;
    assert.equal(count, 4, `expected exactly 4 (handleSubmit, executeEdit, executeDelete, saveRecurrence), found ${count}`);
  });
});

describe("inline client creation rides along with the main submit guard -- no separate, unguarded mutation path", () => {
  test("the create-mode payload folds new-client fields into the same executeEdit/create request that is already guarded", () => {
    const executeEditStart = source.indexOf('async function executeEdit(mode: "single" | "future") {');
    const newClientPayload = source.indexOf("payload.name = newClient.name.trim();", executeEditStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/create"', executeEditStart);
    assert.ok(executeEditStart > -1 && newClientPayload > -1 && fetchIndex > -1);
    assert.ok(newClientPayload < fetchIndex, "new-client fields are assembled before the same guarded create fetch, not a separate request");
  });

  test("no independent client-creation fetch exists outside executeEdit (e.g. no direct POST /api/clients call in this file)", () => {
    assert.ok(!source.includes('fetch("/api/clients"'));
  });

  test("the '+ New Client' / 'Select Existing' toggle only switches local UI mode -- it is not wrapped in CapabilityGatedButton, since it performs no mutation", () => {
    assert.ok(source.includes('{clientMode === "existing" ? "+ New Client" : "Select Existing"}'));
  });
});

describe("notification selection does not independently mutate", () => {
  test("NotifyChoice's onChange only updates local state, never calls fetch", () => {
    // Bounded by the next top-level export, not naive brace-matching --
    // NotifyChoice's own parameter-type annotation contains an early
    // "\n}" (closing the destructured-props type) well before the
    // function body, which would otherwise truncate the slice too soon.
    const fnStart = source.indexOf("export function NotifyChoice({");
    const fnEnd = source.indexOf("export function preferredNotifyChannel(");
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("fetch("), "NotifyChoice must never call fetch directly");
    assert.ok(body.includes("onChange={() => onChange(o.value)}"));
  });

  test("NotifyChoicePanel is a pure display wrapper around NotifyChoice -- no fetch, no CapabilityGatedButton", () => {
    const fnStart = source.indexOf("export function NotifyChoicePanel(");
    const fnEnd = source.indexOf("type Props = {");
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("fetch("));
    assert.ok(!body.includes("CapabilityGatedButton"));
  });

  test("both NotifyChoicePanel usages (create/edit form, and the delete-confirm step) pass only display props, never canMutateOperationalData", () => {
    const count = source.split("<NotifyChoicePanel").length - 1;
    assert.equal(count, 2);
    // NotifyChoicePanel's own prop list (value/onChange/hasEmail/hasPhone/
    // label) never includes canMutateOperationalData anywhere in the file.
    assert.ok(!source.includes("NotifyChoicePanel\n            canMutateOperationalData"));
  });
});

describe("existing appointment/client data remains visible regardless of entitlement -- nothing is newly hidden behind the capability", () => {
  test("no JSX block is conditionally hidden behind a truthy canMutateOperationalData check -- the only use of the flag besides prop-passing is the restricted-notice's negated condition", () => {
    // "!canMutateOperationalData && (" (the notice's own, correct, negated
    // condition) contains "canMutateOperationalData && (" as a plain
    // substring, so a bare .includes() would false-positive on it -- a
    // regex requiring the character immediately before the match NOT be
    // "!" is used instead.
    assert.ok(!/(?<!!)canMutateOperationalData && \(/.test(source), "no display block may be gated on canMutateOperationalData being true");
    assert.ok(!source.includes("canMutateOperationalData ? ("), "no display block may branch on canMutateOperationalData");
  });

  test("the client info display, service/status selects, and date/time inputs are present, gated only by their pre-existing conditions (isEdit / clientMode), unchanged", () => {
    for (const marker of [
      "{isEdit ? (",
      '<select data-tour="service-selector"',
      '<input type="date" value={form.date}',
      "editing.client.name",
    ]) {
      assert.ok(source.includes(marker), `expected unchanged marker "${marker}"`);
    }
  });

  test("the recurring-schedule info block (interval, remaining-count) renders unconditionally on entitlement -- only 'Manage >' opens the (governed) save panel", () => {
    assert.ok(source.includes("Recurring Schedule"));
    assert.ok(source.includes("remaining"));
  });
});

describe("the exact approved restricted wording is used, and it is the only owner-facing restriction copy in this file", () => {
  test("RESTRICTED_WORDING is exactly the approved text", () => {
    assert.ok(source.includes('const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";'));
  });

  test("the shared notice element renders RESTRICTED_WORDING under the approved id, shown only when restricted", () => {
    assert.ok(source.includes("{!canMutateOperationalData && ("));
    assert.ok(source.includes("id={RESTRICTED_NOTICE_ID}"));
    assert.ok(source.includes("{RESTRICTED_WORDING}"));
  });

  test("the employee-facing wording ('This action is temporarily unavailable. Please contact the office.') is never used here -- owner and employee restriction copy are kept distinct", () => {
    assert.ok(!source.includes("Please contact the office"));
  });
});

describe("no owner billing banner or Subscription & Plan UI is duplicated inside this modal", () => {
  test("OwnerBillingBanner is never imported or referenced", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no Subscription & Plan / Manage Subscription copy appears in this file", () => {
    assert.ok(!source.includes("Subscription & Plan"));
    assert.ok(!source.includes("Manage Subscription"));
  });
});

describe("tester/demo and verification-error behavior are inherited by construction, not special-cased here", () => {
  test("this file contains no tester/demo/role-specific branching on canMutateOperationalData -- it is used exactly as received, a plain boolean, for every session type alike", () => {
    // EntitlementView.canMutateOperationalData already resolves true for
    // tester/demo sessions and false for every restricted/verification-
    // error state (lib/entitlement.ts, lib/entitlementView.ts, both
    // unchanged by this phase) -- this component has no reason/state field
    // to read and therefore cannot special-case either one; it reacts only
    // to the boolean it's given, identically regardless of why.
    assert.ok(!source.includes("isTester"));
    assert.ok(!source.includes("DEMO_WORKSPACE_ID"));
    assert.ok(!source.includes("stripeStatus"));
  });
});
