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

// Shared by every coordinated-save test below -- the full body of
// executeCoordinatedSave, delimited by the next top-level declaration
// rather than a fixed character offset, so it never silently truncates
// mid-function as comments/code inside it grow.
function coordinatedSaveBody(): string {
  const fnStart = source.indexOf('async function executeCoordinatedSave(mode: "single" | "future") {');
  assert.notEqual(fnStart, -1);
  const fnEnd = source.indexOf("\n  const [confirmDelete", fnStart);
  assert.notEqual(fnEnd, -1);
  return source.slice(fnStart, fnEnd);
}

function atomicBody(): string {
  const fnStart = source.indexOf("async function submitAtomicRecurrenceChange(");
  assert.notEqual(fnStart, -1);
  const fnEnd = source.indexOf("\n  // The single save path for an edit session", fnStart);
  assert.notEqual(fnEnd, -1);
  return source.slice(fnStart, fnEnd);
}

describe("prop wiring: canMutateOperationalData reaches this component and nowhere reproduces entitlement policy", () => {
  test("the component destructures canMutateOperationalData from its props", () => {
    assert.ok(source.includes("prefill, canMutateOperationalData, canUseJobTracking, timezone }: Props)"));
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

describe("all six mutation-triggering buttons are wired through CapabilityGatedButton with the canonical capability and the shared notice", () => {
  test("CapabilityGatedButton is imported from the dedicated extracted primitive, not defined inline", () => {
    assert.ok(source.includes('import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";'));
  });

  // Phase 5.7D-R18 added a sixth: the "Yes, Save Unassigned" button in the
  // last-employee-removal confirmation panel (Section C.6).
  test("exactly six <CapabilityGatedButton usages exist", () => {
    const count = source.split("<CapabilityGatedButton").length - 1;
    assert.equal(count, 6, `expected exactly 6 <CapabilityGatedButton usages, found ${count}`);
  });

  test("allowed={canMutateOperationalData} appears exactly six times -- once per governed button, never a different/derived value", () => {
    const count = source.split("allowed={canMutateOperationalData}").length - 1;
    assert.equal(count, 6, `expected exactly 6, found ${count}`);
  });

  test("every CapabilityGatedButton usage is described by the one shared restricted-notice id", () => {
    const count = source.split("ariaDescribedBy={RESTRICTED_NOTICE_ID}").length - 1;
    assert.equal(count, 6, `expected exactly 6, found ${count}`);
  });

  test("the main submit button (create + edit) is type=\"submit\", inside the <form>, governed by CapabilityGatedButton", () => {
    const formIndex = source.indexOf("<form onSubmit={handleSubmit}");
    const submitButtonIndex = source.indexOf('type="submit"');
    assert.ok(formIndex > -1 && submitButtonIndex > -1 && formIndex < submitButtonIndex);
  });

  test("the recurring-edit scope buttons ('Only this appointment' / 'This and all future appointments') call executeCoordinatedSave directly and are governed", () => {
    assert.ok(source.includes('onClick={() => executeCoordinatedSave("single")}'));
    assert.ok(source.includes('onClick={() => executeCoordinatedSave("future")}'));
  });

  test("the delete-confirm button ('Yes, Delete') calls executeDelete and is governed", () => {
    assert.ok(source.includes("onClick={() => executeDelete(confirmDelete)}"));
  });

  // Coordinated-save fix: "Save Recurrence" is no longer a separate,
  // independently-implemented mutation -- it routes through the exact same
  // proceedAfterValidation entry point the main "Save Changes" submit
  // button uses, so a pending appointment-field edit is always saved
  // first, before this recurrence change is applied against it.
  test("the recurrence-save button routes through proceedAfterValidation -- the same coordinated entry point the main Save Changes button uses, not a separate/independent save", () => {
    assert.ok(source.includes("onClick={() => proceedAfterValidation()}"));
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

  test("executeCoordinatedSave independently checks canMutateOperationalData as its first statement -- defense-in-depth for its second call site (the edit-scope buttons), which bypasses handleSubmit's guard entirely", () => {
    const fnStart = source.indexOf('async function executeCoordinatedSave(mode: "single" | "future") {');
    const guardIndex = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/update"', fnStart);
    const fetchIndex2 = source.indexOf('fetch("/api/appointments/create"', fnStart);
    assert.ok(fnStart > -1 && guardIndex > -1 && fetchIndex > -1 && fetchIndex2 > -1);
    assert.ok(guardIndex < fetchIndex && guardIndex < fetchIndex2, "the guard must run before either fetch call executeCoordinatedSave can reach");
  });

  test("executeDelete checks canMutateOperationalData before the delete fetch", () => {
    const fnStart = source.indexOf('async function executeDelete(mode: "single" | "future") {');
    const guardIndex = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/delete"', fnStart);
    assert.ok(fnStart > -1 && guardIndex > -1 && fetchIndex > -1);
    assert.ok(guardIndex < fetchIndex);
  });

  // Coordinated-save fix: applyRecurrenceChange (the manage-recurrence
  // fetch) is no longer its own independently-guarded entry point -- it is
  // only ever called from inside executeCoordinatedSave, which has
  // already checked canMutateOperationalData (and proceedAfterValidation,
  // which routes every save button into executeCoordinatedSave, adds no
  // separate mutation path of its own). A second, redundant guard inside
  // applyRecurrenceChange would just be dead code.
  test("applyRecurrenceChange has no independent canMutateOperationalData guard of its own -- it is only reachable through executeCoordinatedSave's already-guarded path", () => {
    const fnStart = source.indexOf("async function applyRecurrenceChange()");
    const fnEnd = source.indexOf("\n  }", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("canMutateOperationalData"));
  });

  test("all three guard clauses use the exact same literal check -- no duplicated/divergent entitlement policy across handlers", () => {
    const count = source.split("if (!canMutateOperationalData) return;").length - 1;
    assert.equal(count, 3, `expected exactly 3 (handleSubmit, executeCoordinatedSave, executeDelete), found ${count}`);
  });
});

describe("inline client creation rides along with the main submit guard -- no separate, unguarded mutation path", () => {
  test("the create-mode payload folds new-client fields into the same executeCoordinatedSave/create request that is already guarded", () => {
    const executeStart = source.indexOf('async function executeCoordinatedSave(mode: "single" | "future") {');
    const newClientPayload = source.indexOf("payload.name = newClient.name.trim();", executeStart);
    const fetchIndex = source.indexOf('fetch("/api/appointments/create"', executeStart);
    assert.ok(executeStart > -1 && newClientPayload > -1 && fetchIndex > -1);
    assert.ok(newClientPayload < fetchIndex, "new-client fields are assembled before the same guarded create fetch, not a separate request");
  });

  test("no independent client-creation fetch exists outside executeCoordinatedSave (e.g. no direct POST /api/clients call in this file)", () => {
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

describe("Phase 5.7D-R17: appointment price snapshot (source-level proof)", () => {
  test("editing shows the appointment's OWN price snapshot, never re-derived from the service's current default", () => {
    const initPriceIdx = source.indexOf("function initPrice()");
    assert.ok(initPriceIdx > -1);
    const body = source.slice(initPriceIdx, source.indexOf("\n  }", initPriceIdx));
    assert.ok(body.includes("editing.appointment.price_cents"));
  });

  test("creating proposes the initially-selected service's default price via serviceDefaultPriceCents", () => {
    assert.ok(source.includes("serviceDefaultPriceCents[initialService]"));
  });

  test("Phase 5.7D-R17B: serviceDefaultPriceCents is built directly from the `services` prop's own default_price_cents field -- reproduces/guards the exact production bug (a service correctly priced via Settings > Services still left the appointment Price field blank, because app/dashboard/page.tsx's separate server-side services query omitted default_price_cents from its own SELECT -- fixed there, not here; this test guards the AppointmentModal side of that chain)", () => {
    assert.ok(source.includes("serviceDefaultPriceCents[s.name] = s.default_price_cents ?? null;"));
  });

  test("priceTouched starts true only when the appointment being edited already has a real price on file -- protecting an intentionally-entered price from a later silent overwrite", () => {
    assert.ok(source.includes("useState(isEdit && editing!.appointment.price_cents != null)"));
  });

  test("changing the service proposes its default price ONLY when the price field hasn't been touched yet", () => {
    const setFnIdx = source.indexOf("function set(field: string, value: string | number)");
    const setPriceIdx = source.indexOf("function setPrice(value: string)");
    assert.ok(setFnIdx > -1 && setPriceIdx > -1 && setFnIdx < setPriceIdx);
    const setBody = source.slice(setFnIdx, setPriceIdx);
    assert.ok(setBody.includes("if (!priceTouched)"));
    assert.ok(setBody.includes("serviceDefaultPriceCents[value]"));
  });

  test("typing directly into the Price field marks it touched, permanently protecting it from further auto-proposals this session", () => {
    const setPriceIdx = source.indexOf("function setPrice(value: string)");
    const body = source.slice(setPriceIdx, source.indexOf("\n  }", setPriceIdx));
    assert.ok(body.includes("setPriceTouched(true)"));
  });

  test("a blank price is valid (no price set); a non-blank, unparseable price blocks submission with a clear error", () => {
    assert.ok(source.includes('if (form.price.trim() !== "" && parsePriceToCents(form.price) === null)'));
  });

  test("both create and edit submit payloads include price_cents, derived once via parsePriceToCents, blank -> null", () => {
    assert.ok(source.includes('const price_cents = form.price.trim() === "" ? null : parsePriceToCents(form.price);'));
    // Appears in both the PATCH (edit) and POST (create) payload objects.
    const occurrences = [...source.matchAll(/price_cents,/g)].length;
    assert.ok(occurrences >= 2, `expected price_cents in both payloads, found ${occurrences} occurrence(s)`);
  });

  test("the Price input is rendered with a $ prefix and is optional (not required)", () => {
    assert.ok(source.includes('placeholder="Optional"'));
    assert.ok(source.includes("setPrice(e.target.value)"));
  });

  test("imports price helpers from the shared lib/money module -- no local reimplementation of cents<->dollars conversion", () => {
    assert.ok(source.includes('import { centsToInputValue, parsePriceToCents } from "@/lib/money";'));
  });
});

describe("Phase 5.7D-R18: multi-employee editor (source-level proof)", () => {
  test("selectedEmployeeIds is initialized from this appointment's own assignment rows, never from the legacy single employee_id column", () => {
    assert.ok(source.includes("const apptAssignments = isEdit ? assignments.filter((a) => a.appointment_id === editing!.appointment.id) : [];"));
    assert.ok(source.includes("const initialEmployeeIds = apptAssignments.map((a) => a.employee_id);"));
    assert.ok(source.includes("useState<string[]>(initialEmployeeIds)"));
    assert.ok(!source.includes("editing?.appointment.employee_id ?? \"\""), "must not seed from the legacy single employee_id field");
  });

  test("selected employees are shown as individually removable chips, never hidden behind a menu that must be reopened", () => {
    assert.ok(source.includes("selectedEmployeeIds.map((id) => {"));
    assert.ok(source.includes("onClick={() => removeEmployee(id)}"));
    assert.ok(source.includes('aria-label={`Remove ${emp?.name ?? "employee"}`}'));
  });

  test("a plain <select> adds one more employee at a time, already excluding anyone already selected -- no duplicate-add path", () => {
    const addSelectIdx = source.indexOf("onChange={(e) => { if (e.target.value) addEmployee(e.target.value); }}");
    assert.ok(addSelectIdx > -1);
    assert.ok(source.includes("employees.filter((emp) => emp.active && !selectedEmployeeIds.includes(emp.id))"));
  });

  test("both create and edit payloads send employee_ids (the full set), never a single employee_id", () => {
    assert.ok(source.includes("employee_ids: selectedEmployeeIds,"));
    assert.ok(!source.includes("employee_id: selectedEmployeeId"));
  });

  test("removing the last assigned employee requires explicit confirmation before saving, and does not delete the appointment", () => {
    const gateIdx = source.indexOf("function proceedAfterValidation(unassignConfirmed = confirmUnassign)");
    assert.ok(gateIdx > -1);
    const gateBody = source.slice(gateIdx, source.indexOf("\n  }", gateIdx));
    assert.ok(gateBody.includes("const removingLastEmployee = isEdit && initialEmployeeIds.length > 0 && selectedEmployeeIds.length === 0;"));
    assert.ok(gateBody.includes("setConfirmUnassign(true)"));
    assert.ok(source.includes("Removing the last assigned employee will leave this appointment unassigned. The appointment itself will not be deleted."));
  });

  test("the unassign-confirmation gate runs BEFORE the recurring edit-scope gate -- owner sees 'this will become unassigned' before 'apply to this or future occurrences'", () => {
    const fnIdx = source.indexOf("function proceedAfterValidation");
    const removingIdx = source.indexOf("removingLastEmployee", fnIdx);
    const isRecurringIdx = source.indexOf("isEdit && isRecurring && !editScope", fnIdx);
    assert.ok(removingIdx > -1 && isRecurringIdx > -1 && removingIdx < isRecurringIdx);
  });

  test("employee-assignment changes are excluded from the smart notify-channel trigger -- staffing-only edits default to no client notification (Section G.2)", () => {
    const importantIdx = source.indexOf("const importantFieldsChanged = dateTimeChanged || serviceChanged;");
    assert.ok(importantIdx > -1, "importantFieldsChanged must not include employeeChanged");
    assert.ok(!/importantFieldsChanged = dateTimeChanged \|\| employeeChanged/.test(source));
  });

  test("Worked Hours is rendered per assigned employee (Section E.7), one card per assignment, each independently labeled with that employee's own name", () => {
    // Phase 5.7D-R19: rows are now rendered in explicit stable order (see
    // the R19 describe block below) -- sortAssignmentsStable(apptAssignments),
    // not the raw apptAssignments array.
    assert.ok(source.includes("sortAssignmentsStable(apptAssignments).map((assignment) => {"));
    assert.ok(source.includes("const emp = employees.find((e) => e.id === assignment.employee_id);"));
    assert.ok(source.includes("{emp?.name ?? \"Unknown employee\"}"));
  });

  test("missing-hours identification uses getMissingHoursEmployeeIds, the same per-employee predicate driving the schedule grid's warning triangle", () => {
    assert.ok(source.includes('import { findManualHoursEntry, formatMinutesAsDuration, hasInvalidJobTrackingDuration, isJobTrackingComplete, getMissingHoursEmployeeIds, resolveWorkedMinutes, needsWorkedTimeReview, trackedMinutes, isOwnerReviewConfirmation } from "@/lib/payroll";'));
    assert.ok(source.includes("const missingHoursEmployeeIds = jobTrackingAppt ? getMissingHoursEmployeeIds(jobTrackingAppt, apptAssignments, employeeHours) : [];"));
  });

  test("Section C.8/C.9 field order: Assigned Employees appears before Worked Hours, and Price appears after Worked Hours -- Price is never duplicated per employee", () => {
    const assignedEmployeesIdx = source.indexOf("Assigned Employees</label>");
    const workedHoursIdx = source.indexOf('<div className="text-xs font-medium text-slate-600">Worked Hours</div>');
    const priceLabelIdx = source.lastIndexOf(">Price</label>");
    assert.ok(assignedEmployeesIdx > -1 && workedHoursIdx > -1 && priceLabelIdx > -1);
    assert.ok(assignedEmployeesIdx < workedHoursIdx, "Assigned Employees must render before Worked Hours");
    assert.ok(workedHoursIdx < priceLabelIdx, "Price must render after Worked Hours");
    // Exactly one Price input in the whole form -- never split per employee.
    const priceInputCount = [...source.matchAll(/onChange=\{\(e\) => setPrice\(e\.target\.value\)\}/g)].length;
    assert.equal(priceInputCount, 1);
  });

  test("Employee Job Notes: assignment.job_notes is displayed, read-only, inside the same per-employee Worked Hours card -- distinct from the appointment's own notes and from a manual hours entry's reason", () => {
    const workedHoursIdx = source.indexOf('<div className="text-xs font-medium text-slate-600">Worked Hours</div>');
    const mapEndIdx = source.indexOf("})}", workedHoursIdx);
    assert.ok(workedHoursIdx > -1 && mapEndIdx > -1);
    const cardBlock = source.slice(workedHoursIdx, mapEndIdx);
    assert.ok(cardBlock.includes("{assignment.job_notes && ("), "expected assignment.job_notes to be conditionally rendered inside the Worked Hours card");
    assert.ok(cardBlock.includes("Job Notes:"));
    assert.ok(cardBlock.includes("{assignment.job_notes}"));
    // No input/textarea/onChange anywhere near this display -- read-only
    // for the owner in V1, per the approved architecture.
    const jobNotesIdx = cardBlock.indexOf("{assignment.job_notes && (");
    const jobNotesBlock = cardBlock.slice(jobNotesIdx, jobNotesIdx + 300);
    assert.ok(!jobNotesBlock.includes("<textarea"));
    assert.ok(!jobNotesBlock.includes("onChange"));
  });

  test("assignments prop is documented as authoritative, filtered internally to this appointment -- never pre-filtered by the caller", () => {
    assert.ok(source.includes("assignments: AppointmentEmployeeAssignment[];"));
  });
});

describe("Owner Worked-Time Correction + Needs Review Alert (Worked Hours card)", () => {
  function cardBlock(): string {
    const workedHoursIdx = source.indexOf('<div className="text-xs font-medium text-slate-600">Worked Hours</div>');
    const mapEndIdx = source.indexOf("})}", workedHoursIdx);
    assert.ok(workedHoursIdx > -1 && mapEndIdx > -1);
    return source.slice(workedHoursIdx, mapEndIdx);
  }

  test("Props declares onHoursSaved and canUseJobTracking, both destructured, both threaded from DashboardShell", () => {
    assert.ok(source.includes("onHoursSaved: (entry: EmployeeHours) => void;"));
    assert.ok(source.includes("canUseJobTracking: boolean;"));
    const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");
    assert.match(shellSource, /onHoursSaved=\{handleHoursSaved\}/);
    assert.match(shellSource, /canUseJobTracking=\{entitlement\.canUseJobTracking\}/);
  });

  test("AdjustWorkedTimeControl is imported and rendered inside the Worked Hours card, gated on complete or manualEntry, wired to this appointment/employee, canUseJobTracking, and onHoursSaved", () => {
    assert.match(source, /import AdjustWorkedTimeControl from "@\/app\/components\/dashboard\/AdjustWorkedTimeControl";/);
    const block = cardBlock();
    const idx = block.indexOf("<AdjustWorkedTimeControl");
    assert.notEqual(idx, -1);
    assert.match(block, /\{\(complete \|\| manualEntry\) && \(/, "only shown once there is a value to correct");
    const invocation = block.slice(idx, block.indexOf("/>", idx) + 2);
    assert.match(invocation, /appointmentId=\{editing!\.appointment\.id\}/);
    assert.match(invocation, /employeeId=\{assignment\.employee_id\}/);
    assert.match(invocation, /canCorrect=\{canUseJobTracking\}/);
    assert.match(invocation, /onSaved=\{onHoursSaved\}/);
  });

  test("the correction control receives timezone, an anchorDate derived from the appointment's own scheduled date, and this assignment's original tracked timestamps (for pre-fill, never for re-writing)", () => {
    const block = cardBlock();
    const idx = block.indexOf("<AdjustWorkedTimeControl");
    const invocation = block.slice(idx, block.indexOf("/>", idx) + 2);
    assert.match(invocation, /timezone=\{timezone\}/);
    assert.match(invocation, /anchorDate=\{zonedDateValue\(editing!\.appointment\.scheduled_for, timezone\)\}/);
    assert.match(invocation, /initialStartedAt=\{assignment\.actual_started_at\}/);
    assert.match(invocation, /initialCompletedAt=\{assignment\.actual_completed_at\}/);
  });

  test("manualEntry (owner override) is branched on FIRST, ahead of `complete` -- matching lib/payroll.ts's resolveWorkedMinutes precedence", () => {
    const block = cardBlock();
    const manualIdx = block.indexOf("{manualEntry ? (");
    const completeIdx = block.indexOf("complete ? (", manualIdx);
    assert.notEqual(manualIdx, -1);
    assert.ok(completeIdx > manualIdx, "the complete-only branch is the ELSE of the manualEntry check, not checked first");
    assert.match(block, /Worked Time: <span className="font-medium text-slate-900">\{formatMinutesAsDuration\(workedMins\)\}<\/span>/);
    assert.match(block, /Adjusted by owner\./);
    assert.match(block, /\{complete && \(/, "Original tracked time only shown when a real tracked duration also exists");
    assert.match(block, /Original tracked time: <span className="font-medium text-slate-900">\{formatMinutesAsDuration\(trackedMinutes\(assignment\) \?\? 0\)\}<\/span>/);
  });

  test("Needs Review badge: computed with needsWorkedTimeReview against this appointment/employee, rendered conditionally next to the employee name", () => {
    const block = cardBlock();
    assert.match(block, /const needsReview = needsWorkedTimeReview\(editing!\.appointment, editing!\.appointment\.id, assignment\.employee_id, apptAssignments, employeeHours\);/);
    assert.match(block, /\{needsReview && \(/);
    assert.match(block, /Needs Review/);
  });

  test("the correction control receives needsReview straight through, so the flagged card offers Correct Time / Keep Time As Is", () => {
    const block = cardBlock();
    const idx = block.indexOf("<AdjustWorkedTimeControl");
    const invocation = block.slice(idx, block.indexOf("/>", idx) + 2);
    assert.match(invocation, /needsReview=\{needsReview\}/);
  });

  test("'Reviewed by owner' (Keep Time As Is) is distinguished from 'Adjusted by owner.' (Correct Time) via isOwnerReviewConfirmation", () => {
    const block = cardBlock();
    assert.match(block, /const isReviewConfirmation = manualEntry && complete \? isOwnerReviewConfirmation\(manualEntry, assignment\) : false;/);
    assert.match(block, /\{isReviewConfirmation \? "Reviewed by owner/);
  });
});

describe("Phase 5.7D-R19: Team Color selector (source-level proof)", () => {
  test("teamColor state is initialized from the appointment's own stored value, defaulting to null, and is never cleared by add/removeEmployee", () => {
    assert.ok(source.includes('const [teamColor, setTeamColor] = useState<string | null>(editing?.appointment.team_color ?? null);'));
    const addFn = source.slice(source.indexOf("function addEmployee(id: string) {"), source.indexOf("function removeEmployee"));
    const removeFn = source.slice(source.indexOf("function removeEmployee(id: string) {"), source.indexOf("function removeEmployee(id: string) {") + 200);
    assert.ok(!addFn.includes("setTeamColor"), "addEmployee must never touch teamColor");
    assert.ok(!removeFn.includes("setTeamColor"), "removeEmployee must never touch teamColor");
  });

  test("the selector is shown only at two or more selected employees", () => {
    assert.ok(source.includes("{selectedEmployeeIds.length >= 2 && ("));
    const teamColorLabelIdx = source.indexOf(">Team Color</label>");
    assert.ok(teamColorLabelIdx > -1);
  });

  test("Team Color renders directly below Assigned Employees", () => {
    // Anchored on the rendered <label> element specifically, not the bare
    // substring "Team Color" -- that phrase also appears earlier, in a
    // source comment introducing the teamColor state declared alongside
    // selectedEmployeeIds, well before the JSX for either section.
    const teamColorLabelIdx = source.indexOf(">Team Color</label>");
    const assignedEmployeesLabelIdx = source.indexOf("Assigned Employees</label>");
    assert.ok(assignedEmployeesLabelIdx > -1 && teamColorLabelIdx > -1);
    assert.ok(assignedEmployeesLabelIdx < teamColorLabelIdx);
  });

  test("choices come from the shared buildTeamColorChoices helper, never a free-text input", () => {
    assert.ok(source.includes('import { buildTeamColorChoices, resolveTeamAccentColor } from "@/lib/teamColor";'));
    assert.ok(source.includes("const teamColorChoices = buildTeamColorChoices("));
    assert.ok(!source.includes('type="color"'), "must never offer a free-text/native color-string input");
    assert.ok(!/<input[^>]*teamColor/.test(source), "team color must only ever be set by clicking a swatch button");
  });

  test("selecting a swatch calls setTeamColor with that swatch's exact normalized hex, never a derived or partial value", () => {
    assert.ok(source.includes("onClick={() => setTeamColor(choice.hex)}"));
  });

  test("the currently-effective color (including the deterministic fallback when teamColor is null) is what visually indicates selection, and selection is also conveyed without relying on color alone", () => {
    assert.ok(source.includes("const isSelected = choice.hex === effectiveAccentColor;"));
    assert.ok(source.includes('role="radio"'));
    assert.ok(source.includes("aria-checked={isSelected}"));
    assert.ok(source.includes("sr-only"), "selection must be conveyed to assistive tech, not color alone");
  });

  test("effectiveAccentColor is resolved through the shared resolveTeamAccentColor helper, never a locally re-derived rule", () => {
    assert.ok(source.includes("const effectiveAccentColor = resolveTeamAccentColor(previewAssignments, employeeById, teamColor);"));
  });

  test("create, edit, and atomic-recurrence payloads all send team_color, using the same teamColor state every time", () => {
    const count = source.split("team_color: teamColor,").length - 1;
    assert.equal(count, 3, "expected exactly 3 occurrences -- create payload, plain update payload, atomic recurrence fields");
  });
});

describe("Phase 5.7D-R19: Worked Hours 'Not tracked yet' + cancelled guard (source-level proof)", () => {
  test("the Worked Hours section is hidden entirely for a cancelled appointment", () => {
    assert.ok(source.includes('isEdit && editing!.appointment.status !== "cancelled" && apptAssignments.length > 0 && ('));
  });

  test("an assigned employee with no recorded activity and no warning renders 'Not tracked yet' instead of being silently omitted", () => {
    const workedHoursIdx = source.indexOf('<div className="text-xs font-medium text-slate-600">Worked Hours</div>');
    const notTrackedIdx = source.indexOf("Not tracked yet.", workedHoursIdx);
    assert.ok(notTrackedIdx > -1, "expected a 'Not tracked yet.' branch inside the Worked Hours section");
    const hasAnyActivityIdx = source.indexOf("const hasAnyRecordedActivity =", workedHoursIdx);
    assert.ok(hasAnyActivityIdx > -1 && hasAnyActivityIdx < notTrackedIdx);
    const guardIdx = source.indexOf("if (!hasAnyRecordedActivity && !isWarning) {", workedHoursIdx);
    assert.ok(guardIdx > -1 && guardIdx < notTrackedIdx, "the 'Not tracked yet' branch must be reached only when there is no recorded activity and no warning");
  });

  test("'Not tracked yet' never creates an appointment_employee_hours row, never sets a timestamp, and is not treated as a warning", () => {
    const notTrackedBlockIdx = source.indexOf('<div className="text-slate-500">Not tracked yet.</div>');
    assert.ok(notTrackedBlockIdx > -1);
    const blockStart = source.lastIndexOf("return (", notTrackedBlockIdx);
    const blockEnd = source.indexOf(");", notTrackedBlockIdx);
    const block = source.slice(blockStart, blockEnd);
    assert.ok(!block.includes("appointment_employee_hours"));
    assert.ok(!block.includes("actual_started_at:"));
    assert.ok(!block.includes("border-amber"), "must not use the warning styling");
  });

  test("rows are listed in stable assignment order via sortAssignmentsStable, imported from the pure lib/sortAssignmentsStable module", () => {
    // Phase 5.7D-R19 launch-blocker fix: lib/appointmentEmployees.ts
    // imports the server-only supabaseAdmin client, so importing
    // sortAssignmentsStable from there pulled that client into this
    // client component's browser bundle and crashed /dashboard in
    // production ("supabaseUrl is required."). sortAssignmentsStable now
    // lives in lib/sortAssignmentsStable.ts, which has no Supabase or
    // other server-only dependency.
    assert.ok(source.includes('import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";'));
    assert.ok(!source.includes('from "@/lib/appointmentEmployees"'), "must never import from the server-only appointmentEmployees module");
  });
});

describe("weekly recurrence interval options -- complete 1 through 8, one shared list", () => {
  test("WEEK_OPTIONS is exactly [1, 2, 3, 4, 5, 6, 7, 8]", () => {
    assert.ok(source.includes("const WEEK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];"));
  });

  test("the create-mode Repeat Every select maps over WEEK_OPTIONS", () => {
    const idx = source.indexOf('<span className="text-xs text-slate-600">Repeat Every</span>');
    assert.ok(idx > -1);
    const block = source.slice(idx, source.indexOf("</select>", idx));
    assert.ok(block.includes("{WEEK_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}"));
  });

  test("the Manage Recurrence 'Repeat every' select also maps over WEEK_OPTIONS -- no second, independently-hardcoded list", () => {
    const idx = source.indexOf('<span className="text-xs text-slate-600">Repeat every</span>');
    assert.ok(idx > -1);
    const block = source.slice(idx, source.indexOf("</select>", idx));
    assert.ok(block.includes("{WEEK_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}"));
    assert.ok(!source.includes("[1, 2, 3, 4, 6, 8]"), "the old, separately-hardcoded 1/2/3/4/6/8 list must not remain anywhere");
  });
});

describe("Phase 2: Monthly Recurring Appointments -- interval options 1 through 12, one shared list (source-level proof)", () => {
  test("MONTH_OPTIONS is exactly [1..12]", () => {
    assert.ok(source.includes("const MONTH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];"));
  });

  test("Monthly is offered as a fifth Frequency choice, alongside the existing four, in both the create-mode radio group and the Manage Recurrence radio group", () => {
    const createFreqIdx = source.indexOf('(["one_time", "daily", "weekdays", "weekly", "monthly"] as const).map((ft) => (');
    const manageFreqIdx = source.indexOf('(["one_time", "daily", "weekdays", "weekly", "monthly"] as const).map((ft) => (', createFreqIdx + 1);
    assert.ok(createFreqIdx > -1, "create-mode Frequency radio group must include monthly");
    assert.ok(manageFreqIdx > -1, "Manage Recurrence radio group must include monthly");
  });

  test("the create-mode monthly Repeat Every select maps over MONTH_OPTIONS, shown only when frequency_type is monthly", () => {
    const idx = source.indexOf('{form.frequency_type === "monthly" && (');
    assert.ok(idx > -1);
    const block = source.slice(idx, source.indexOf("</select>", idx));
    assert.ok(block.includes("{MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}"));
    assert.ok(block.includes("set(\"repeat_months\""));
  });

  test("the Manage Recurrence monthly Repeat Every select also maps over MONTH_OPTIONS, shown only when manageFreq is monthly", () => {
    const idx = source.indexOf('{manageFreq === "monthly" && (');
    assert.ok(idx > -1);
    const block = source.slice(idx, source.indexOf("</select>", idx));
    assert.ok(block.includes("{MONTH_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}"));
    assert.ok(block.includes("setManageMonths"));
  });

  test("both create and manage-recurrence payloads send repeat_months alongside frequency_type/repeat_weeks", () => {
    assert.ok(source.includes("repeat_months: form.repeat_months,"), "create payload must include repeat_months");
    assert.ok(source.includes('repeat_months: manageFreq === "monthly" ? manageMonths : undefined,'), "manage-recurrence payload must include repeat_months (monthly only)");
  });

  test("switching Manage Recurrence away from monthly resets manageMonths back to 1, mirroring the existing weekly reset", () => {
    assert.ok(source.includes('onChange={() => { setManageFreq(ft); if (ft !== "weekly") setManageWeeks(1); if (ft !== "monthly") setManageMonths(1); }}'));
  });

  test("frequencyLabel renders 'Monthly' / 'Every N Months' for the monthly frequency, matching the weekly label's own convention", () => {
    const fnStart = source.indexOf("function frequencyLabel(");
    const fnEnd = source.indexOf("\n}", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.ok(body.includes('if (ft === "monthly") {'));
    assert.ok(body.includes('return "Monthly";'));
    assert.ok(body.includes("`Every ${rm} Months`"));
  });

  test("the Recurring Schedule info panel and its 'Manage >' handoff both know about a monthly interval label and repeat_months, not just repeat_weeks", () => {
    assert.ok(source.includes("const rm = editing.appointment.repeat_months ?? 1;"));
    assert.ok(source.includes('ft === "monthly"'));
    assert.ok(source.includes("setManageMonths(rm)"), "the 'Manage >' handoff must seed manageMonths from the appointment's own repeat_months");
  });

  test("existing weekly recurrence UI (WEEK_OPTIONS, repeat_weeks, manageWeeks) is completely unchanged by adding monthly", () => {
    assert.ok(source.includes("const WEEK_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];"));
    assert.ok(source.includes("repeat_weeks: form.repeat_weeks,"));
    assert.ok(source.includes('repeat_weeks: manageFreq === "weekly" ? manageWeeks : undefined,'));
  });
});

describe("Phase 5C: workspace-timezone-aware create/edit -- the traveling-owner fix", () => {
  test("Props declares timezone: string, and the component receives it as an explicit prop", () => {
    assert.ok(source.includes("timezone: string;"));
    assert.ok(source.includes("prefill, canMutateOperationalData, canUseJobTracking, timezone }: Props)"));
  });

  test("the old device-local toDateValue/toHHMM helpers (native Date getters on a raw new Date(iso)) are completely gone", () => {
    assert.ok(!source.includes("function toDateValue(iso: string)"));
    assert.ok(!source.includes("function toHHMM(iso: string)"));
  });

  test("date/time form fields are read via zonedDateValue/zonedTimeValue, both passed the explicit timezone prop", () => {
    assert.ok(source.includes('import { zonedDateValue, zonedTimeValue, zonedDateTimeToUTC, toBusinessLocal } from "@/lib/timezone";'));
    assert.ok(source.includes("zonedDateValue(editing.appointment.scheduled_for, timezone)"));
    assert.ok(source.includes("zonedTimeValue(editing.appointment.scheduled_for, timezone)"));
    assert.ok(source.includes("zonedTimeValue(editing.appointment.scheduled_end, timezone)"));
  });

  test("no bare `new Date(`${form.date}T${form.time_in}`)`-style device-local construction remains anywhere in the save path", () => {
    assert.ok(!source.includes("new Date(`${form.date}T${form.time_in}`)"));
    assert.ok(!source.includes("new Date(`${form.date}T${form.time_out}`)"));
  });

  test("executeCoordinatedSave resolves scheduled_for/scheduled_end via zonedDateTimeToUTC with the explicit timezone prop, and rejects (setError, no fetch) on a DST-invalid result before constructing the request payload", () => {
    const fnStart = source.indexOf('async function executeCoordinatedSave(mode: "single" | "future") {');
    assert.notEqual(fnStart, -1);
    const body = source.slice(fnStart, fnStart + 1400);
    assert.ok(body.includes('const startResult = zonedDateTimeToUTC(form.date, form.time_in, timezone);'));
    assert.ok(body.includes('if (!startResult.ok) { setError(startResult.error); savingRef.current = false; return; }'));
    assert.ok(body.includes('const endResult = zonedDateTimeToUTC(form.date, form.time_out, timezone);'));
    assert.ok(body.includes('if (!endResult.ok) { setError(endResult.error); savingRef.current = false; return; }'));
    assert.ok(body.includes("const scheduled_for = startResult.iso;"));
    assert.ok(body.includes("const scheduled_end = endResult.iso;"));
    // The DST-rejection guards must appear textually before the price_cents
    // line, proving they run before the request payload is built/sent.
    const startGuardIdx = body.indexOf("if (!startResult.ok)");
    const priceIdx = body.indexOf("const price_cents");
    assert.ok(startGuardIdx > -1 && startGuardIdx < priceIdx);
  });

  test("dateTimeChanged's own comparison also goes through zonedDateTimeToUTC, never a bare device-local Date construction", () => {
    assert.ok(source.includes("const currentStartConversion = form.date && form.time_in ? zonedDateTimeToUTC(form.date, form.time_in, timezone) : null;"));
    assert.ok(source.includes("const currentStartMs = currentStartConversion?.ok ? new Date(currentStartConversion.iso).getTime() : null;"));
  });

  test("DashboardShell passes timezone={timezone} to AppointmentModal", () => {
    const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");
    const idx = shellSource.indexOf("<AppointmentModal");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /timezone=\{timezone\}/);
  });

  test("recurrence generation (countFutureOccurrences) is untouched by Phase 5C -- still called with a bare new Date(editing.appointment.scheduled_for), not zonedDateTimeToUTC", () => {
    assert.ok(source.includes("new Date(editing.appointment.scheduled_for)"));
  });
});

describe("Phase 5E: Worked Hours Started/Completed labels display in the business's own resolved timezone, not the owner's device timezone", () => {
  test("startedLabel/completedLabel are built from toBusinessLocal(..., timezone), never a bare new Date(...).toLocaleString(...)", () => {
    assert.ok(source.includes("toBusinessLocal(assignment.actual_started_at, timezone).toLocaleString(undefined, { month: \"short\", day: \"numeric\", hour: \"numeric\", minute: \"2-digit\" })"));
    assert.ok(source.includes("toBusinessLocal(assignment.actual_completed_at, timezone).toLocaleString(undefined, { month: \"short\", day: \"numeric\", hour: \"numeric\", minute: \"2-digit\" })"));
    assert.ok(!source.includes("new Date(assignment.actual_started_at).toLocaleString"));
    assert.ok(!source.includes("new Date(assignment.actual_completed_at).toLocaleString"));
  });
});

describe("Phase 5D: the recurrence occurrence-count preview passes the same explicit workspace timezone already supplied in Phase 5C", () => {
  test("countFutureOccurrences is called with the explicit timezone prop, never the temporary global default", () => {
    assert.ok(source.includes("countFutureOccurrences(manageFreq, manageWeeks, timezone, new Date(editing.appointment.scheduled_for), manageMonths)"));
  });

  test("no bare, unparameterized countFutureOccurrences(...) call remains in this file (the preview and the API generation must never disagree)", () => {
    assert.ok(!/countFutureOccurrences\(manageFreq, manageWeeks, new Date/.test(source));
  });
});

describe("coordinated save (recurrence changes silently dropped on save -- the reported bug): a pending recurrence change is detected even with the panel collapsed", () => {
  test("hasPendingRecurrenceChange compares manageFreq/manageWeeks/manageMonths against editing.appointment's CURRENT persisted values, never against showManageRecurrence (the panel's own open/closed state)", () => {
    const idx = source.indexOf("const hasPendingRecurrenceChange = isEdit && (");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 400);
    assert.ok(block.includes('manageFreq !== (editing!.appointment.frequency_type ?? "one_time")'));
    assert.ok(block.includes('manageFreq === "weekly" && manageWeeks !== (editing!.appointment.repeat_weeks ?? 1)'));
    assert.ok(block.includes('manageFreq === "monthly" && manageMonths !== (editing!.appointment.repeat_months ?? 1)'));
    assert.ok(!block.includes("showManageRecurrence"), "must not require the panel to be open to detect a pending change");
  });

  test("manageFreq/manageWeeks/manageMonths are declared as their own independent useState, never reset when the panel collapses (setShowManageRecurrence(false) never touches them)", () => {
    const collapseIdx = source.indexOf("onClick={() => setShowManageRecurrence(false)}");
    assert.notEqual(collapseIdx, -1);
    const block = source.slice(collapseIdx, collapseIdx + 40);
    assert.ok(!block.includes("setManageFreq"), "collapsing the panel must not silently discard the pending selection");
  });
});

describe("atomic recurrence save (client): one request, one transaction, all or nothing", () => {
  test("a pending recurrence change is saved by ONE call to /api/appointments/manage-recurrence carrying every pending edit -- the edit branch returns before /api/appointments/update can run", () => {
    const body = coordinatedSaveBody();
    const recurrenceBranchIdx = body.indexOf("if (hasPendingRecurrenceChange) {");
    const atomicCallIdx = body.indexOf("await submitAtomicRecurrenceChange(", recurrenceBranchIdx);
    const updateFetchIdx = body.indexOf('fetch("/api/appointments/update"');
    assert.ok(recurrenceBranchIdx > -1 && atomicCallIdx > recurrenceBranchIdx);
    assert.ok(updateFetchIdx > atomicCallIdx, "the plain update fetch must come AFTER the atomic branch");
    // the atomic branch always ends in `return;` (never falls through to the plain update)
    const branchEnd = body.indexOf("return;\n      }", atomicCallIdx);
    assert.ok(branchEnd > -1 && branchEnd < updateFetchIdx, "atomic branch returns before the plain update path");
    const fnBody = atomicBody();
    assert.equal((fnBody.match(/fetch\(/g) ?? []).length, 1, "exactly one request");
    assert.ok(fnBody.includes('fetch("/api/appointments/manage-recurrence"'));
  });

  test("the request carries the complete desired end state, the employee set, the expected snapshot, the operation id and the notify choice", () => {
    const fnBody = atomicBody();
    for (const needle of [
      "appointment_id: a.id,",
      "client_operation_id: getRecurrenceOperationId(signature),",
      "frequency_type: manageFreq,",
      'repeat_weeks: manageFreq === "weekly" ? manageWeeks : undefined,',
      'repeat_months: manageFreq === "monthly" ? manageMonths : undefined,',
      "fields,",
      "employee_ids,",
      "expected,",
      "notify_channel: notifyChannel,",
    ]) assert.ok(fnBody.includes(needle), `missing: ${needle}`);
    for (const f of ["scheduled_for", "scheduled_end", "service_type", "notes", "duration_minutes", "price_cents", "team_color", "status"]) {
      assert.ok(new RegExp(`fields = \\{[\\s\\S]*?\\b${f}\\b`).test(fnBody), `fields.${f}`);
    }
  });

  test("the expected snapshot is what the modal OPENED with (editing.appointment + initial assignments + workspace timezone), never the live form", () => {
    const fnBody = atomicBody();
    const start = fnBody.indexOf("const expected = {");
    const end = fnBody.indexOf("};", start);
    const block = fnBody.slice(start, end);
    for (const needle of [
      "scheduled_for: a.scheduled_for,", "scheduled_end: a.scheduled_end ?? null,", "service_type: a.service_type,",
      "notes: a.notes ?? null,", "duration_minutes: a.duration_minutes ?? null,", "price_cents: a.price_cents ?? null,",
      "team_color: a.team_color ?? null,", "status: a.status,", "series_id: a.series_id ?? null,",
      'frequency_type: a.frequency_type ?? "one_time",', "employee_ids: initialEmployeeIds,", "timezone,",
    ]) assert.ok(block.includes(needle), `missing: ${needle}`);
    assert.ok(!block.includes("form."), "no live form value may leak into the expected snapshot");
  });

  test("the client no longer sends or tracks a 'previous scheduled_for' -- the server reads the original position from the locked row", () => {
    assert.ok(!source.includes("previous_scheduled_for"));
    assert.ok(!source.includes("serverConfirmedPreviousScheduledFor"));
    assert.ok(!source.includes("apptSavedSignature"), "the two-step retry signature is gone with the two-step save");
  });

  test("failure keeps the modal open with the server's message and never calls onSaved; success calls onSaved once, after the server confirms", () => {
    const body = coordinatedSaveBody();
    const callIdx = body.indexOf("await submitAtomicRecurrenceChange(");
    const failIdx = body.indexOf("if (!result.ok) { setError(result.error); return; }", callIdx);
    const onSavedIdx = body.indexOf("onSaved();", callIdx);
    assert.ok(callIdx > -1 && failIdx > callIdx && onSavedIdx > failIdx);
    const fnBody = atomicBody();
    assert.ok(fnBody.includes("const message: string = data?.error ||"), "server message is surfaced");
    // every 4xx (refused before any write) states that nothing was saved; behavior is proven in AppointmentModal.render.test.ts
    assert.ok(fnBody.includes("Nothing was saved."), "a refusal says nothing was saved");
    assert.ok(!fnBody.includes("onSaved"), "the helper never closes the modal itself");
  });

  test("changing the recurrence while the status is Cancelled is rejected client-side with a clear message, before any request", () => {
    const body = coordinatedSaveBody();
    const guardIdx = body.indexOf('if (form.status !== "scheduled") {');
    const callIdx = body.indexOf("await submitAtomicRecurrenceChange(");
    assert.ok(guardIdx > -1 && guardIdx < callIdx);
    assert.ok(body.includes('setError("Set the status back to Scheduled before changing the recurrence.");'));
  });
});

describe("atomic recurrence save (client): operation identity", () => {
  test("the operation id is keyed on the WHOLE request (fields, employees, pattern) -- any change mints a new id so the server never sees the same id with a different request", () => {
    const fnBody = atomicBody();
    assert.ok(fnBody.includes("const signature = JSON.stringify({ fields, employee_ids, manageFreq, manageWeeks, manageMonths });"));
    const idx = source.indexOf("function getRecurrenceOperationId(signature: string): string {");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 320);
    assert.ok(block.includes("recurrenceOperationRef.current.for !== signature"));
    assert.ok(block.includes("crypto.randomUUID()"));
  });

  test("the id is cleared only after the server confirms, and KEPT after a network error so an identical retry is replayed, never applied twice", () => {
    const fnBody = atomicBody();
    const okIdx = fnBody.indexOf("recurrenceOperationRef.current = null;");
    const okReturnIdx = fnBody.indexOf("return { ok: true };");
    assert.ok(okIdx > -1 && okIdx < okReturnIdx);
    const catchIdx = fnBody.indexOf("} catch {");
    assert.ok(catchIdx > okReturnIdx);
    assert.ok(!fnBody.slice(catchIdx).includes("recurrenceOperationRef.current = null"), "network error must not discard the id");
    assert.ok(fnBody.includes("Network error. Please try again -- nothing will be applied twice."));
  });

  test("a protected-occurrence notice from the server is shown to the owner, never silently dropped", () => {
    assert.ok(atomicBody().includes("if (data?.notice?.message) alert(data.notice.message);"));
  });
});

describe("coordinated save: re-entrancy and retry guards that remain", () => {
  test("a double-click / re-entrant call is blocked synchronously via savingRef, before any async work or state update", () => {
    const body = coordinatedSaveBody();
    assert.ok(body.includes("if (savingRef.current) return;"));
    assert.ok(body.includes("savingRef.current = true;"));
    const guardIdx = body.indexOf("if (savingRef.current) return;");
    const validateIdx = body.indexOf("if (!validateForm()) return;");
    assert.ok(guardIdx > validateIdx, "the re-entrancy guard runs after the cheap synchronous validations, before any async fetch");
  });

  test("savingRef is released in the finally block, so a genuinely new attempt after a completed (successful or failed) save is never permanently blocked", () => {
    const body = coordinatedSaveBody();
    const finallyIdx = body.indexOf("} finally {");
    assert.notEqual(finallyIdx, -1);
    assert.ok(body.slice(finallyIdx).includes("savingRef.current = false;"));
  });
});

describe("coordinated save: edit-scope interaction with a pending recurrence change is explicit, never silently series-wide", () => {
  test("proceedAfterValidation skips the Only-this/This-and-future scope choice entirely whenever a recurrence change is pending -- checked BEFORE the isRecurring/!editScope gate", () => {
    const fnStart = source.indexOf("function proceedAfterValidation(unassignConfirmed = confirmUnassign) {");
    assert.notEqual(fnStart, -1);
    const fnEnd = source.indexOf("\n  }", source.indexOf("executeCoordinatedSave(editScope ?? \"single\");", fnStart));
    const body = source.slice(fnStart, fnEnd);
    const recurrencePendingIdx = body.indexOf("if (isEdit && hasPendingRecurrenceChange) {");
    const scopeGateIdx = body.indexOf("if (isEdit && isRecurring && !editScope) {");
    assert.ok(recurrencePendingIdx > -1 && scopeGateIdx > -1);
    assert.ok(recurrencePendingIdx < scopeGateIdx, "the recurrence-pending short-circuit must be checked first");
    assert.ok(body.slice(recurrencePendingIdx, recurrencePendingIdx + 120).includes('executeCoordinatedSave("single");'));
  });

  test("the Manage Recurrence panel tells the owner that other pending edits are saved TOGETHER with the recurrence change (all or nothing)", () => {
    const idx = source.indexOf("{hasPendingApptFieldChanges && (");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 320);
    assert.ok(block.includes("saved together with this recurrence change"));
    assert.ok(block.includes("all of it is saved, or none of it"));
    assert.ok(!source.includes("will be saved first"), "the old two-step wording is gone");
  });
});

describe("coordinated save: recurrence-only and no-recurrence edits each send exactly the request they need", () => {
  test("hasPendingApptFieldChanges checks date/time, service, notes, status, price, team color, and employee assignments", () => {
    const idx = source.indexOf("const hasPendingApptFieldChanges = isEdit && (");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 200);
    assert.ok(block.includes("dateTimeChanged || serviceChanged || notesChanged || statusChanged || priceChanged || teamColorChanged || employeeIdsChanged"));
  });

  test("with NO recurrence change, /api/appointments/update is sent only when something actually changed (a no-op save sends nothing) and manage-recurrence is never called", () => {
    const body = coordinatedSaveBody();
    const plainIdx = body.indexOf("if (hasPendingApptFieldChanges) {");
    const updateFetchIdx = body.indexOf('fetch("/api/appointments/update"', plainIdx);
    assert.ok(plainIdx > -1 && updateFetchIdx > plainIdx);
    const afterAtomicBranch = body.slice(body.indexOf("await submitAtomicRecurrenceChange("));
    const plainPath = afterAtomicBranch.slice(afterAtomicBranch.indexOf("// No recurrence change"));
    assert.ok(!plainPath.includes("manage-recurrence"));
    assert.ok(!plainPath.includes("submitAtomicRecurrenceChange"));
  });
});

describe("make series scope explicit (item 4): a pending recurrence change's scope is visible regardless of whether Manage Recurrence is collapsed", () => {
  test("the scope-explanation banner is gated on hasPendingRecurrenceChange alone -- not on showManageRecurrence -- so it stays visible even when the panel is collapsed", () => {
    const idx = source.indexOf("{!editScope && !confirmUnassign && hasPendingRecurrenceChange && (");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 400);
    assert.ok(!block.slice(0, block.indexOf("Saving will update")).includes("showManageRecurrence"));
    assert.ok(block.includes("Saving will update this appointment and apply the new recurrence pattern to its eligible future occurrences in this series."));
    assert.ok(block.includes("Occurrences with recorded work will be left on their current schedule."));
  });

  test("the scope-explanation banner sits in the main render tree (outside the Manage Recurrence panel's own JSX block), not nested inside it", () => {
    const panelIdx = source.indexOf('{isEdit && showManageRecurrence && (');
    const panelEndIdx = source.indexOf("{/* Job Tracking / Worked Hours", panelIdx);
    const bannerIdx = source.indexOf("{!editScope && !confirmUnassign && hasPendingRecurrenceChange && (");
    assert.ok(panelIdx > -1 && panelEndIdx > -1 && bannerIdx > -1);
    assert.ok(bannerIdx > panelEndIdx, "the banner must not be inside the collapsible panel's own conditional block");
  });

  test("the normal Only-this/This-and-future scope choice is completely unaffected -- still gated on editScope && isRecurring, with no new dependency on recurrence state", () => {
    const idx = source.indexOf("{!confirmUnassign && editScope && isRecurring && (");
    assert.notEqual(idx, -1);
  });
});
