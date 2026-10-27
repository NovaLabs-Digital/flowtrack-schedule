// DashboardShell.tsx is a .tsx file with no existing dedicated test file
// (every other test that touches it does so only incidentally, via
// MobileDashboard.test.ts's or page.test.ts's own source inspection). This
// file follows that same established SOURCE INSPECTION convention -- prop
// wiring, guard placement, exact structural position -- rather than
// rendering the full shell (which pulls in TopBar, LeftBar, ScheduleGrid,
// DispatchPanel, ClientPanel, AppointmentDetailPanel, DashboardSettingsArea,
// MobileDashboard, AppointmentModal, MoveConfirmDialog, and the demo-
// experience provider all at once -- no existing test in this codebase
// attempts that full an integration render for this component).
//
// The real interactive/behavioral proof for the resizable-panel feature
// itself lives in ResizeHandle.test.ts (pointer/keyboard dragging, ARIA)
// and useDashboardLayoutPrefs.test.ts (clamping, persistence, workspace
// scoping, reset, responsive reclamping) -- both exercised with real React
// rendering. This file proves those two pieces are actually wired into
// DashboardShell the way the feature requires.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");
const pageSource = fs.readFileSync(fileURLToPath(new URL("../../dashboard/page.tsx", import.meta.url)), "utf8");

// Everything from the mobile early-return down to (but not including) the
// "DESKTOP LAYOUT" comment -- used to prove resizing is desktop-only.
const mobileBlock = source.slice(source.indexOf("if (isMobile) {"), source.indexOf("DESKTOP LAYOUT"));
const desktopBlock = source.slice(source.indexOf("DESKTOP LAYOUT"));

describe("DashboardShell: workspaceId threaded in for layout-preference scoping only", () => {
  test("accepts a workspaceId prop", () => {
    assert.match(source, /workspaceId,?\r?\n/, "workspaceId is destructured from props");
    assert.match(source, /workspaceId:\s*string;/, "workspaceId is typed as a string in the props type");
  });

  test("workspaceId is never sent to fetch/a server route (UI-only scoping, matching IncomeProjection's sft_ localStorage convention)", () => {
    assert.doesNotMatch(source, /fetch\([^)]*workspaceId/);
  });

  test("app/dashboard/page.tsx passes its server-resolved workspaceId through to DashboardShell", () => {
    const shellBlock = pageSource.match(/<DashboardShell[\s\S]*?\/>/);
    assert.ok(shellBlock, "DashboardShell is rendered in page.tsx");
    assert.match(shellBlock![0], /workspaceId=\{workspaceId\}/);
  });
});

describe("DashboardShell: userId threaded in, paired with workspaceId, for per-person layout scoping", () => {
  test("accepts a userId prop", () => {
    assert.match(source, /userId,?\r?\n/, "userId is destructured from props");
    assert.match(source, /userId:\s*string;/, "userId is typed as a string in the props type");
  });

  test("userId is never sent to fetch/a server route", () => {
    assert.doesNotMatch(source, /fetch\([^)]*userId/);
  });

  test("app/dashboard/page.tsx passes a derived userId through to DashboardShell", () => {
    const shellBlock = pageSource.match(/<DashboardShell[\s\S]*?\/>/);
    assert.ok(shellBlock);
    assert.match(shellBlock![0], /userId=\{userId\}/);
  });

  test("page.tsx derives userId from the owner's real authUserId, with a fixed fallback for tester sessions (which have no individual identity)", () => {
    assert.match(pageSource, /const userId = session\.role === "owner" \? session\.authUserId : "tester";/);
  });
});

