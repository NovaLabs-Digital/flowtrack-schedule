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
import { backdropCells, placeCard, type Box } from "./spotlightGeometry";

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
  test("all 12 steps, with Revenue & Worked Hours before the Edit instruction so Edit leads straight into Edit Service", () => {
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
      "settings-overview",
      "completion",
    ]);
  });

  test("Settings overview is the last step before the finish screen", () => {
    assert.equal(DEMO_EXPERIENCE_STEPS.length, 12);
    assert.equal(DEMO_EXPERIENCE_STEPS[DEMO_EXPERIENCE_STEPS.length - 2].id, "settings-overview");
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
    assert.match(overlaySource, /\{hint \? \([\s\S]*?role="status"[\s\S]*?\{hint\}[\s\S]*?\) : \([\s\S]*?\{body\}/);
    assert.match(overlaySource, /const body = revealed && currentStep\.revealedBody \? currentStep\.revealedBody : currentStep\.body;/);
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

// ---------------------------------------------------------------------
// Review fixes (2026-11-12): look-then-Next steps, card placement, the
// Add Appointment goal, the phone's bottom bar, and the Settings overview.
// ---------------------------------------------------------------------
const stepById = (id: string) => DEMO_EXPERIENCE_STEPS.find((s) => s.id === id)!;
const readSource = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("look-then-Next steps: the action shows the result, Next advances", () => {
  afterEach(() => cleanup());

  function host() {
    window.localStorage.clear();
    const latest: { api?: ReturnType<typeof useDemoExperience> } = {};
    function Host() {
      const api = useDemoExperience(false);
      React.useEffect(() => {
        latest.api = api;
      });
      return null;
    }
    render(React.createElement(Host));
    return () => latest.api!;
  }
  const goTo = (get: () => ReturnType<typeof useDemoExperience>, id: string) => {
    act(() => get().start());
    while (get().currentStep?.id !== id) {
      const s = get().currentStep!;
      if (s.revealActionId) act(() => notifyDemoAction(s.revealActionId!));
      if (s.actionRequired) act(() => notifyDemoAction(s.actionId!));
      else act(() => get().next());
    }
  };

  test("Clients: clicking a name opens the profile without advancing; Next is locked until then", () => {
    const api = host();
    goTo(api, "clients");
    assert.equal(api().currentStep!.body, "Click a client’s name to open their profile.");
    assert.equal(api().canAdvance, false, "Next is locked before a client is opened");
    act(() => notifyDemoAction("open-client"));
    assert.equal(api().currentStep!.id, "clients", "opening a client never advances the tour");
    assert.equal(api().revealed, true);
    assert.equal(api().canAdvance, true);
    act(() => notifyDemoAction("open-client"));
    assert.equal(api().currentStep!.id, "clients", "opening another client still stays");
    act(() => api().next());
    assert.equal(api().currentStep!.id, "employees");
    act(() => api().back());
    assert.equal(api().currentStep!.id, "clients");
    assert.equal(api().canAdvance, false, "coming back asks for the click again");
  });

  test("Clients highlights the opened profile card and keeps the card clear of it", () => {
    const s = stepById("clients");
    assert.equal(s.revealedTargetSelector, '[data-tour="clients-list"], [data-tour="client-card"]');
    assert.equal(s.cardAvoidSelector, '[data-tour="client-card"]');
    assert.match(shellSource, /data-tour=\{!selectedAppt && selectedClient \? "client-card" : undefined\}/);
  });

  test("Mobile Admin: only Schedule or Clients reveal; other tabs show a hint; Next then advances", () => {
    const api = host();
    goTo(api, "mobile-experience");
    const s = api().currentStep!;
    assert.equal(s.body, "Everything you can do here also works on your phone. Click Schedule or Clients in the bottom bar of the phone preview.");
    assert.match(s.targetSelector!, /mobile-bottom-nav/, "the bottom bar is what's highlighted first");
    act(() => notifyDemoAction("open-mobile-other-tab"));
    assert.equal(api().revealed, false);
    assert.ok(api().hint);
    act(() => notifyDemoAction("open-mobile-tab"));
    assert.equal(api().currentStep!.id, "mobile-experience");
    assert.equal(api().revealed, true);
    assert.equal(api().hint, null);
    act(() => api().next());
    assert.equal(api().currentStep!.id, "settings-overview");
  });

  test("Settings overview: opening Settings reveals the tabs with hover help; nothing else required", () => {
    const api = host();
    goTo(api, "settings-overview");
    assert.equal(api().canAdvance, false);
    act(() => notifyDemoAction("open-settings"));
    assert.equal(api().currentStep!.id, "settings-overview");
    act(() => api().next());
    assert.equal(api().currentStep!.id, "completion");
    const s = stepById("settings-overview");
    for (const tab of ["Company Info", "Services", "Employees", "Recurring Series", "Billing"]) {
      assert.ok(s.revealedBody!.includes(tab), `${tab} is pointed out`);
      assert.ok(s.tabHelp![tab], `${tab} has hover help`);
    }
    assert.match(s.revealedBody!, /Hover over each tab/);
    assert.match(s.revealedBody!, /Nothing needs to be changed/);
    for (const tab of ["Automation", "Notifications", "Subscription"]) assert.match(s.tabHelp![tab], /Not available in the demo/);
  });

  test("the opened screens report their actions from one place each", () => {
    const shell = shellSource.replace(/\r\n/g, "\n");
    assert.match(shell, /setCenterMode\("settings"\);\n\s*setSettingsSection\("company"\);\n\s*notifyDemoAction\("open-settings"\);/);
    const preview = readSource("./MobileExperiencePreview.tsx");
    assert.match(preview, /STEP_TABS = new Set\(\["schedule", "clients"\]\)/);
    assert.match(preview, /STEP_TABS\.has\(event\.data\.tab\) \? "open-mobile-tab" : "open-mobile-other-tab"/);
    assert.match(readSource("../mobile/MobileBottomNav.tsx"), /data-tour="mobile-bottom-nav"/);
    assert.match(readSource("../dashboard/LeftBar.tsx"), /data-tour="settings-button"/);
    assert.match(readSource("../dashboard/SettingsTabBar.tsx"), /data-tour="settings-tabs"/);
    assert.match(readSource("../dashboard/DashboardSettingsArea.tsx"), /data-tour="settings-area"/);
    assert.match(readSource("../dashboard/ServicesPanel.tsx"), /data-tour="service-form"/);
  });

  test("the overlay locks Next until the step's action, and shows hover help only after the reveal", () => {
    assert.match(overlaySource, /disabled=\{nextLocked\}/);
    assert.match(overlaySource, /const nextLocked = !currentStep\.actionRequired && !canAdvance;/);
    assert.match(overlaySource, /const helpSelector = active && revealed \? currentStep\?\.tabHelpSelector \?\? null : null;/);
    assert.match(overlaySource, /<li>✓ Toured Settings<\/li>/);
  });
});

describe("Add Appointment: one unambiguous goal, completed only by a saved appointment", () => {
  test("the instruction names the button, an existing client, and saving; a new client is optional", () => {
    const s = stepById("add-appointment");
    assert.equal(s.body, "Click + Add Appointment, choose an existing client, and save a new appointment. Adding a new client from the form is optional.");
    assert.equal(s.actionId, "create-appointment");
  });

  test("create-appointment is reported only after the appointment itself is saved -- nowhere else", () => {
    const modal = readSource("../dashboard/AppointmentModal.tsx").replace(/\r\n/g, "\n");
    assert.match(modal, /if \(!res\.ok\) \{ setError\(data\?\.error \|\| `Request failed \(\$\{res\.status\}\)`\); return; \}\n\s*if \(data\?\.warning\?\.message\) alert\(data\.warning\.message\);\n\s*notifyDemoAction\("create-appointment"\);/);
    assert.equal((modal.match(/notifyDemoAction\("create-appointment"\)/g) ?? []).length, 1);
    for (const rel of ["../dashboard/DashboardShell.tsx", "../dashboard/ClientPanel.tsx", "../dashboard/LeftBar.tsx", "../dashboard/ArchivedClientsPanel.tsx"]) {
      assert.doesNotMatch(readSource(rel), /notifyDemoAction\("create-appointment"\)/, `${rel} never completes the step`);
    }
  });
});

describe("placeCard -- the instruction card never covers what the visitor is using", () => {
  const overlaps = (a: Box, b: Box) =>
    a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
  const inside = (c: Box, vw: number, vh: number) => c.left >= 0 && c.top >= 0 && c.left + c.width <= vw && c.top + c.height <= vh;

  test("Services: the Add Service form stays clear at a full desktop, a small laptop, and 125% zoom", () => {
    for (const [vw, vh] of [[1440, 900], [1280, 720], [1093, 614]]) {
      // The Settings panel (spotlight) fills the center; the form sits inside it.
      const panel: Box = { left: 250, top: 120, width: vw - 250 - 340, height: vh - 140 };
      const form: Box = { left: 280, top: 300, width: Math.min(576, panel.width - 60), height: 300 };
      const card = placeCard({ cardWidth: 384, cardHeight: 210, holes: [panel], avoid: [form], viewportWidth: vw, viewportHeight: vh });
      assert.ok(!overlaps(card, form), `form covered at ${vw}x${vh}: ${JSON.stringify(card)}`);
      assert.ok(inside(card, vw, vh), `card off screen at ${vw}x${vh}`);
    }
  });

  test("the appointment form stays clear, narrowing the card when the window is small", () => {
    for (const [vw, vh] of [[1440, 900], [1280, 720], [1093, 614]]) {
      const modal: Box = { left: (vw - 512) / 2, top: 24, width: 512, height: vh - 48 };
      const card = placeCard({ cardWidth: 384, cardHeight: 200, holes: [], avoid: [modal], viewportWidth: vw, viewportHeight: vh });
      assert.ok(!overlaps(card, modal), `modal covered at ${vw}x${vh}: ${JSON.stringify(card)}`);
      assert.ok(inside(card, vw, vh));
    }
  });

  test("with nothing to avoid, the card sits beside the spotlight, not on it", () => {
    const hole: Box = { left: 20, top: 300, width: 200, height: 400 };
    const card = placeCard({ cardWidth: 384, cardHeight: 200, holes: [hole], avoid: [], viewportWidth: 1440, viewportHeight: 900 });
    assert.ok(!overlaps(card, hole));
  });
});

describe("overlay card measurement cannot loop", () => {
  test("each card width is measured once per step text (bounded updates)", () => {
    assert.match(overlaySource, /if \(prev\.key === contentKey && prev\.byWidth\[w\] !== undefined\) return prev;/);
    assert.match(overlaySource, /const contentKey = `\$\{currentStep\?\.id\}\|\$\{revealed\}\|\$\{hint \?\? ""\}`;/);
  });
});
