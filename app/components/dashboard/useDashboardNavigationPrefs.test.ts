// Real rendered-hook behavior tests for useDashboardNavigationPrefs.ts,
// using the same jsdom + @testing-library/react host-component technique as
// useDashboardLayoutPrefs.test.ts (hooks can't be called outside a
// component).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import "../../../lib/testDom.ts";

import React from "react";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { useDashboardNavigationPrefs } = await import("./useDashboardNavigationPrefs.ts");

const USER = "user-1";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function storageKey(userId: string, workspaceId: string): string {
  return `sft_dashboard_nav_v1_${userId}_${workspaceId}`;
}

function Host({ workspaceId, userId = USER }: { workspaceId: string; userId?: string }) {
  const { centerMode, setCenterMode, settingsSection, setSettingsSection, hydrated } = useDashboardNavigationPrefs(workspaceId, userId);
  return React.createElement(
    "div",
    null,
    React.createElement("div", { "data-testid": "centerMode" }, centerMode),
    React.createElement("div", { "data-testid": "settingsSection" }, settingsSection),
    React.createElement("div", { "data-testid": "hydrated" }, String(hydrated)),
    React.createElement("button", { onClick: () => setCenterMode("settings") }, "open-settings"),
    React.createElement("button", { onClick: () => setCenterMode("schedule") }, "open-schedule"),
    React.createElement("button", { onClick: () => setSettingsSection("billing") }, "select-billing"),
    React.createElement("button", { onClick: () => setSettingsSection("company") }, "select-company")
  );
}

describe("useDashboardNavigationPrefs: defaults and hydration", () => {
  test("starts at the documented defaults (schedule/company) and reports hydrated after mount", async () => {
    render(React.createElement(Host, { workspaceId: "ws-defaults" }));
    assert.equal(screen.getByTestId("centerMode").textContent, "schedule");
    assert.equal(screen.getByTestId("settingsSection").textContent, "company");
    await act(async () => {});
    assert.equal(screen.getByTestId("hydrated").textContent, "true");
  });
});

describe("useDashboardNavigationPrefs: persistence across a remount (hard-refresh simulation)", () => {
  test("switching to Settings -> Billing persists, and a later mount for the SAME user+workspace restores it", async () => {
    const first = render(React.createElement(Host, { workspaceId: "ws-persist" }));
    const u = userEvent.setup();
    await u.click(screen.getByText("open-settings"));
    await u.click(screen.getByText("select-billing"));
    assert.equal(screen.getByTestId("centerMode").textContent, "settings");
    assert.equal(screen.getByTestId("settingsSection").textContent, "billing");
    first.unmount();

    render(React.createElement(Host, { workspaceId: "ws-persist" }));
    assert.equal(screen.getByTestId("centerMode").textContent, "settings", "a remount (e.g. a hard refresh) reopens Settings, not the dashboard calendar");
    assert.equal(screen.getByTestId("settingsSection").textContent, "billing");
  });

  test("returning to the schedule persists too, so a later refresh does not resurrect a stale Settings section", async () => {
    const first = render(React.createElement(Host, { workspaceId: "ws-return" }));
    const u = userEvent.setup();
    await u.click(screen.getByText("open-settings"));
    await u.click(screen.getByText("select-billing"));
    await u.click(screen.getByText("open-schedule"));
    first.unmount();

    render(React.createElement(Host, { workspaceId: "ws-return" }));
    assert.equal(screen.getByTestId("centerMode").textContent, "schedule");
  });
});

describe("useDashboardNavigationPrefs: per (user, workspace) isolation", () => {
  test("two different users in the same workspace never share this preference", async () => {
    const asOwnerA = render(React.createElement(Host, { workspaceId: "ws-shared", userId: "owner-A" }));
    const u = userEvent.setup();
    await u.click(screen.getByText("open-settings"));
    await u.click(screen.getByText("select-billing"));
    asOwnerA.unmount();

    render(React.createElement(Host, { workspaceId: "ws-shared", userId: "owner-B" }));
    assert.equal(screen.getByTestId("centerMode").textContent, "schedule", "a different owner in the same workspace sees their own default, not owner-A's saved navigation");
  });

  test("the same user in a different workspace never shares this preference", async () => {
    const inWorkspace1 = render(React.createElement(Host, { workspaceId: "ws-A" }));
    const u = userEvent.setup();
    await u.click(screen.getByText("open-settings"));
    await u.click(screen.getByText("select-billing"));
    inWorkspace1.unmount();

    render(React.createElement(Host, { workspaceId: "ws-B" }));
    assert.equal(screen.getByTestId("centerMode").textContent, "schedule");
  });
});

describe("useDashboardNavigationPrefs: invalid/missing storage falls back to defaults", () => {
  test("a corrupted stored value is ignored, falling back to schedule/company rather than throwing", async () => {
    window.localStorage.setItem(storageKey(USER, "ws-corrupt"), "not-valid-json{{{");
    render(React.createElement(Host, { workspaceId: "ws-corrupt" }));
    await act(async () => {});
    assert.equal(screen.getByTestId("centerMode").textContent, "schedule");
    assert.equal(screen.getByTestId("settingsSection").textContent, "company");
  });

  test("an invalid settingsSection value within an otherwise-valid object falls back to the default for that field only", async () => {
    window.localStorage.setItem(storageKey(USER, "ws-partial-invalid"), JSON.stringify({ centerMode: "settings", settingsSection: "not-a-real-section" }));
    render(React.createElement(Host, { workspaceId: "ws-partial-invalid" }));
    await act(async () => {});
    assert.equal(screen.getByTestId("centerMode").textContent, "settings");
    assert.equal(screen.getByTestId("settingsSection").textContent, "company");
  });

  test("an unavailable localStorage (throws on every access) never crashes the component, and in-memory navigation still works", async () => {
    const realGetItem = window.localStorage.getItem.bind(window.localStorage);
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.getItem = () => { throw new Error("storage disabled"); };
    window.localStorage.setItem = () => { throw new Error("storage disabled"); };
    try {
      render(React.createElement(Host, { workspaceId: "ws-unavailable" }));
      const u = userEvent.setup();
      await u.click(screen.getByText("open-settings"));
      await u.click(screen.getByText("select-billing"));
      assert.equal(screen.getByTestId("centerMode").textContent, "settings", "in-memory navigation still works even though persistence silently fails");
      assert.equal(screen.getByTestId("settingsSection").textContent, "billing");
    } finally {
      window.localStorage.getItem = realGetItem;
      window.localStorage.setItem = realSetItem;
    }
  });
});
