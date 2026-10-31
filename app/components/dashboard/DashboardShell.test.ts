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

describe("DashboardShell: centerMode/settingsSection are persisted (refresh reopens the same Settings section)", () => {
  test("centerMode and settingsSection come from useDashboardNavigationPrefs, not a plain useState -- so a hard refresh while in Settings -> Billing reopens Settings -> Billing, not the dashboard calendar", () => {
    assert.match(source, /import \{ useDashboardNavigationPrefs \} from "@\/app\/components\/dashboard\/useDashboardNavigationPrefs"/);
    assert.match(
      source,
      /const \{ centerMode, setCenterMode, settingsSection, setSettingsSection \} = useDashboardNavigationPrefs\(workspaceId, userId\)/
    );
    assert.doesNotMatch(source, /useState<CenterMode>/, "the old plain useState for centerMode is gone, not left alongside the hook");
    assert.doesNotMatch(source, /useState<SettingsSection>/, "the old plain useState for settingsSection is gone, not left alongside the hook");
  });

  test("handleToggleSettings' manual-open branch still forces settingsSection to \"company\" -- only the hard-refresh restore path resurrects \"billing\"", () => {
    const toggleSettingsBody = source.slice(source.indexOf("function handleToggleSettings("), source.indexOf("const modalEl"));
    const elseBranch = toggleSettingsBody.slice(toggleSettingsBody.indexOf("} else {"));
    assert.match(elseBranch, /setSettingsSection\("company"\)/);
  });
});

describe("DashboardShell: Needs Attention control -- placement and collapse behavior", () => {
  test("imports NeedsAttentionControl", () => {
    assert.match(source, /import NeedsAttentionControl from "@\/app\/components\/dashboard\/NeedsAttentionControl"/);
  });

  test("renders inside the dispatch-sidebar aside, above DispatchPanel, only in the EXPANDED branch (collapses with the rest of the right sidebar)", () => {
    const ternaryStart = desktopBlock.indexOf("rightCollapsed ? (");
    assert.notEqual(ternaryStart, -1);
    const expandedBranchStart = desktopBlock.indexOf(") : (", ternaryStart);
    assert.notEqual(expandedBranchStart, -1);
    const expandedBranch = desktopBlock.slice(expandedBranchStart, desktopBlock.indexOf("{modalEl}"));
    const collapsedBranch = desktopBlock.slice(ternaryStart, expandedBranchStart);

    assert.doesNotMatch(collapsedBranch, /<NeedsAttentionControl/, "must not render while the sidebar is collapsed");
    const controlIdx = expandedBranch.indexOf("<NeedsAttentionControl");
    const dispatchIdx = expandedBranch.indexOf("<DispatchPanel");
    assert.ok(controlIdx > -1 && dispatchIdx > -1);
    assert.ok(controlIdx < dispatchIdx, "NeedsAttentionControl renders above DispatchPanel");
  });

  test("is wired to onNavigateToAppointment, onNavigateToBilling, and refreshToken", () => {
    const block = desktopBlock.match(/<NeedsAttentionControl[\s\S]*?\/>/);
    assert.ok(block, "NeedsAttentionControl is rendered");
    assert.match(block![0], /onNavigateToAppointment=\{handleNeedsAttentionSelectAppointment\}/);
    assert.match(block![0], /onNavigateToBilling=\{handleNeedsAttentionSelectBilling\}/);
    assert.match(block![0], /refreshToken=\{needsAttentionRefreshToken\}/);
  });
});

