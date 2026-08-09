// Phase 5.5E-E1G: DispatchPanel.tsx is a .tsx file. Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content -- the same well-documented limitation hit by
// every .tsx production file in this entitlement-enforcement effort. This
// file proves what SOURCE INSPECTION can actually prove -- prop wiring,
// guard placement/ordering, exact wording, and structural absence of
// forbidden content -- and does not claim to exercise real DOM rendering or
// real mouse/keyboard events for THIS component.
//
// The one thing that genuinely needs real rendered interaction proof --
// whether a restricted CapabilityGatedButton actually blocks a
// click/Enter/Space/repeated activation and remains disabled/aria-disabled
// -- is already proven exhaustively, for the exact same component this file
// wires in, by CapabilityGatedButton.test.ts's 20 real rendered-DOM tests.
// That proof is not re-executed here; it is cited as already covering the
// shared primitive this component's "Save Worked Hours" control now uses.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./DispatchPanel.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("DispatchPanel's own Props includes canUseJobTracking: boolean", () => {
    const fnStart = source.indexOf("export default function DispatchPanel({");
    const paramsEnd = source.indexOf("}) {", fnStart);
    const params = source.slice(fnStart, paramsEnd);
    assert.match(params, /canUseJobTracking:\s*boolean;/);
    assert.match(params, /^\s*canUseJobTracking,$/m);
  });

  test("EmployeeHoursSection's own Props includes canUseJobTracking: boolean", () => {
    const fnStart = source.indexOf("function EmployeeHoursSection({");
    const paramsEnd = source.indexOf("}) {", fnStart);
    const params = source.slice(fnStart, paramsEnd);
    assert.match(params, /canUseJobTracking:\s*boolean;/);
    assert.match(params, /^\s*appointment, employee, assignment, onSaved, canUseJobTracking,$/m);
  });

  test("DispatchPanel passes its own canUseJobTracking prop straight through to EmployeeHoursSection -- no re-derivation, no new resolution path", () => {
    const idx = source.indexOf("<EmployeeHoursSection");
    assert.notEqual(idx, -1);
    const closeIdx = source.indexOf("/>", idx);
    const jsx = source.slice(idx, closeIdx);
    assert.match(jsx, /canUseJobTracking=\{canUseJobTracking\}/);
  });

  test("DashboardShell passes entitlement.canUseJobTracking (not canMutateOperationalData) to DispatchPanel", () => {
    const idx = shellSource.indexOf("<DispatchPanel");
    assert.notEqual(idx, -1, "DispatchPanel must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canUseJobTracking=\{entitlement\.canUseJobTracking\}/);
    assert.ok(!jsx.includes("canMutateOperationalData"), "DispatchPanel must not also receive canMutateOperationalData");
  });

  test("this file never actually consumes canMutateOperationalData as a prop or in any conditional -- the policy decision (canUseJobTracking, not canMutateOperationalData) is structural, not incidental", () => {
    // Checked against actual usage patterns, not a whole-file substring
    // search -- this file's own header comment legitimately names
    // canMutateOperationalData by way of explaining why it was deliberately
    // NOT used here, which a naive whole-file .includes() check would
    // misread as this file consuming it.
    assert.ok(!source.includes("={canMutateOperationalData}"));
    assert.ok(!source.includes("!canMutateOperationalData"));
    assert.ok(!/canMutateOperationalData:\s*boolean/.test(source), "no prop type should declare it");
  });
});

describe("save() guard", () => {
  test("save guards on canUseJobTracking before validation and before the fetch call", () => {
    const fnStart = source.indexOf("async function save()");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canUseJobTracking) return;", fnStart);
    const validationIdx = source.indexOf("const hoursNum = Number(hours);", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/appointments/employee-hours"', fnStart);
    assert.notEqual(guardIdx, -1, "save must contain the capability guard");
    assert.ok(guardIdx < validationIdx, "guard must run before hours/reason validation");
    assert.ok(guardIdx < fetchIdx, "guard must run before the fetch call");
  });

  test("the guard is the first statement inside save() (defense-in-depth, independent of the button's own disabled state)", () => {
    const fnStart = source.indexOf("async function save()");
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 400);
    const firstNonCommentNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canUseJobTracking) return;");
  });
});

