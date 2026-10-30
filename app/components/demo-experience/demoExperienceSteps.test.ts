// Proves the guided tour was updated (not redesigned) to introduce the
// features that shipped after the original storyboard: Projected Revenue,
// Weekly Worked Hours, Employee Worked Hours, and Job Tracking. All four
// live in the same right-hand dispatch sidebar, so this is one added step,
// not four — see the "dispatch-insights" comment in demoExperienceSteps.ts.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import "../../../lib/testDom.ts";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";
import { DEMO_EXPERIENCE_STEPS } from "./demoExperienceSteps";
import { useDemoExperience } from "./useDemoExperience";
import { notifyDemoAction, subscribeDemoStepEntered } from "./demoExperienceBus";
import { backdropCells, type Box } from "./spotlightGeometry";

const shellSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/DashboardShell.tsx", import.meta.url)),
  "utf8"
);
const overlaySource = fs.readFileSync(
  fileURLToPath(new URL("./DemoExperienceOverlay.tsx", import.meta.url)),
  "utf8"
);
const topBarSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/TopBar.tsx", import.meta.url)),
  "utf8"
);
const detailPanelSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/AppointmentDetailPanel.tsx", import.meta.url)),
  "utf8"
);
const hookSource = fs.readFileSync(
  fileURLToPath(new URL("./useDemoExperience.ts", import.meta.url)),
  "utf8"
);
const staffPanelSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/StaffPanel.tsx", import.meta.url)),
  "utf8"
);
const controlsPanelSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/DemoControlsPanel.tsx", import.meta.url)),
  "utf8"
);

function functionBody(rawSource: string, signature: string): string {
  const source = rawSource.replace(/\r\n/g, "\n");
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  return source.slice(start, source.indexOf("\n  }\n", start));
}

describe("DEMO_EXPERIENCE_STEPS -- storyboard order", () => {
  test("all 11 steps, with Revenue & Worked Hours before the Edit instruction so Edit leads straight into Edit Service", () => {
    const ids = DEMO_EXPERIENCE_STEPS.map((s) => s.id);
    assert.deepEqual(ids, [
      "welcome",
      "schedule",
      "dispatch-insights",
      "appointment-details",
      "edit-service",
      "clients",
      "employees",
      "services",
      "add-appointment",
      "mobile-experience",
      "completion",
    ]);
  });

  test("exactly one new step was added", () => {
    assert.equal(DEMO_EXPERIENCE_STEPS.length, 11);
  });
});

describe("dispatch-insights -- the new step introducing Projected Revenue / Weekly Worked Hours / Employee Worked Hours / Job Tracking", () => {
  const step = DEMO_EXPERIENCE_STEPS.find((s) => s.id === "dispatch-insights");

  test("comes right after an appointment is selected and right before the Edit instruction", () => {
    assert.ok(step);
    const idx = DEMO_EXPERIENCE_STEPS.indexOf(step!);
    assert.equal(DEMO_EXPERIENCE_STEPS[idx - 1].id, "schedule");
    assert.equal(DEMO_EXPERIENCE_STEPS[idx + 1].id, "appointment-details");
    assert.equal(DEMO_EXPERIENCE_STEPS[idx + 2].id, "edit-service", "clicking Edit leads straight into Edit Service");
  });

  test("mentions all four features by name", () => {
    for (const feature of ["Projected Revenue", "Weekly Worked Hours", "Employee Worked Hours", "Job Tracking"]) {
      assert.ok(step!.body.includes(feature), `body must mention ${feature}`);
    }
  });

  test("targets the dispatch sidebar, matching the real DOM hook added to DashboardShell.tsx", () => {
    assert.equal(step!.targetSelector, '[data-tour="dispatch-sidebar"]');
  });

  test("is a view-only step (no required action), matching Welcome/Completion's own non-blocking style -- these are read-only cards, there is no natural single action to require", () => {
    assert.equal(step!.actionRequired, false);
    assert.equal(step!.actionId, undefined);
  });
});

describe("DashboardShell.tsx -- carries the real data-tour hook the new step targets", () => {
  test('the dispatch sidebar <aside> carries data-tour="dispatch-sidebar"', () => {
    assert.ok(shellSource.includes('<aside data-tour="dispatch-sidebar"'));
  });
});

