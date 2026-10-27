// Real rendered-hook behavior tests for useDashboardLayoutPrefs.ts, using
// the jsdom + @testing-library/react foundation already established by
// IncomeProjection.test.ts for the same hydration-safe localStorage
// pattern. Hooks can't be called outside a component, so a tiny host
// component exposes the hook's return value through data attributes and
// buttons that drive its setters -- the same technique used wherever this
// codebase tests a hook indirectly via render + screen queries.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import "../../../lib/testDom.ts";

import React from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  useDashboardLayoutPrefs,
  clampScheduleHeightPct,
  clampSidebarWidthPx,
  maxSidebarWidthForViewport,
  DEFAULT_SCHEDULE_HEIGHT_PCT,
  MIN_SCHEDULE_HEIGHT_PCT,
  MAX_SCHEDULE_HEIGHT_PCT,
  DEFAULT_SIDEBAR_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  LEFT_BAR_WIDTH_PX,
} = await import("./useDashboardLayoutPrefs.ts");

// Most tests don't care about per-user scoping itself (that gets its own
// dedicated describe block below) -- a fixed default keeps every other
// test's call site unchanged from before userId was added.
const USER = "user-1";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  // Restore real innerWidth after any test that overrode it for
  // viewport-clamp scenarios.
  if ((window as any).__origInnerWidth !== undefined) {
    Object.defineProperty(window, "innerWidth", { value: (window as any).__origInnerWidth, configurable: true });
    delete (window as any).__origInnerWidth;
  }
});

function setInnerWidth(px: number) {
  if ((window as any).__origInnerWidth === undefined) {
    (window as any).__origInnerWidth = window.innerWidth;
  }
  Object.defineProperty(window, "innerWidth", { value: px, configurable: true });
}

function Host({ workspaceId, userId = USER }: { workspaceId: string; userId?: string }) {
  const {
    scheduleHeightPct,
    setScheduleHeightPct,
    sidebarWidthPx,
    setSidebarWidthPx,
    leftCollapsed,
    toggleLeftCollapsed,
    rightCollapsed,
    toggleRightCollapsed,
    resetLayout,
    hydrated,
  } = useDashboardLayoutPrefs(workspaceId, userId);
  return React.createElement(
    "div",
    null,
    React.createElement("div", { "data-testid": "scheduleHeightPct" }, String(scheduleHeightPct)),
    React.createElement("div", { "data-testid": "sidebarWidthPx" }, String(sidebarWidthPx)),
    React.createElement("div", { "data-testid": "leftCollapsed" }, String(leftCollapsed)),
    React.createElement("div", { "data-testid": "rightCollapsed" }, String(rightCollapsed)),
    React.createElement("div", { "data-testid": "hydrated" }, String(hydrated)),
    React.createElement("button", { onClick: () => setScheduleHeightPct((p: number) => p + 10) }, "grow-schedule"),
    React.createElement("button", { onClick: () => setScheduleHeightPct((p: number) => p - 50) }, "shrink-schedule"),
    React.createElement("button", { onClick: () => setScheduleHeightPct(999) }, "schedule-999"),
    React.createElement("button", { onClick: () => setSidebarWidthPx((p: number) => p + 50) }, "grow-sidebar"),
    React.createElement("button", { onClick: () => setSidebarWidthPx((p: number) => p - 1000) }, "shrink-sidebar"),
    React.createElement("button", { onClick: () => setSidebarWidthPx(999999) }, "sidebar-max-999999"),
    React.createElement("button", { onClick: toggleLeftCollapsed }, "toggle-left"),
    React.createElement("button", { onClick: toggleRightCollapsed }, "toggle-right"),
    React.createElement("button", { onClick: resetLayout }, "reset")
  );
}

function readPct() {
  return Number(screen.getByTestId("scheduleHeightPct").textContent);
}
function readWidth() {
  return Number(screen.getByTestId("sidebarWidthPx").textContent);
}
function readLeftCollapsed() {
  return screen.getByTestId("leftCollapsed").textContent === "true";
}
function readRightCollapsed() {
  return screen.getByTestId("rightCollapsed").textContent === "true";
}

