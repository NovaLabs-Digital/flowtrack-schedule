// RENDERED behavior tests for DemoBannerControls.tsx, same stack as
// DemoControlsPanel.test.ts (jsdom + @testing-library/react + tsx-load-hook).
// DemoControlsPanel itself is reused unmodified inside the popover, so only
// the popover's own open/close mechanics (trigger, outside-click, Escape)
// and that it correctly wires DemoControlsPanel's onBack to "close" are
// tested here -- DemoControlsPanel's own stats/Restart/Reset behavior is
// already covered by its own test file.
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

const { default: DemoBannerControls } = await import("./DemoBannerControls.tsx");
const { DemoExperienceProvider } = await import("../demo-experience/DemoExperienceProvider.tsx");

function renderBanner() {
  return render(
    React.createElement(
      "div",
      null,
      React.createElement(DemoExperienceProvider, null, React.createElement(DemoBannerControls)),
      React.createElement("button", { type: "button" }, "outside")
    )
  );
}

afterEach(() => {
  cleanup();
  restartCalls = 0;
  resetCalls = 0;
});

describe("DemoBannerControls: popover trigger", () => {
  test("closed by default -- only the trigger button is present", () => {
    renderBanner();
    assert.ok(screen.getByRole("button", { name: "Demo Controls" }));
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
  });

  test("clicking the trigger opens the popover and shows DemoControlsPanel's content", async () => {
    renderBanner();
    await userEvent.setup().click(screen.getByRole("button", { name: "Demo Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Demo Controls" });
    assert.ok(dialog);
    assert.ok(screen.getByText("Sunshine Property Services"));
    assert.ok(screen.getByRole("button", { name: "Restart Experience" }));
    assert.ok(screen.getByRole("button", { name: "Reset Demo" }));
  });

  test("clicking the trigger again closes the popover", async () => {
    renderBanner();
    const u = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Demo Controls" });
    await u.click(trigger);
    assert.ok(screen.getByRole("dialog", { name: "Demo Controls" }));
    await u.click(trigger);
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
  });
});

describe("DemoBannerControls: outside interaction closes it without touching data", () => {
  test("a pointerdown outside the popover closes it", async () => {
    renderBanner();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Demo Controls" }));
    assert.ok(screen.getByRole("dialog", { name: "Demo Controls" }));
    await u.click(screen.getByRole("button", { name: "outside" }));
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
    assert.equal(resetCalls, 0);
    assert.equal(restartCalls, 0);
  });

  test("Escape closes the popover and returns focus to the trigger", async () => {
    renderBanner();
    const u = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Demo Controls" });
    await u.click(trigger);
    assert.ok(screen.getByRole("dialog", { name: "Demo Controls" }));
    await u.keyboard("{Escape}");
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
    assert.equal(document.activeElement, trigger);
  });
});

describe("DemoBannerControls: DemoControlsPanel's onBack closes the popover", () => {
  test("Restart Experience calls restart() and closes the popover", async () => {
    renderBanner();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Demo Controls" }));
    await u.click(screen.getByRole("button", { name: "Restart Experience" }));
    assert.equal(restartCalls, 1);
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
  });
});