describe("DashboardShell: useDashboardLayoutPrefs wiring", () => {
  test("imports the hook and the ResizeHandle primitive", () => {
    assert.match(source, /import ResizeHandle from "@\/app\/components\/dashboard\/ResizeHandle"/);
    assert.match(source, /import \{\s*\n?\s*useDashboardLayoutPrefs/);
  });

  test("calls useDashboardLayoutPrefs(workspaceId, userId) and destructures every return value, including collapse state", () => {
    assert.match(source, /useDashboardLayoutPrefs\(workspaceId, userId\)/);
    for (const name of [
      "scheduleHeightPct",
      "setScheduleHeightPct",
      "sidebarWidthPx",
      "setSidebarWidthPx",
      "leftCollapsed",
      "toggleLeftCollapsed",
      "rightCollapsed",
      "toggleRightCollapsed",
      "resetLayout",
    ]) {
      assert.match(source, new RegExp(name), `${name} is referenced`);
    }
  });

  test("the schedule-grid wrapper's height is driven by scheduleHeightPct, not a hardcoded flex ratio", () => {
    assert.doesNotMatch(desktopBlock, /flex:\s*"68 1 0%"/, "the old hardcoded 68% ratio is gone");
    assert.match(desktopBlock, /flexBasis:\s*`\$\{scheduleHeightPct\}%`/);
  });

  test("the dispatch sidebar's width is driven by sidebarWidthPx, not a hardcoded Tailwind width class", () => {
    assert.doesNotMatch(desktopBlock, /w-\[380px\]/, "the old hardcoded 380px width class is gone");
    assert.match(desktopBlock, /style=\{\{\s*width:\s*sidebarWidthPx\s*\}\}/);
  });

  test("the left bar's width toggles between LEFT_BAR_WIDTH_PX and LEFT_BAR_COLLAPSED_WIDTH_PX, not a hardcoded Tailwind width class (collapsible, but still never drag-resized -- see the two-dividers test below)", () => {
    assert.doesNotMatch(desktopBlock, /w-\[230px\]/, "the old hardcoded 230px width class is gone");
    assert.match(desktopBlock, /width:\s*leftCollapsed\s*\?\s*LEFT_BAR_COLLAPSED_WIDTH_PX\s*:\s*LEFT_BAR_WIDTH_PX/);
  });
});

describe("DashboardShell: two dividers, desktop-only", () => {
  test("renders exactly two ResizeHandle elements, both inside the desktop branch", () => {
    const desktopCount = (desktopBlock.match(/<ResizeHandle/g) ?? []).length;
    assert.equal(desktopCount, 2);
    assert.doesNotMatch(mobileBlock, /<ResizeHandle/, "no divider is rendered on the mobile branch");
  });

  test("the horizontal divider sits between the schedule grid and the lower details panel, inside the schedule-mode branch", () => {
    const scheduleGridIdx = desktopBlock.indexOf('data-tour="schedule-grid"');
    const horizontalIdx = desktopBlock.indexOf('orientation="horizontal"');
    const lowerPanelIdx = desktopBlock.indexOf("AppointmentDetailPanel");
    assert.ok(scheduleGridIdx > -1 && horizontalIdx > -1 && lowerPanelIdx > -1);
    assert.ok(scheduleGridIdx < horizontalIdx, "the schedule grid comes before the horizontal divider");
    assert.ok(horizontalIdx < lowerPanelIdx, "the horizontal divider comes before the lower details panel");
  });

  test("the horizontal divider and its reset button are only rendered when centerMode === \"schedule\" (not alongside DashboardSettingsArea)", () => {
    const settingsIdx = desktopBlock.indexOf("<DashboardSettingsArea");
    const horizontalIdx = desktopBlock.indexOf('orientation="horizontal"');
    assert.ok(horizontalIdx < settingsIdx, "the divider block appears in the schedule-mode branch, before the settings branch's own element");
  });

  test("the vertical divider is gated by the same !isPhoneLandscape check as the dispatch sidebar it sits next to", () => {
    const phoneLandscapeBlock = desktopBlock.slice(desktopBlock.indexOf("{!isPhoneLandscape && ("));
    assert.match(phoneLandscapeBlock.slice(0, phoneLandscapeBlock.indexOf("DispatchPanel")), /orientation="vertical"/);
  });
});

describe("DashboardShell: left sidebar collapse (icon strip, handled inside LeftBar.tsx)", () => {
  test("LeftBar receives collapsed and onToggleCollapsed props", () => {
    const leftBarBlock = desktopBlock.match(/<LeftBar[\s\S]*?\/>/);
    assert.ok(leftBarBlock, "LeftBar is rendered");
    assert.match(leftBarBlock![0], /collapsed=\{leftCollapsed\}/);
    assert.match(leftBarBlock![0], /onToggleCollapsed=\{toggleLeftCollapsed\}/);
  });

  test("no third ResizeHandle was added for the left bar -- collapsing is a toggle, not a drag-resize (still exactly two dividers total, per the test above)", () => {
    const leftBarBlock = desktopBlock.match(/<LeftBar[\s\S]*?\/>/)![0];
    assert.doesNotMatch(leftBarBlock, /ResizeHandle/);
  });
});

describe("DashboardShell: right sidebar collapse (hidden entirely, not just an icon strip)", () => {
  test("imports PanelRightOpen/PanelRightClose from lucide-react", () => {
    assert.match(source, /PanelRightClose/);
    assert.match(source, /PanelRightOpen/);
  });

  test("when rightCollapsed, neither the vertical ResizeHandle nor DispatchPanel render -- only a reopen button", () => {
    const ternaryStart = desktopBlock.indexOf("rightCollapsed ? (");
    assert.notEqual(ternaryStart, -1);
    const expandedBranchStart = desktopBlock.indexOf(") : (", ternaryStart);
    assert.notEqual(expandedBranchStart, -1);
    const collapsedBranch = desktopBlock.slice(ternaryStart, expandedBranchStart);
    assert.doesNotMatch(collapsedBranch, /<ResizeHandle/, "the resize handle is hidden while collapsed");
    assert.doesNotMatch(collapsedBranch, /<DispatchPanel/, "the panel itself is hidden while collapsed");
    assert.match(collapsedBranch, /onClick=\{toggleRightCollapsed\}/);
    assert.match(collapsedBranch, /aria-label="Show dispatch panel"/);
    assert.match(collapsedBranch, /aria-expanded=\{false\}/);
  });

  test("when expanded, both the vertical ResizeHandle and DispatchPanel render, alongside a collapse button", () => {
    const ternaryStart = desktopBlock.indexOf("rightCollapsed ? (");
    assert.notEqual(ternaryStart, -1);
    const expandedBranchStart = desktopBlock.indexOf(") : (", ternaryStart);
    assert.notEqual(expandedBranchStart, -1);
    const expandedBranch = desktopBlock.slice(expandedBranchStart, desktopBlock.indexOf("{modalEl}"));
    assert.match(expandedBranch, /<ResizeHandle/);
    assert.match(expandedBranch, /<DispatchPanel/);
    assert.match(expandedBranch, /onClick=\{toggleRightCollapsed\}/);
    assert.match(expandedBranch, /aria-label="Collapse dispatch panel"/);
    assert.match(expandedBranch, /aria-expanded=\{true\}/);
  });

  test("the reopen/collapse buttons are real <button> elements (keyboard-focusable), not divs with onClick", () => {
    const rightBlock = desktopBlock.slice(desktopBlock.indexOf("Right dispatch panel"), desktopBlock.indexOf("{modalEl}"));
    const showBtnIdx = rightBlock.indexOf('aria-label="Show dispatch panel"');
    const collapseBtnIdx = rightBlock.indexOf('aria-label="Collapse dispatch panel"');
    assert.ok(showBtnIdx > -1 && collapseBtnIdx > -1);
    assert.match(rightBlock.slice(Math.max(0, showBtnIdx - 150), showBtnIdx), /<button/);
    assert.match(rightBlock.slice(Math.max(0, collapseBtnIdx - 200), collapseBtnIdx), /<button/);
  });
});

describe("DashboardShell: reset layout control", () => {
  test("a discoverable reset button calls resetLayout and is labelled for assistive tech", () => {
    assert.match(desktopBlock, /onClick=\{resetLayout\}/);
    assert.match(desktopBlock, /aria-label="Reset panel layout to default sizes"/);
    assert.match(desktopBlock, /title="Reset layout"/);
  });
});

describe("DashboardShell: layout state is independent of appointment/client selection", () => {
  test("selectAppointment and handleSelectClient never touch the layout setters or resetLayout", () => {
    const selectAppointmentBody = source.slice(source.indexOf("function selectAppointment("), source.indexOf("function handleAppointmentCancelled("));
    const handleSelectClientBody = source.slice(source.indexOf("function handleSelectClient("), source.indexOf("function selectAppointment("));
    for (const body of [selectAppointmentBody, handleSelectClientBody]) {
      assert.doesNotMatch(body, /setScheduleHeightPct|setSidebarWidthPx|resetLayout/);
    }
  });

  test("switching centerMode (schedule <-> settings) never touches the layout setters or resetLayout", () => {
    const toggleSettingsBody = source.slice(source.indexOf("function handleToggleSettings("), source.indexOf("const modalEl"));
    assert.doesNotMatch(toggleSettingsBody, /setScheduleHeightPct|setSidebarWidthPx|resetLayout/);
  });
});