describe("useDashboardLayoutPrefs: pure clamp helpers", () => {
  test("clampScheduleHeightPct clamps to [MIN_SCHEDULE_HEIGHT_PCT, MAX_SCHEDULE_HEIGHT_PCT] and falls back to the default for non-finite input", () => {
    assert.equal(clampScheduleHeightPct(10), MIN_SCHEDULE_HEIGHT_PCT);
    assert.equal(clampScheduleHeightPct(999), MAX_SCHEDULE_HEIGHT_PCT);
    assert.equal(clampScheduleHeightPct(60), 60);
    assert.equal(clampScheduleHeightPct(NaN), DEFAULT_SCHEDULE_HEIGHT_PCT);
    assert.equal(clampScheduleHeightPct(Infinity), MAX_SCHEDULE_HEIGHT_PCT);
  });

  test("clampSidebarWidthPx clamps to [MIN_SIDEBAR_WIDTH_PX, maxAllowedPx] and falls back to the default for non-finite input", () => {
    assert.equal(clampSidebarWidthPx(10), MIN_SIDEBAR_WIDTH_PX);
    assert.equal(clampSidebarWidthPx(999999), MAX_SIDEBAR_WIDTH_PX);
    assert.equal(clampSidebarWidthPx(400), 400);
    assert.equal(clampSidebarWidthPx(NaN), DEFAULT_SIDEBAR_WIDTH_PX);
    assert.equal(clampSidebarWidthPx(500, 350), 350, "a narrower viewport-derived max overrides the nominal MAX_SIDEBAR_WIDTH_PX");
  });

  test("maxSidebarWidthForViewport leaves room for the left bar and a minimum main-content width, but never drops below MIN_SIDEBAR_WIDTH_PX", () => {
    assert.equal(maxSidebarWidthForViewport(1600, LEFT_BAR_WIDTH_PX), MAX_SIDEBAR_WIDTH_PX, "a wide viewport is capped by the nominal max, not left unbounded");
    assert.equal(maxSidebarWidthForViewport(700, LEFT_BAR_WIDTH_PX), MIN_SIDEBAR_WIDTH_PX, "a narrow viewport floors at the minimum rather than going negative/unusable");
  });
});

describe("useDashboardLayoutPrefs: defaults and hydration", () => {
  test("starts at the documented defaults and reports hydrated after mount", async () => {
    render(React.createElement(Host, { workspaceId: "ws-defaults" }));
    assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT);
    assert.equal(readWidth(), DEFAULT_SIDEBAR_WIDTH_PX);
    await act(async () => {});
    assert.equal(screen.getByTestId("hydrated").textContent, "true");
  });
});