describe("DemoExperienceOverlay.tsx -- completion checklist reflects the new step", () => {
  test('the "Today you" checklist includes the revenue/worked-hours item', () => {
    assert.ok(overlaySource.includes("Reviewed revenue &amp; worked hours"));
  });
});

describe("schedule step -- visitors can navigate and must pick an editable appointment", () => {
  const step = DEMO_EXPERIENCE_STEPS.find((s) => s.id === "schedule")!;

  test("spotlights the Today/Prev/Next controls together with the calendar", () => {
    assert.equal(step.targetSelector, '[data-tour="schedule-nav"], [data-tour="schedule-grid"]');
    assert.match(topBarSource, /<div data-tour="schedule-nav" className="flex items-center gap-1\.5">[\s\S]*?Today[\s\S]*?Prev[\s\S]*?Next/);
  });

  test("explains how to find an editable appointment", () => {
    assert.equal(
      step.body,
      "Use Today, Prev, or Next to find an upcoming scheduled appointment. Click its card to view details. Edit works only on future appointments; completed, cancelled, and past appointments cannot be edited."
    );
  });

  test("advances only on an editable selection; an uneditable one shows a hint instead", () => {
    assert.equal(step.actionId, "select-appointment");
    assert.equal(step.rejectedActionId, "select-uneditable-appointment");
    assert.match(step.rejectedHint ?? "", /can't be edited/);
    assert.match(step.rejectedHint ?? "", /Today, Prev, or Next/);
  });

  test("DashboardShell decides editability with the existing isHistoricalAppointment rule", () => {
    const body = functionBody(shellSource, "function selectAppointment(apptId: string)");
    assert.match(body, /!isHistoricalAppointment\(appt, assignments\.filter\(\(a\) => a\.appointment_id === apptId\)\)/);
    assert.match(body, /notifyDemoAction\(editable \? "select-appointment" : "select-uneditable-appointment"\)/);
  });
});

describe("appointment-details step -- highlights the real Edit button", () => {
  const step = DEMO_EXPERIENCE_STEPS.find((s) => s.id === "appointment-details")!;

  test("targets the Edit button, which only renders for an editable appointment", () => {
    assert.equal(step.targetSelector, '[data-tour="appointment-edit"]');
    assert.match(detailPanelSource, /\{!isHistorical && \(\s*<button\s+type="button"\s+onClick=\{handleEdit\}\s+data-tour="appointment-edit"/);
  });

  test("the Edit button and the double-click shortcut report the action from one shared place", () => {
    assert.ok(!detailPanelSource.includes("notifyDemoAction"), "the panel no longer reports the action itself (no double report)");
    const body = functionBody(shellSource, "function editAppointment(apptId: string)");
    const historicalReturn = body.indexOf("return;");
    const modalOpen = body.indexOf('setModal({ mode: "edit"');
    const notify = body.indexOf('notifyDemoAction("click-edit-appointment")');
    assert.ok(historicalReturn >= 0 && modalOpen > historicalReturn, "historical appointments return before the modal opens");
    assert.ok(notify > modalOpen, "the action is reported only once the edit modal actually opens");
    // The schedule's double-click still routes to this same function.
    assert.match(shellSource, /onEditAppointment=\{handleEditAppointment\}/);
  });
});

describe("useDemoExperience -- rejected actions keep the step and show its hint", () => {
  test("hint is tied to the step and cleared whenever the step changes", () => {
    assert.match(hookSource, /current\?\.rejectedActionId === actionId && current\.rejectedHint/);
    assert.match(hookSource, /rejection\?\.stepIndex === stepIndex \? rejection\.hint : null/);
    for (const fn of ["start", "restart", "back", "next"]) {
      const start = hookSource.indexOf(`const ${fn} = useCallback(`);
      assert.ok(start >= 0, `missing ${fn}`);
      const body = hookSource.slice(start, hookSource.indexOf("}, [", start));
      assert.match(body, /setRejection\(null\)/, `${fn} clears the hint`);
    }
  });

  test("the overlay shows the hint in place of the step body", () => {
    assert.match(overlaySource, /\{hint \? \([\s\S]*?role="status"[\s\S]*?\{hint\}[\s\S]*?\) : \([\s\S]*?\{currentStep\.body\}/);
  });
});

describe("spotlightGeometry.backdropCells -- dims everything except each hole", () => {
  const W = 1000;
  const H = 800;
  const area = (cells: Box[]) => cells.reduce((sum, c) => sum + c.width * c.height, 0);
  const covers = (cells: Box[], x: number, y: number) =>
    cells.some((c) => x > c.left && x < c.left + c.width && y > c.top && y < c.top + c.height);

  test("no holes dims the whole viewport", () => {
    assert.equal(area(backdropCells([], W, H)), W * H);
  });

  test("two separate holes stay open while the area between them stays dimmed", () => {
    const nav = { top: 40, left: 240, width: 260, height: 50 };
    const grid = { top: 100, left: 240, width: 800, height: 500 };
    const cells = backdropCells([nav, grid], W, H);
    assert.ok(!covers(cells, 300, 60), "nav controls clickable");
    assert.ok(!covers(cells, 600, 300), "calendar clickable");
    assert.ok(covers(cells, 800, 60), "Add Appointment area (right of the nav) stays dimmed");
    assert.equal(area(cells), W * H - nav.width * nav.height - (W - grid.left) * grid.height);
  });

  test("overlapping holes are never re-dimmed where they overlap", () => {
    const a = { top: 100, left: 100, width: 300, height: 300 };
    const b = { top: 200, left: 200, width: 300, height: 300 };
    const cells = backdropCells([a, b], W, H);
    assert.ok(!covers(cells, 300, 300), "overlap region open");
    assert.equal(area(cells), W * H - (300 * 300 * 2 - 200 * 200));
  });
});

describe("useDemoExperience (rendered) -- Back, Restart, and step announcements", () => {
  afterEach(() => {
    cleanup();
  });

  test("every entered step is announced; Back steps back several steps; Restart returns to Welcome", () => {
    window.localStorage.clear();
    const entered: string[] = [];
    const unsubscribe = subscribeDemoStepEntered((id) => entered.push(id));
    let api!: ReturnType<typeof useDemoExperience>;
    function Host() {
      api = useDemoExperience(false);
      return null;
    }
    try {
      render(React.createElement(Host));
      act(() => api.start());
      assert.deepEqual(entered, ["welcome"]);

      act(() => api.next());
      act(() => notifyDemoAction("select-uneditable-appointment"));
      assert.equal(api.currentStep?.id, "schedule", "an uneditable selection does not advance");
      assert.ok(api.hint);
      act(() => notifyDemoAction("select-appointment"));
      assert.equal(api.currentStep?.id, "dispatch-insights");
      act(() => api.next());
      act(() => notifyDemoAction("click-edit-appointment"));
      assert.equal(api.currentStep?.id, "edit-service", "clicking Edit leads straight into Edit Service");

      act(() => api.back());
      act(() => api.back());
      act(() => api.back());
      assert.equal(api.currentStep?.id, "schedule");
      assert.equal(api.hint, null, "a stale hint does not reappear after going back");
      assert.deepEqual(entered, [
        "welcome", "schedule", "dispatch-insights", "appointment-details", "edit-service",
        "appointment-details", "dispatch-insights", "schedule",
      ]);

      act(() => api.restart());
      assert.equal(api.stepIndex, 0);
      act(() => api.restart());
      assert.deepEqual(entered.slice(-2), ["welcome", "welcome"], "Restart on Welcome still re-opens the Welcome screen");

      const count = entered.length;
      act(() => api.back());
      assert.equal(api.stepIndex, 0, "Back never goes before Welcome");
      assert.equal(entered.length, count);
    } finally {
      unsubscribe();
    }
  });

  test("double-clicking a card (select + Edit at once) skips the view-only Revenue step straight into Edit Service", () => {
    window.localStorage.clear();
    const entered: string[] = [];
    const unsubscribe = subscribeDemoStepEntered((id) => entered.push(id));
    let api!: ReturnType<typeof useDemoExperience>;
    function Host() {
      api = useDemoExperience(false);
      return null;
    }
    try {
      render(React.createElement(Host));
      act(() => api.start());
      act(() => api.next());
      act(() => notifyDemoAction("select-appointment"));
      act(() => notifyDemoAction("click-edit-appointment"));
      assert.equal(api.currentStep?.id, "edit-service");
      assert.deepEqual(entered, ["welcome", "schedule", "dispatch-insights", "edit-service"]);
      // Only a view-only step is ever skipped: an action-required step still
      // ignores an action meant for a later step.
      act(() => notifyDemoAction("open-client"));
      assert.equal(api.currentStep?.id, "edit-service");
    } finally {
      unsubscribe();
    }
  });
});

describe("Back button and Restart Experience", () => {
  test("the overlay shows Back from step 2 onward, and on the completion screen", () => {
    assert.match(overlaySource, /\{stepIndex > 0 && \([\s\S]*?onClick=\{back\}[\s\S]*?← Back/);
    assert.equal((overlaySource.match(/onClick=\{back\}/g) ?? []).length, 2);
  });

  test("Restart Experience only rewinds the tour -- it never resets fictional data", () => {
    const start = controlsPanelSource.indexOf("restart();");
    const handler = controlsPanelSource.slice(controlsPanelSource.lastIndexOf("onClick={() => {", start), controlsPanelSource.indexOf("}}", start));
    assert.ok(!handler.includes("resetStore"), "Reset Demo remains the separate data reset");
    assert.ok(!functionBody(shellSource, "function openTourScreen(stepId: string)").match(/fetch\(|resetStore|setSnapshot/));
  });
});

describe("DashboardShell.openTourScreen -- each step opens the screen it needs", () => {
  const body = functionBody(shellSource, "function openTourScreen(stepId: string)");

  test("Welcome returns to the main schedule, current week, with nothing selected and dialogs closed", () => {
    const welcome = body.slice(body.indexOf('if (stepId === "welcome")'), body.indexOf('} else if (stepId === "schedule")'));
    for (const call of ["setModal(null)", 'setViewMode("weekdays")', "setWeekOffset(0)", "setMonthOffset(0)", "setSelectedApptId(null)", "setSelectedClientId(null)"]) {
      assert.ok(welcome.includes(call), `Welcome calls ${call}`);
    }
    for (const call of ['setCenterMode("schedule")', "setPendingMove(null)", "setBillingFocus(null)", "setNeedsAttentionFocusSection(null)"]) {
      assert.ok(body.includes(call), `every non-Settings step calls ${call}`);
    }
  });

  test("Employees and Services open their Settings section; the step text no longer asks visitors to navigate", () => {
    assert.match(body, /setSettingsSection\(stepId === "employees" \? "staff" : "services"\);\s*setCenterMode\("settings"\)/);
    const employees = DEMO_EXPERIENCE_STEPS.find((s) => s.id === "employees")!;
    const services = DEMO_EXPERIENCE_STEPS.find((s) => s.id === "services")!;
    assert.equal(employees.targetSelector, '[data-tour="employees-area"]');
    assert.ok(staffPanelSource.includes('<div data-tour="employees-area" className="rounded-2xl'));
    assert.ok(!/Open Settings|In Settings/.test(employees.body + services.body));
  });

  test("appointment steps use an editable appointment under the existing rule, and Edit Service opens its editor", () => {
    assert.match(shellSource, /function isEditableForTour\(appt: Appointment\) \{\s*return !isHistoricalAppointment\(/);
    assert.match(body, /stepId === "appointment-details" \|\| stepId === "dispatch-insights" \|\| stepId === "edit-service"/);
    // Edit Service keeps the editor Edit already opened for that appointment
    // (so it stays open, typed changes intact); Back/refresh opens it.
    assert.match(body, /setModal\(\(m\) => \(m\?\.mode === "edit" && m\.appointment\?\.id === appt\.id \? m : \{ mode: "edit", appointment: appt, client \}\)\)/);
  });

  test("desktop only, subscribed once, and sees the latest render's selection", () => {
    assert.match(body, /if \(isMobile\) return;/);
    assert.match(shellSource, /useLayoutEffect\(\(\) => \{\s*openTourScreenRef\.current = openTourScreen;\s*\}\);/);
    assert.match(shellSource, /useEffect\(\(\) => subscribeDemoStepEntered\(\(stepId\) => openTourScreenRef\.current\(stepId\)\), \[\]\);/);
  });
});
