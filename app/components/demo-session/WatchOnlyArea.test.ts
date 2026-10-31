// WatchOnlyArea: Guided Demo Session watch-only mode, rendered for real
// (jsdom). jsdom does not implement what `inert` DOES (browsers make the
// subtree unclickable and unfocusable), so here the attribute itself is
// asserted; the browser behaviour is covered by the local two-browser E2E.
// The keyboard and scroll blocking is ordinary DOM code and is exercised
// directly.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);

const { default: WatchOnlyArea, SESSION_CONTROLS_ATTR } = await import("./WatchOnlyArea.tsx");

const MESSAGE = "You're watching. The host can give you control.";

afterEach(() => {
  cleanup();
});

// A stand-in session page: the bar outside the area, the dashboard inside.
function Page({ watchingMessage }: { watchingMessage: string | null }) {
  return React.createElement(
    "div",
    null,
    React.createElement("div", { [SESSION_CONTROLS_ATTR]: "" }, React.createElement("button", null, "Take Back Control")),
    React.createElement(WatchOnlyArea, { watchingMessage }, React.createElement("button", null, "Add Appointment"))
  );
}

// Fires a key event the way a browser does and reports whether a
// dashboard-level (document) listener saw it and whether it was cancelled.
function pressKey(target: Element, init: KeyboardEventInit) {
  let reachedDashboard = false;
  const listener = () => { reachedDashboard = true; };
  document.addEventListener("keydown", listener);
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  document.removeEventListener("keydown", listener);
  return { reachedDashboard, cancelled: event.defaultPrevented };
}

const dashboardWrapper = () => screen.getByRole("button", { name: "Add Appointment" }).parentElement!;

describe("WatchOnlyArea: in control", () => {
  test("the dashboard is interactive: not inert, no overlay, no message", () => {
    render(React.createElement(Page, { watchingMessage: null }));
    assert.equal(dashboardWrapper().hasAttribute("inert"), false);
    assert.equal(document.querySelector("[data-watch-only-overlay]"), null);
    assert.equal(screen.queryByRole("status"), null);
  });

  test("keys reach the dashboard and are not cancelled", () => {
    render(React.createElement(Page, { watchingMessage: null }));
    const r = pressKey(document.body, { key: "Escape" });
    assert.deepEqual(r, { reachedDashboard: true, cancelled: false });
  });
});

describe("WatchOnlyArea: watching", () => {
  test("the dashboard stays rendered but is inert, under an overlay with the watching message", () => {
    render(React.createElement(Page, { watchingMessage: MESSAGE }));
    assert.ok(screen.getByRole("button", { name: "Add Appointment" }), "the dashboard is still visible");
    assert.equal(dashboardWrapper().hasAttribute("inert"), true);
    assert.ok(document.querySelector("[data-watch-only-overlay]"));
    assert.equal(screen.getByRole("status").textContent, MESSAGE);
  });

  test("the session bar is outside the inert area", () => {
    render(React.createElement(Page, { watchingMessage: MESSAGE }));
    const bar = screen.getByRole("button", { name: "Take Back Control" });
    assert.equal(bar.closest("[inert]"), null);
  });

  for (const key of ["Escape", "ArrowLeft", "ArrowRight", " ", "Enter", "Delete", "a"]) {
    test(`page-wide key ${JSON.stringify(key)} is stopped before the dashboard and cancelled`, () => {
      render(React.createElement(Page, { watchingMessage: MESSAGE }));
      const r = pressKey(document.body, { key });
      assert.deepEqual(r, { reachedDashboard: false, cancelled: true });
    });
  }

  test("keys inside the session bar still work (Enter/Space on Take Back Control, End Session, Leave)", () => {
    render(React.createElement(Page, { watchingMessage: MESSAGE }));
    const bar = screen.getByRole("button", { name: "Take Back Control" });
    for (const key of ["Enter", " "]) {
      assert.deepEqual(pressKey(bar, { key }), { reachedDashboard: true, cancelled: false });
    }
  });

  test("Tab (to reach the session bar) and browser shortcuts pass through", () => {
    render(React.createElement(Page, { watchingMessage: MESSAGE }));
    assert.equal(pressKey(document.body, { key: "Tab" }).cancelled, false);
    assert.equal(pressKey(document.body, { key: "r", ctrlKey: true }).cancelled, false);
    assert.equal(pressKey(document.body, { key: "F5" }).cancelled, false);
  });

  test("wheel and touch scrolling over the dashboard are cancelled", () => {
    render(React.createElement(Page, { watchingMessage: MESSAGE }));
    const overlay = document.querySelector("[data-watch-only-overlay]")!;
    const wheel = new Event("wheel", { bubbles: true, cancelable: true });
    overlay.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, true);
    const touch = new Event("touchmove", { bubbles: true, cancelable: true });
    overlay.dispatchEvent(touch);
    assert.equal(touch.defaultPrevented, true);
  });
});

describe("WatchOnlyArea: control changes", () => {
  test("gaining control restores normal interaction at once; losing it blocks again", () => {
    const view = render(React.createElement(Page, { watchingMessage: MESSAGE }));
    assert.equal(dashboardWrapper().hasAttribute("inert"), true);

    view.rerender(React.createElement(Page, { watchingMessage: null }));
    assert.equal(dashboardWrapper().hasAttribute("inert"), false);
    assert.equal(document.querySelector("[data-watch-only-overlay]"), null);
    assert.deepEqual(pressKey(document.body, { key: "Escape" }), { reachedDashboard: true, cancelled: false });

    view.rerender(React.createElement(Page, { watchingMessage: MESSAGE }));
    assert.equal(dashboardWrapper().hasAttribute("inert"), true);
    assert.deepEqual(pressKey(document.body, { key: "Escape" }), { reachedDashboard: false, cancelled: true });
  });

  test("the dashboard keeps its state across control changes (same element, not remounted)", () => {
    const view = render(React.createElement(Page, { watchingMessage: null }));
    const before = screen.getByRole("button", { name: "Add Appointment" });
    view.rerender(React.createElement(Page, { watchingMessage: MESSAGE }));
    view.rerender(React.createElement(Page, { watchingMessage: null }));
    assert.equal(screen.getByRole("button", { name: "Add Appointment" }), before);
  });
});
