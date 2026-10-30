// RENDERED behavior tests for MobileDemoControls.tsx, using the same jsdom +
// @testing-library/react + tsx-load-hook technique as
// DemoControlsPanel.test.ts/DemoBannerControls.test.ts (whose mock.module()
// setup for the demo experience hook and lib/demoLocal/store is reused here
// verbatim). DemoControlsPanel itself is reused completely unmodified inside
// the sheet, so only this component's own trigger/sheet open-close mechanics
// are tested here -- DemoControlsPanel's own stats/Restart/Reset behavior is
// already covered by its own test file, and is only re-exercised here to
// prove the sheet wires its onBack correctly.
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

const { default: MobileDemoControls } = await import("./MobileDemoControls.tsx");
const { DemoExperienceProvider } = await import("../demo-experience/DemoExperienceProvider.tsx");

function renderControls() {
  return render(
    React.createElement(
      "div",
      null,
      React.createElement(DemoExperienceProvider, null, React.createElement(MobileDemoControls)),
      React.createElement("button", { type: "button" }, "outside")
    )
  );
}

afterEach(() => {
  cleanup();
  restartCalls = 0;
  resetCalls = 0;
});

describe("MobileDemoControls: sheet trigger", () => {
  test("closed by default -- only the trigger button is present", () => {
    renderControls();
    assert.ok(screen.getByRole("button", { name: "Demo Controls" }));
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
  });

  test("tapping the trigger opens the sheet and shows DemoControlsPanel's content", async () => {
    renderControls();
    await userEvent.setup().click(screen.getByRole("button", { name: "Demo Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Demo Controls" });
    assert.ok(dialog);
    assert.ok(screen.getByText("Sunshine Property Services"));
    assert.ok(screen.getByRole("button", { name: "Restart Experience" }));
    assert.ok(screen.getByRole("button", { name: "Reset Demo" }));
  });
});

describe("MobileDemoControls: backdrop tap closes the sheet without touching data", () => {
  test("tapping the backdrop closes the sheet", async () => {
    renderControls();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Demo Controls" }));
    const dialog = screen.getByRole("dialog", { name: "Demo Controls" });
    assert.ok(dialog);
    // The backdrop is the dialog's previous sibling inside the fixed overlay.
    const backdrop = dialog.previousElementSibling as HTMLElement;
    assert.ok(backdrop);
    await u.click(backdrop);
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
    assert.equal(resetCalls, 0);
    assert.equal(restartCalls, 0);
  });
});

describe("MobileDemoControls: DemoControlsPanel's onBack closes the sheet", () => {
  test("Restart Experience calls restart() and closes the sheet", async () => {
    renderControls();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Demo Controls" }));
    await u.click(screen.getByRole("button", { name: "Restart Experience" }));
    assert.equal(restartCalls, 1);
    assert.equal(screen.queryByRole("dialog", { name: "Demo Controls" }), null);
  });
});

describe("MobileDemoControls: Reset Demo two-step confirmation (DemoControlsPanel logic, reused unmodified)", () => {
  test("first tap only shows the confirmation -- nothing is reset yet", async () => {
    renderControls();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Demo Controls" }));
    await u.click(screen.getByRole("button", { name: "Reset Demo" }));
    assert.ok(screen.getByText("This will erase all current demo data and start over. This can't be undone."));
    assert.ok(screen.getByRole("button", { name: "Reset Demo Data" }));
    assert.ok(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(resetCalls, 0);
  });

  test("Cancel collapses back to the single Reset Demo button without touching data, and the sheet stays open", async () => {
    renderControls();
    const u = userEvent.setup();
    await u.click(screen.getByRole("button", { name: "Demo Controls" }));
    await u.click(screen.getByRole("button", { name: "Reset Demo" }));
    await u.click(screen.getByRole("button", { name: "Cancel" }));
    assert.equal(resetCalls, 0);
    assert.ok(screen.getByRole("button", { name: "Reset Demo" }));
    assert.ok(screen.getByRole("dialog", { name: "Demo Controls" }));
  });
});