describe("DashboardShell: Needs Attention navigation handlers", () => {
  function fnBody(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `function ${name} not found`);
    // Every handler in this file is followed by a blank line then the
    // next declaration -- slicing to the next "function " after the
    // opening brace is a safe, simple boundary for a single-purpose body.
    const nextFn = source.indexOf("\n  function ", start + 1);
    return source.slice(start, nextFn === -1 ? start + 600 : nextFn);
  }

  test("handleNeedsAttentionSelectAppointment forces centerMode back to \"schedule\" (so AppointmentDetailPanel's Message History card is visible) and selects the appointment via the existing selectAppointment", () => {
    const body = fnBody("handleNeedsAttentionSelectAppointment");
    assert.match(body, /setCenterMode\("schedule"\)/);
    assert.match(body, /selectAppointment\(appointmentId\)/);
  });

  // Regression: selecting an appointment from Needs Attention used to only
  // update selectedApptId/selectedClientId -- the schedule grid itself kept
  // showing whatever week/month it already happened to be on, so a past (or
  // future) appointment's own card was never actually visible on screen
  // after "selecting" it. resolveCalendarNavigation (lib/calendarNavigation.ts,
  // unit-tested directly in lib/calendarNavigation.test.ts) now resolves the
  // correct view/weekOffset/monthOffset for the appointment's own date.
  test("handleNeedsAttentionSelectAppointment imports and calls resolveCalendarNavigation with the appointment's scheduled_for, the CURRENT viewMode, and the workspace timezone", () => {
    assert.match(source, /import \{ resolveCalendarNavigation \} from "@\/lib\/calendarNavigation";/);
    const body = fnBody("handleNeedsAttentionSelectAppointment");
    assert.match(body, /resolveCalendarNavigation\(appt\.scheduled_for, viewMode, timezone\)/);
  });

  test("handleNeedsAttentionSelectAppointment applies the resolved navigation (view, week, and month) before/alongside selecting the appointment", () => {
    const body = fnBody("handleNeedsAttentionSelectAppointment");
    assert.match(body, /setViewMode\(nav\.viewMode\)/);
    assert.match(body, /setWeekOffset\(nav\.weekOffset\)/);
    assert.match(body, /setMonthOffset\(nav\.monthOffset\)/);
  });

  test("the appointment is resolved from the full, un-filtered `appointments` array (never the week-filtered calendar view), and navigation is skipped (not crashed) if it's somehow missing", () => {
    const body = fnBody("handleNeedsAttentionSelectAppointment");
    assert.match(body, /const appt = appointments\.find\(\(a\) => a\.id === appointmentId\);/);
    assert.match(body, /if \(appt\) \{/);
  });

  test("handleNeedsAttentionSelectBilling (the billing-destination branch) is untouched by the calendar-navigation change -- Billing has its own date-range mechanism (billingFocus), not the schedule grid's weekOffset/monthOffset", () => {
    const body = fnBody("handleNeedsAttentionSelectBilling");
    assert.doesNotMatch(body, /resolveCalendarNavigation/);
    assert.doesNotMatch(body, /setWeekOffset/);
    assert.doesNotMatch(body, /setMonthOffset/);
  });

  // Regression: a worked-time-review click and a failed-message click both
  // used to just "select the appointment" and hope the right card happened
  // to already be on screen. Each must now land on its OWN matching
  // section -- see needsAttentionFocusSection's own comment.
  describe("distinct destinations per issue kind (worked-time review vs failed message)", () => {
    test("handleNeedsAttentionSelectAppointment takes an issueKind parameter typed to the two non-billing issue kinds", () => {
      assert.match(
        source,
        /function handleNeedsAttentionSelectAppointment\(appointmentId: string, issueKind: "worked_time_review" \| "failed_message"\)/
      );
    });

    test("needsAttentionFocusSection state exists, typed to the same two kinds (or null)", () => {
      assert.match(
        source,
        /const \[needsAttentionFocusSection, setNeedsAttentionFocusSection\] = useState<"worked_time_review" \| "failed_message" \| null>\(null\);/
      );
    });

    test("selectAppointment (the general-purpose selector, used by every OTHER selection path) unconditionally clears needsAttentionFocusSection to null", () => {
      const start = source.indexOf("function selectAppointment(");
      const body = source.slice(start, source.indexOf("\n  }", start) + 4);
      assert.match(body, /setNeedsAttentionFocusSection\(null\)/);
    });

    test("handleNeedsAttentionSelectAppointment sets needsAttentionFocusSection to the issueKind AFTER calling selectAppointment (which would otherwise immediately clear it back to null)", () => {
      const body = fnBody("handleNeedsAttentionSelectAppointment");
      const selectCallIdx = body.indexOf("selectAppointment(appointmentId)");
      const setFocusIdx = body.indexOf("setNeedsAttentionFocusSection(issueKind)");
      assert.ok(selectCallIdx !== -1 && setFocusIdx !== -1, "both calls are present");
      assert.ok(setFocusIdx > selectCallIdx, "setNeedsAttentionFocusSection must run AFTER selectAppointment, not before");
    });

    test("AppointmentDetailPanel receives focusMessageHistory, true only when the focus section is \"failed_message\"", () => {
      const block = desktopBlock.match(/<AppointmentDetailPanel[\s\S]*?\/>/);
      assert.ok(block, "AppointmentDetailPanel is rendered");
      assert.match(block![0], /focusMessageHistory=\{needsAttentionFocusSection === "failed_message"\}/);
    });

    test("DispatchPanel receives focusWorkedTimeReview, true only when the focus section is \"worked_time_review\"", () => {
      const block = desktopBlock.match(/<DispatchPanel[\s\S]*?\/>/);
      assert.ok(block, "DispatchPanel is rendered");
      assert.match(block![0], /focusWorkedTimeReview=\{needsAttentionFocusSection === "worked_time_review"\}/);
    });
  });

  test("handleNeedsAttentionSelectBilling sets the billing focus target and switches to Settings -> Billing", () => {
    const body = fnBody("handleNeedsAttentionSelectBilling");
    assert.match(body, /setBillingFocus\(\{\s*appointmentId,\s*serviceDate\s*\}\)/);
    assert.match(body, /setSettingsSection\("billing"\)/);
    assert.match(body, /setCenterMode\("settings"\)/);
  });

  test("handleSettingsSelect (the owner's own manual Settings tab navigation) clears any Needs Attention billing focus, so a stale highlight never lingers", () => {
    const body = fnBody("handleSettingsSelect");
    assert.match(body, /setBillingFocus\(null\)/);
    assert.match(body, /setSettingsSection\(section\)/);
  });

  test("DashboardSettingsArea receives handleSettingsSelect (not the raw setSettingsSection) and the current billing focus", () => {
    const block = desktopBlock.match(/<DashboardSettingsArea[\s\S]*?\/>/);
    assert.ok(block);
    assert.match(block![0], /onSettingsSelect=\{handleSettingsSelect\}/);
    assert.match(block![0], /billingFocusAppointmentId=\{billingFocus\?\.appointmentId\}/);
    assert.match(block![0], /billingFocusServiceDate=\{billingFocus\?\.serviceDate\}/);
  });
});