describe("useDashboardLayoutPrefs: setter clamping", () => {
  test("setScheduleHeightPct clamps grows and shrinks to the documented bounds", async () => {
    render(React.createElement(Host, { workspaceId: "ws-clamp-schedule" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("grow-schedule"));
    assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT + 10);
    await user.click(screen.getByText("schedule-999"));
    assert.equal(readPct(), MAX_SCHEDULE_HEIGHT_PCT);
    await user.click(screen.getByText("shrink-schedule"));
    assert.equal(readPct(), MIN_SCHEDULE_HEIGHT_PCT, "shrinking past the floor from MAX clamps at MIN, never goes lower");
  });

  test("setSidebarWidthPx clamps grows and shrinks to the documented bounds", async () => {
    setInnerWidth(1600); // wide enough that the nominal MAX_SIDEBAR_WIDTH_PX is reachable
    render(React.createElement(Host, { workspaceId: "ws-clamp-sidebar" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("sidebar-max-999999"));
    assert.equal(readWidth(), MAX_SIDEBAR_WIDTH_PX);
    await user.click(screen.getByText("shrink-sidebar"));
    assert.equal(readWidth(), MIN_SIDEBAR_WIDTH_PX);
  });

  test("setSidebarWidthPx further clamps against a narrow current viewport, even below the nominal MAX_SIDEBAR_WIDTH_PX", async () => {
    setInnerWidth(760);
    render(React.createElement(Host, { workspaceId: "ws-viewport-clamp" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("sidebar-max-999999"));
    assert.equal(readWidth(), maxSidebarWidthForViewport(760, LEFT_BAR_WIDTH_PX));
  });
});

describe("useDashboardLayoutPrefs: persistence, scoping, and reset", () => {
  test("persists all four values to localStorage, scoped by userId AND workspaceId", async () => {
    setInnerWidth(1600); // wide enough that growing the sidebar by 50px isn't itself viewport-clamped
    render(React.createElement(Host, { workspaceId: "ws-persist" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("grow-schedule"));
    await user.click(screen.getByText("grow-sidebar"));
    await user.click(screen.getByText("toggle-left"));
    const raw = window.localStorage.getItem(`sft_dashboard_layout_v2_${USER}_ws-persist`);
    assert.ok(raw, "a value was written for this (user, workspace) pair's key");
    const parsed = JSON.parse(raw!);
    assert.equal(parsed.scheduleHeightPct, DEFAULT_SCHEDULE_HEIGHT_PCT + 10);
    assert.equal(parsed.sidebarWidthPx, DEFAULT_SIDEBAR_WIDTH_PX + 50);
    assert.equal(parsed.leftCollapsed, true);
    assert.equal(parsed.rightCollapsed, false);
  });

  test("a later mount for the same workspace restores the saved sizes", async () => {
    render(React.createElement(Host, { workspaceId: "ws-restore" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("grow-schedule"));
    cleanup();
    render(React.createElement(Host, { workspaceId: "ws-restore" }));
    assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT + 10);
  });

  test("two different workspaceIds never share or leak each other's saved layout", async () => {
    render(React.createElement(Host, { workspaceId: "ws-A" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("schedule-999")); // ws-A -> MAX
    cleanup();

    render(React.createElement(Host, { workspaceId: "ws-B" }));
    assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT, "ws-B sees its own default, not ws-A's saved MAX");

    cleanup();
    render(React.createElement(Host, { workspaceId: "ws-A" }));
    assert.equal(readPct(), MAX_SCHEDULE_HEIGHT_PCT, "ws-A's own saved value is still intact");
  });

  test("resetLayout restores default sizes AND expands both sidebars, and clears the stored preference", async () => {
    render(React.createElement(Host, { workspaceId: "ws-reset" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("grow-schedule"));
    await user.click(screen.getByText("grow-sidebar"));
    await user.click(screen.getByText("toggle-left"));
    await user.click(screen.getByText("toggle-right"));
    assert.equal(readLeftCollapsed(), true);
    assert.equal(readRightCollapsed(), true);
    await user.click(screen.getByText("reset"));
    assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT);
    assert.equal(readWidth(), DEFAULT_SIDEBAR_WIDTH_PX);
    assert.equal(readLeftCollapsed(), false, "reset expands the left sidebar");
    assert.equal(readRightCollapsed(), false, "reset expands the right sidebar");
  });

  test("corrupted JSON in storage is treated as absent, not thrown", async () => {
    window.localStorage.setItem(`sft_dashboard_layout_v2_${USER}_ws-corrupt`, "{not valid json");
    render(React.createElement(Host, { workspaceId: "ws-corrupt" }));
    await act(async () => {});
    assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT);
    assert.equal(readWidth(), DEFAULT_SIDEBAR_WIDTH_PX);
    assert.equal(readLeftCollapsed(), false);
    assert.equal(readRightCollapsed(), false);
  });

  test("an out-of-range stored value is clamped back into bounds on load, not trusted verbatim; a non-boolean collapse flag falls back to expanded", async () => {
    setInnerWidth(1600); // isolates "is the stored value trusted" from the separate viewport-clamp behavior
    window.localStorage.setItem(
      `sft_dashboard_layout_v2_${USER}_ws-outofrange`,
      JSON.stringify({ scheduleHeightPct: 5, sidebarWidthPx: 50000, leftCollapsed: "yes", rightCollapsed: 1 })
    );
    render(React.createElement(Host, { workspaceId: "ws-outofrange" }));
    await act(async () => {});
    assert.equal(readPct(), MIN_SCHEDULE_HEIGHT_PCT);
    assert.equal(readWidth(), MAX_SIDEBAR_WIDTH_PX);
    assert.equal(readLeftCollapsed(), false, "a string isn't a valid collapse flag -- falls back to expanded, not truthy-coerced");
    assert.equal(readRightCollapsed(), false, "a number isn't a valid collapse flag either");
  });

  test("an unavailable localStorage (throws on every access) never crashes the hook and the layout still works in-memory", async () => {
    const realGetItem = window.localStorage.getItem.bind(window.localStorage);
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.getItem = () => { throw new Error("storage disabled"); };
    window.localStorage.setItem = () => { throw new Error("storage disabled"); };
    try {
      render(React.createElement(Host, { workspaceId: "ws-unavailable" }));
      await act(async () => {});
      assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT);
      const user = userEvent.setup();
      await user.click(screen.getByText("grow-schedule"));
      assert.equal(readPct(), DEFAULT_SCHEDULE_HEIGHT_PCT + 10, "in-memory state still updates even though persistence silently fails");
    } finally {
      window.localStorage.getItem = realGetItem;
      window.localStorage.setItem = realSetItem;
    }
  });
});

describe("useDashboardLayoutPrefs: independent sidebar collapse state", () => {
  test("toggleLeftCollapsed and toggleRightCollapsed each flip only their own flag", async () => {
    render(React.createElement(Host, { workspaceId: "ws-toggle" }));
    assert.equal(readLeftCollapsed(), false);
    assert.equal(readRightCollapsed(), false);
    const user = userEvent.setup();
    await user.click(screen.getByText("toggle-left"));
    assert.equal(readLeftCollapsed(), true);
    assert.equal(readRightCollapsed(), false, "toggling left never touches right");
    await user.click(screen.getByText("toggle-right"));
    assert.equal(readLeftCollapsed(), true);
    assert.equal(readRightCollapsed(), true);
    await user.click(screen.getByText("toggle-left"));
    assert.equal(readLeftCollapsed(), false);
    assert.equal(readRightCollapsed(), true, "expanding left never touches right, which stays collapsed");
  });

  test("collapsing and re-expanding the right sidebar restores its exact previous width, including a resized width, not the default", async () => {
    setInnerWidth(1600);
    render(React.createElement(Host, { workspaceId: "ws-restore-width" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("grow-sidebar"));
    const resizedWidth = readWidth();
    assert.notEqual(resizedWidth, DEFAULT_SIDEBAR_WIDTH_PX, "sanity check: the resize actually changed the width");
    await user.click(screen.getByText("toggle-right"));
    assert.equal(readRightCollapsed(), true);
    await user.click(screen.getByText("toggle-right"));
    assert.equal(readRightCollapsed(), false);
    assert.equal(readWidth(), resizedWidth, "expanding restores the exact pre-collapse resized width, not DEFAULT_SIDEBAR_WIDTH_PX");
  });

  test("collapse states persist to localStorage and restore on a later mount for the same (user, workspace) pair", async () => {
    render(React.createElement(Host, { workspaceId: "ws-collapse-persist" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("toggle-left"));
    cleanup();
    render(React.createElement(Host, { workspaceId: "ws-collapse-persist" }));
    assert.equal(readLeftCollapsed(), true);
    assert.equal(readRightCollapsed(), false);
  });

  test("collapse state is scoped by userId, not just workspaceId -- two different people in the same workspace never share it", async () => {
    render(React.createElement(Host, { workspaceId: "ws-shared", userId: "owner-A" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("toggle-left"));
    assert.equal(readLeftCollapsed(), true);
    cleanup();

    render(React.createElement(Host, { workspaceId: "ws-shared", userId: "owner-B" }));
    assert.equal(readLeftCollapsed(), false, "a different person in the same workspace sees their own (expanded) default, not owner-A's collapsed state");

    cleanup();
    render(React.createElement(Host, { workspaceId: "ws-shared", userId: "owner-A" }));
    assert.equal(readLeftCollapsed(), true, "owner-A's own saved collapse state is still intact");
  });

  test("collapse state is also scoped by workspaceId, not just userId -- the same person in two different workspaces never shares it", async () => {
    render(React.createElement(Host, { workspaceId: "ws-1", userId: "owner-X" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("toggle-right"));
    assert.equal(readRightCollapsed(), true);
    cleanup();

    render(React.createElement(Host, { workspaceId: "ws-2", userId: "owner-X" }));
    assert.equal(readRightCollapsed(), false, "the same person's layout in a different workspace starts at its own (expanded) default");
  });
});

describe("useDashboardLayoutPrefs: responsive window resize", () => {
  test("widening the window after mount does not change a sidebar width that was already within bounds", async () => {
    render(React.createElement(Host, { workspaceId: "ws-resize-noop" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("grow-sidebar"));
    const before = readWidth();
    setInnerWidth(1800);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    assert.equal(readWidth(), before);
  });

  test("narrowing the window after mount reclamps an existing sidebar width down to what now fits", async () => {
    setInnerWidth(1600); // wide enough that the nominal MAX_SIDEBAR_WIDTH_PX is reachable before narrowing
    render(React.createElement(Host, { workspaceId: "ws-resize-shrink" }));
    const user = userEvent.setup();
    await user.click(screen.getByText("sidebar-max-999999")); // push to MAX_SIDEBAR_WIDTH_PX first
    assert.equal(readWidth(), MAX_SIDEBAR_WIDTH_PX);
    setInnerWidth(760);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    assert.equal(readWidth(), maxSidebarWidthForViewport(760, LEFT_BAR_WIDTH_PX));
  });
});