describe("Save Worked Hours control", () => {
  test("the control is a CapabilityGatedButton, not a plain <button>", () => {
    assert.ok(source.includes("import CapabilityGatedButton from"));
    assert.match(source, /<CapabilityGatedButton[\s\S]{0,300}onClick=\{save\}/);
  });

  test("allowed is wired to canUseJobTracking", () => {
    const idx = source.indexOf("onClick={save}");
    const block = source.slice(Math.max(0, idx - 200), idx + 50);
    assert.match(block, /allowed=\{canUseJobTracking\}/);
  });

  test("existing loading-protection disabled={saving} is preserved unchanged", () => {
    const idx = source.indexOf("onClick={save}");
    const block = source.slice(idx, idx + 100);
    assert.match(block, /disabled=\{saving\}/);
  });

  test("ariaDescribedBy points at this control's own notice id", () => {
    const idx = source.indexOf("onClick={save}");
    const block = source.slice(idx, idx + 150);
    assert.match(block, /ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/);
  });

  test("the button's className and loading label text are unchanged", () => {
    assert.ok(source.includes('className="w-full rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"'));
    assert.ok(source.includes('{saving ? "Saving..." : "Save Worked Hours"}'));
  });
});

describe("the form cannot be entered/edited while restricted (no separate 'entry' step exists here -- the form appears automatically whenever hours are missing)", () => {
  test("the Hours Worked input is disabled when restricted, preventing any typed local state change that would simulate beginning the mutation", () => {
    const idx = source.indexOf('placeholder="2.5"');
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 150);
    assert.match(block, /disabled=\{!canUseJobTracking\}/);
  });

  test("the Reason input is disabled when restricted", () => {
    const idx = source.indexOf('placeholder="e.g. forgot to clock in/out"');
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 150);
    assert.match(block, /disabled=\{!canUseJobTracking\}/);
  });

  test("both inputs preserve their onChange local-state handlers unchanged -- disabling only removes interactivity, it does not remove the field or its wiring", () => {
    assert.ok(source.includes("onChange={(e) => setHours(e.target.value)}"));
    assert.ok(source.includes("onChange={(e) => setReason(e.target.value)}"));
  });
});