describe("DashboardShell: Needs Attention refresh triggers", () => {
  test("a worked-time-hours save (handleHoursSaved) bumps needsAttentionRefreshToken -- a correction may have just resolved an item", () => {
    const start = source.indexOf("function handleHoursSaved(");
    const body = source.slice(start, source.indexOf("\n  function ", start + 1));
    assert.match(body, /setNeedsAttentionRefreshToken\(\(prev\) => prev \+ 1\)/);
  });

  test("leaving Settings (handleToggleSettings' own \"settings\" -> \"schedule\" branch) bumps needsAttentionRefreshToken", () => {
    const start = source.indexOf("function handleToggleSettings(");
    const body = source.slice(start, source.indexOf("\n  }", start) + 4);
    const settingsToScheduleBranch = body.slice(0, body.indexOf("} else {"));
    assert.match(settingsToScheduleBranch, /setCenterMode\("schedule"\)/);
    assert.match(settingsToScheduleBranch, /setNeedsAttentionRefreshToken\(\(prev\) => prev \+ 1\)/);
  });

  test("the tester carve-out's onBack (the only way a tester session leaves Settings) also bumps needsAttentionRefreshToken", () => {
    const onBackBlock = desktopBlock.match(/onBack=\{\(\) => \{[\s\S]*?\}\}/);
    assert.ok(onBackBlock, "onBack is passed as an inline handler");
    assert.match(onBackBlock![0], /setCenterMode\("schedule"\)/);
    assert.match(onBackBlock![0], /setNeedsAttentionRefreshToken\(\(prev\) => prev \+ 1\)/);
  });

  // Payment outstanding / needs invoicing refresh: a successful Billing
  // save (invoice number or paid/payment method) bumps the same token
  // immediately, without waiting for the owner to leave Settings.
  test("handleBillingSaved bumps needsAttentionRefreshToken", () => {
    const start = source.indexOf("function handleBillingSaved(");
    assert.notEqual(start, -1, "function handleBillingSaved not found");
    const body = source.slice(start, source.indexOf("\n  }", start) + 4);
    assert.match(body, /setNeedsAttentionRefreshToken\(\(prev\) => prev \+ 1\)/);
  });

  test("DashboardSettingsArea receives onBillingSaved={handleBillingSaved}", () => {
    const block = desktopBlock.match(/<DashboardSettingsArea[\s\S]*?\/>/);
    assert.ok(block);
    assert.match(block![0], /onBillingSaved=\{handleBillingSaved\}/);
  });
});

