// RENDERED behavior tests for DemoControlsPanel.tsx, using the same jsdom +
// @testing-library/react + tsx-load-hook technique as
// AppointmentModal.render.test.ts. The demo experience hook (behind the real
// DemoExperienceProvider) and the local demo store are replaced with mock.module() stand-ins (OwnerBillingBanner.
// test.ts's established pattern) so the test controls the data shown and can
// observe restart()/resetStore() calls directly.
import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);

let restartCalls = 0;
let resetCalls = 0;
const fakeSnapshot = {
  sessionInitIso: "2026-10-28T12:00:00.000Z",
  clients: Array.from({ length: 7 }, (_, i) => ({ id: `c${i}` })),
  employees: Array.from({ length: 2 }, (_, i) => ({ id: `e${i}` })),
  services: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` })),
  appointments: Array.from({ length: 41 }, (_, i) => ({ id: `a${i}` })),
  employeeHours: [],
  assignments: [],
  completedJobBilling: [],
  messagesSent: [],
};

// The real DemoExperienceProvider wraps the panel; only the hook it gets its
// value from is replaced (mock.module cannot stand in for a .tsx module
// under the tsx load hook).
mock.module("@/app/components/demo-experience/useDemoExperience", {
  namedExports: {
    useDemoExperience: () => ({
      restart: () => {
        restartCalls++;
      },
    }),
  },
});

mock.module("@/lib/demoLocal/store", {
  namedExports: {
    subscribe: () => () => {},
    getSnapshot: () => fakeSnapshot,
    resetStore: () => {
      resetCalls++;
      return fakeSnapshot;
    },
  },
});

const { default: DemoControlsPanel } = await import("./DemoControlsPanel.tsx");
const { DemoExperienceProvider } = await import("../demo-experience/DemoExperienceProvider.tsx");

let backCalls = 0;
let navigations: string[] = [];

function renderPanel() {
  return render(
    React.createElement(
      DemoExperienceProvider,
      null,
      React.createElement(DemoControlsPanel, {
        onBack: () => {
          backCalls++;
        },
        navigateTo: (url: string) => {
          navigations.push(url);
        },
      })
    )
  );
}

afterEach(() => {
  cleanup();
  restartCalls = 0;
  resetCalls = 0;
  backCalls = 0;
  navigations = [];
});

function statValue(label: string): string | null {
  return screen.getByText(label).previousElementSibling?.textContent ?? null;
}

describe("DemoControlsPanel: demo data stats", () => {
  test("shows the demo company and counts derived from the store snapshot (not the old hardcoded 20/3/6/38)", () => {
    renderPanel();
    assert.ok(screen.getByText("Sunshine Property Services"));
    assert.equal(statValue("Fictional Clients"), "7");
    assert.equal(statValue("Fictional Employees"), "2");
    assert.equal(statValue("Fictional Services"), "5");
    assert.equal(statValue("Fictional Appointments"), "41");
  });
});

describe("DemoControlsPanel: Restart Experience", () => {
  test("calls restart() and returns to the schedule", async () => {
    renderPanel();
    await userEvent.setup().click(screen.getByRole("button", { name: "Restart Experience" }));
    assert.equal(restartCalls, 1);
    assert.equal(backCalls, 1);
    assert.equal(resetCalls, 0);
  });
});

describe("DemoControlsPanel: Reset Demo two-step confirmation", () => {
  test("first click only shows the confirmation -- nothing is reset yet", async () => {
    renderPanel();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reset Demo" }));
    assert.ok(screen.getByText("This will erase all current demo data and start over. This can't be undone."));
    assert.ok(screen.getByRole("button", { name: "Reset Demo Data" }));
    assert.ok(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(resetCalls, 0);
    assert.deepEqual(navigations, []);
  });

  test("Confirm resets the store and fully reloads /demo", async () => {
    renderPanel();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Reset Demo" }));
    await u.click(screen.getByRole("button", { name: "Reset Demo Data" }));
    assert.equal(resetCalls, 1);
    assert.deepEqual(navigations, ["/demo"]);
  });

  test("Cancel collapses back to the single Reset Demo button without touching data", async () => {
    renderPanel();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Reset Demo" }));
    await u.click(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(resetCalls, 0);
    assert.deepEqual(navigations, []);
    assert.equal(screen.queryByText("This will erase all current demo data and start over. This can't be undone."), null);
    assert.ok(screen.getByRole("button", { name: "Reset Demo" }));
  });
});