describe("notice block", () => {
  test("exact approved wording constant", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("notice only renders when restricted (negated condition)", () => {
    assert.match(source, /\{!canUseJobTracking && \(/);
  });

  test("notice id's declared value is unique to this component", () => {
    const declared = source.match(/const RESTRICTED_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "employee-hours-restricted-notice");
    for (const other of [
      "appointment-modal-restricted-notice",
      "appointment-detail-restricted-notice",
      "move-confirm-dialog-restricted-notice",
      "topbar-restricted-notice",
      "mobile-dashboard-restricted-notice",
      "mobile-appointment-detail-restricted-notice",
      "client-panel-restricted-notice",
      "archived-clients-panel-restricted-notice",
      "company-info-restricted-notice",
      "company-automation-restricted-notice",
      "services-panel-restricted-notice",
      "staff-panel-restricted-notice",
    ]) {
      assert.notEqual(declared, other);
    }
  });

  test("only one notice block exists in this file, and since EmployeeHoursSection is only ever mounted for one selected appointment at a time, only one can ever be on screen at once", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });
});

describe("read-only actions and navigation remain unconditional", () => {
  test("the already-tracked (Job Tracking complete) read-only display block is not wrapped in a canUseJobTracking check", () => {
    // Phase 5.7D-R18: per-employee now -- one read-only block per assigned
    // employee who already has worked hours, inside the
    // selectedApptAssignments.map() loop, before the manual-entry
    // (EmployeeHoursSection) branch for employees still missing hours.
    const readOnlyStart = source.indexOf("if (assignmentHasWorkedHours(selectedAppt.id, emp.id, assignment, employeeHours)) {");
    const readOnlyEnd = source.indexOf("if (missingHoursEmployeeIds.includes(emp.id)) {", readOnlyStart);
    assert.notEqual(readOnlyStart, -1);
    assert.notEqual(readOnlyEnd, -1);
    const block = source.slice(readOnlyStart, readOnlyEnd);
    assert.ok(!block.includes("canUseJobTracking"));
  });

  test("PayrollSummary (Weekly Worked Hours date-range display) is rendered unconditionally -- it is pure read-only, no fetch, no mutation, out of this phase's scope", () => {
    const idx = source.indexOf("<PayrollSummary");
    assert.notEqual(idx, -1);
    const invocation = source.slice(idx, source.indexOf("/>", idx) + 2);
    for (const prop of ["appointments={appointments}", "employees={employees}", "employeeHours={employeeHours}", "assignments={assignments}", "rangeStart={rangeStart}", "rangeEnd={rangeEnd}", "onRangeStartChange={setRangeStart}", "onRangeEndChange={setRangeEnd}"]) {
      assert.ok(invocation.includes(prop), `expected PayrollSummary invocation to include ${prop}`);
    }
    const before = source.slice(Math.max(0, idx - 60), idx);
    assert.ok(!before.includes("canUseJobTracking"));
  });

  test("Projected Revenue (IncomeProjection component) is rendered unconditionally, directly above Weekly Worked Hours, reading the SAME rangeStart/rangeEnd state", () => {
    const incomeIdx = source.indexOf("<IncomeProjection");
    const payrollIdx = source.indexOf("<PayrollSummary");
    assert.notEqual(incomeIdx, -1);
    assert.notEqual(payrollIdx, -1);
    assert.ok(incomeIdx < payrollIdx, "IncomeProjection must render before (above) PayrollSummary");

    const invocation = source.slice(incomeIdx, source.indexOf("/>", incomeIdx) + 2);
    for (const prop of ["appointments={appointments}", "assignments={assignments}", "rangeStart={rangeStart}", "rangeEnd={rangeEnd}"]) {
      assert.ok(invocation.includes(prop), `expected IncomeProjection invocation to include ${prop}`);
    }
    // Not gated behind canUseJobTracking or a selection, same as PayrollSummary.
    const before = source.slice(Math.max(0, incomeIdx - 60), incomeIdx);
    assert.ok(!before.includes("canUseJobTracking"));
  });

  test("rangeStart/rangeEnd are DispatchPanel's own state (shared, not independently computed by each card)", () => {
    assert.ok(source.includes("const [rangeStart, setRangeStart] = useState("));
    assert.ok(source.includes("const [rangeEnd, setRangeEnd] = useState("));
    assert.ok(source.includes("mondayOfCurrentWeek(timezone)"));
  });

  test("appointment selection, dispatch summary counts, and Navigate/Call actions remain unconditional", () => {
    assert.ok(source.includes("<InfoRow label=\"Client\""));
    assert.ok(source.includes('href={`tel:${client.phone}`}'));
    assert.ok(source.includes("href={mapsUrl(client.address)}"));
    const idx = source.indexOf("<InfoRow label=\"Client\"");
    const before = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(!before.includes("canUseJobTracking"));
  });
});

describe("Phase 3 (Month Calendar View): Projected Revenue / Weekly Worked Hours remain fully decoupled from the selected schedule view", () => {
  test("DashboardShell's <DispatchPanel> call site never passes weekOffset, monthOffset, or viewMode -- rangeStart/rangeEnd are DispatchPanel's own independent state (see the test above), so there is no prop through which Month view (or any view) could influence them", () => {
    const idx = shellSource.indexOf("<DispatchPanel");
    assert.notEqual(idx, -1, "DispatchPanel must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    for (const forbidden of ["weekOffset", "monthOffset", "viewMode"]) {
      assert.ok(!jsx.includes(forbidden), `DispatchPanel invocation must not receive "${forbidden}"`);
    }
  });

  test("this file itself never references monthOffset or a Month-view concept -- Projected Revenue/Weekly Worked Hours logic is completely untouched by Phase 3", () => {
    assert.ok(!source.includes("monthOffset"));
    assert.ok(!source.includes("ScheduleMonthGrid"));
    assert.ok(!source.includes('viewMode === "month"'));
  });
});

describe("employee Start/Complete Job actions are untouched (separate component, separate file, separate policy)", () => {
  test("this file does not import EmployeeJobActionButton and does not call the employee job route", () => {
    // Checked against actual usage patterns, not a whole-file substring
    // search -- this file's own header comment legitimately names
    // EmployeeJobActionButton by way of explaining why it's untouched,
    // which a naive whole-file .includes() check would misread as this
    // file referencing it.
    assert.ok(!source.includes("import EmployeeJobActionButton"));
    assert.ok(!source.includes("<EmployeeJobActionButton"));
    assert.ok(!source.includes('fetch("/api/appointments/job"'));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace-identifier vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspaceId", "workspace_id",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `DispatchPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canUseJobTracking is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `DispatchPanel.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("Phase 5.7D-R18: per-employee dispatch summary, appointment details, and Worked Hours cards (source-level proof)", () => {
  test("today's Scheduled/In Progress/Completed counts are derived per-appointment from assignment rows, never the legacy appointment-level timestamps", () => {
    assert.ok(source.includes("const todayStatuses = todayAppts.map((a) => deriveAppointmentTrackingStatus(assignmentsByApptId.get(a.id) ?? []));"));
    assert.ok(!source.includes("todayAppts.filter((a) => !a.actual_started_at)"));
  });

  test("the Appointment Details panel lists every assigned employee (comma-joined), not a single employee", () => {
    assert.ok(source.includes("selectedApptEmployees.map((e) => e.name).join"));
  });

  test("Employee Worked Hours renders one entry per assigned employee, each independently resolved via assignmentHasWorkedHours / missingHoursEmployeeIds", () => {
    assert.ok(source.includes("selectedApptAssignments.map((assignment) => {"));
    assert.ok(source.includes("assignmentHasWorkedHours(selectedAppt.id, emp.id, assignment, employeeHours)"));
    assert.ok(source.includes("missingHoursEmployeeIds.includes(emp.id)"));
  });
});

describe("Phase 5.7D-R19: Employee Worked Hours -- 'Not tracked yet' + cancelled guard + stable order (source-level proof)", () => {
  test("selectedApptAssignments is built via the shared sortAssignmentsStable helper, not the raw assignmentsByApptId order", () => {
    // Phase 5.7D-R19 launch-blocker fix: sortAssignmentsStable now lives in
    // lib/sortAssignmentsStable.ts (no Supabase/server-only import) -- an
    // import from lib/appointmentEmployees.ts (which does import the
    // server-only supabaseAdmin client) previously crashed /dashboard in
    // production by pulling that client into this browser bundle.
    assert.ok(source.includes('import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";'));
    assert.ok(!source.includes('from "@/lib/appointmentEmployees"'), "must never import from the server-only appointmentEmployees module");
    assert.ok(source.includes("sortAssignmentsStable(assignmentsByApptId.get(selectedAppt.id) ?? [])"));
  });

  test("Employee Worked Hours is hidden (no per-employee cards) when the selected appointment is cancelled", () => {
    const cancelledIdx = source.indexOf('selectedAppt && selectedAppt.status === "cancelled"');
    assert.ok(cancelledIdx > -1);
    const cancelledMessageIdx = source.indexOf("cancelled — no worked hours to show", cancelledIdx);
    assert.ok(cancelledMessageIdx > -1);
  });

  test("an assigned employee with neither worked hours nor a missing-hours warning renders 'Not tracked yet' instead of being silently omitted", () => {
    const missingHoursIdx = source.indexOf("if (missingHoursEmployeeIds.includes(emp.id)) {");
    assert.ok(missingHoursIdx > -1);
    const notTrackedIdx = source.indexOf("Not tracked yet.", missingHoursIdx);
    assert.ok(notTrackedIdx > -1);
    // The old bare `return null;` fallback for this case is gone.
    const fallbackRegion = source.slice(missingHoursIdx, source.indexOf("})}", missingHoursIdx));
    assert.ok(!/\n\s*return null;\n\s*\}\)/.test(fallbackRegion) || fallbackRegion.includes("Not tracked yet"));
  });

  test("'Not tracked yet' never creates an appointment_employee_hours row, never sets a timestamp", () => {
    const notTrackedBlockIdx = source.indexOf('<div className="text-slate-500 mt-0.5">Not tracked yet.</div>');
    assert.ok(notTrackedBlockIdx > -1);
    const blockStart = source.lastIndexOf("return (", notTrackedBlockIdx);
    const blockEnd = source.indexOf(");", notTrackedBlockIdx);
    const block = source.slice(blockStart, blockEnd);
    assert.ok(!block.includes("appointment_employee_hours"));
    assert.ok(!block.includes("actual_started_at:"));
    assert.ok(!block.includes("EmployeeHoursSection"), "must not offer a manual-entry override for a not-yet-due assignment");
  });
});

describe("Phase 5C: workspace-timezone-aware selected-appointment detail display", () => {
  test("Props declares timezone: string, and DashboardShell passes timezone={timezone}", () => {
    assert.ok(source.includes("timezone: string;"));
    const idx = shellSource.indexOf("<DispatchPanel");
    assert.notEqual(idx, -1);
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /timezone=\{timezone\}/);
  });

  test("formatDateTime takes an explicit tz parameter and its one call site (the selected appointment's own Date & Time row) passes the timezone prop", () => {
    assert.ok(source.includes("function formatDateTime(iso: string, tz: string) {"));
    assert.ok(source.includes("toBusinessLocal(iso, tz)"));
    assert.ok(source.includes('<InfoRow label="Date & Time" value={formatDateTime(selectedAppt.scheduled_for, timezone)} />'));
  });
});

describe("Phase 5E: mondayOfCurrentWeek/startOfBusinessDay (Weekly Worked Hours range, today's Dispatch summary counts) now take the explicit workspace timezone prop, no more temporary default", () => {
  test("mondayOfCurrentWeek requires an explicit tz parameter, called with the timezone prop", () => {
    assert.ok(source.includes("function mondayOfCurrentWeek(tz: string): Date {"));
    assert.ok(source.includes("const d = nowInBusinessTz(tz);"));
    assert.ok(source.includes("const defaultMonday = mondayOfCurrentWeek(timezone);"));
  });

  test("today's Dispatch summary counts (Scheduled/In Progress/Completed) resolve via startOfBusinessDay with the explicit timezone prop, not the unparameterized default", () => {
    assert.ok(source.includes("const today = startOfBusinessDay(0, timezone);"));
    assert.ok(source.includes("const tomorrow = startOfBusinessDay(1, timezone);"));
    assert.ok(!source.includes("startOfBusinessDay(0);"));
    assert.ok(!source.includes("startOfBusinessDay(1);"));
  });

  test("Income Projection and Weekly Worked Hours both receive the explicit timezone prop", () => {
    const incomeIdx = source.indexOf("<IncomeProjection");
    assert.notEqual(incomeIdx, -1);
    const incomeClose = source.indexOf("/>", incomeIdx);
    assert.match(source.slice(incomeIdx, incomeClose), /timezone=\{timezone\}/);

    const payrollIdx = source.indexOf("<PayrollSummary");
    assert.notEqual(payrollIdx, -1);
    const payrollClose = source.indexOf("/>", payrollIdx);
    assert.match(source.slice(payrollIdx, payrollClose), /timezone=\{timezone\}/);
  });
});