describe("DashboardShell: isLocalDemo (browser-local demo) pass-through", () => {
  test("isLocalDemo is an optional prop destructured with a safe false default, and forwarded to DashboardSettingsArea", () => {
    assert.match(source, /isLocalDemo\?:\s*boolean;/);
    assert.match(source, /\n\s*isLocalDemo = false,\r?\n/);
    const block = desktopBlock.match(/<DashboardSettingsArea[\s\S]*?\/>/);
    assert.ok(block);
    assert.match(block![0], /isLocalDemo=\{isLocalDemo\}/);
  });

  test("the real server page never passes isLocalDemo (so it stays false there)", () => {
    assert.doesNotMatch(pageSource, /isLocalDemo/);
  });

  test("the Demo Mode banner gains DemoBannerControls only for isLocalDemo, never for the real tester-backend banner", () => {
    assert.match(source, /import DemoBannerControls from "@\/app\/components\/dashboard\/DemoBannerControls";/);
    const bannerBlock = desktopBlock.match(/\{isTester && \([\s\S]*?Demo Mode — All information shown[\s\S]*?\)\}/);
    assert.ok(bannerBlock, "the Demo Mode banner block is present");
    // A Guided Demo Session (guidedSession) hides it: its Reset Demo would
    // only touch this browser's local data, never the shared session.
    assert.match(bannerBlock![0], /\{isLocalDemo && !guidedSession && <DemoBannerControls \/>\}/);
  });

  test("isLocalDemo IS also forwarded to MobileDashboard, not just DashboardSettingsArea -- a mobile demo visitor must not silently fall back to isLocalDemo=false", () => {
    const block = mobileBlock.match(/<MobileDashboard[\s\S]*?\/>/);
    assert.ok(block, "MobileDashboard is rendered on the mobile branch");
    // Guided Demo Sessions are desktop-only in milestone 1, so only they opt out.
    assert.match(block![0], /isLocalDemo=\{isLocalDemo && !guidedSession\}/);
  });

  test("guidedSession is optional (false everywhere else) and hides only the tour and the local Demo Controls", () => {
    assert.match(source, /guidedSession\?: boolean;/);
    assert.match(source, /guidedSession = false,/);
    assert.match(source, /<DemoExperienceProvider autoStart=\{isTester && !guidedSession\}>/);
    assert.match(source, /\{isTester && !guidedSession && <MobileExperiencePreview isLocalDemo=\{isLocalDemo\} \/>\}/);
    assert.match(source, /\{isTester && !guidedSession && <DemoExperienceOverlay \/>\}/);
  });

  test("the Guided Demo Session control strip is docked right under the Demo Mode banner, never floating over the dashboard", () => {
    assert.match(source, /sessionBar\?: React\.ReactNode;/);
    assert.match(source, /<DemoBannerControls \/>\}\s*<\/div>\s*\)\}\s*\{sessionBar\}/);
  });

  test("onSignOut is an optional override prop, used by the real DashboardSettingsArea call site, and forwarded to MobileDashboard too", () => {
    assert.match(source, /onSignOut\?:\s*\(\)\s*=>\s*void;/);
    assert.match(source, /onSignOut:\s*onSignOutOverride,/);
    const desktopSettingsBlock = desktopBlock.match(/<DashboardSettingsArea[\s\S]*?\/>/);
    assert.ok(desktopSettingsBlock);
    assert.match(desktopSettingsBlock![0], /onSignOut=\{onSignOutOverride \?\? handleSignOut\}/);
    const mobileShellBlock = mobileBlock.match(/<MobileDashboard[\s\S]*?\/>/);
    assert.ok(mobileShellBlock);
    assert.match(mobileShellBlock![0], /onSignOut=\{onSignOutOverride\}/);
  });

  test("isTrialing/workspaceId/userId are also forwarded to MobileDashboard -- needed so a mobile demo visitor's real SettingsPanel drill-down (via MobileSettings) has everything the desktop one already gets", () => {
    const block = mobileBlock.match(/<MobileDashboard[\s\S]*?\/>/);
    assert.ok(block);
    for (const p of ["isTrialing={entitlement.isTrialing}", "workspaceId={workspaceId}", "userId={userId}"]) {
      assert.ok(block![0].includes(p), `MobileDashboard call is missing ${p}`);
    }
  });

  test("onSignOut is ALSO forwarded to LeftBar -- it has its own independent sign-out button, distinct from DashboardSettingsArea's and MobileDashboard's, found unwired via live verification", () => {
    const leftBarBlock = desktopBlock.match(/<LeftBar[\s\S]*?\/>/);
    assert.ok(leftBarBlock, "LeftBar is rendered on the desktop branch");
    assert.match(leftBarBlock![0], /onSignOut=\{onSignOutOverride\}/);
  });

  test("the mobile branch is wrapped in DemoExperienceProvider, not just the desktop branch -- MobileDemoControls reuses DemoControlsPanel, which calls useDemoExperienceContext() and throws without a provider in the tree", () => {
    assert.match(mobileBlock, /<DemoExperienceProvider[\s\S]*?<MobileDashboard/);
    assert.match(mobileBlock, /<\/DemoExperienceProvider>\s*\n\s*\);/);
  });
});
