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

// ---------- session chat card (migration 046) ----------
// Kept in this file to stay under the Windows test-command length limit.
describe("session chat card: placement and separation", async () => {
  const { placeCard } = await import("./chatPlacement.ts");
  const { readFileSync } = await import("node:fs");
  const VIEW = { w: 1100, h: 780 };
  const CARD = { w: 320, h: 380 };
  const BAR = { x: 0, y: 0, w: 1100, h: 56 };

  test("the person's chosen place is kept when it covers nothing, and always stays inside the window", () => {
    assert.deepEqual(placeCard({ x: 400, y: 300 }, CARD, [BAR], VIEW), { x: 400, y: 300 });
    assert.deepEqual(placeCard({ x: 5000, y: -50 }, CARD, [], VIEW), { x: 1100 - 320 - 12, y: 12 });
  });

  test("never over the session controls", () => {
    const p = placeCard({ x: 400, y: 0 }, CARD, [BAR], VIEW)!;
    assert.ok(p.y >= BAR.y + BAR.h, JSON.stringify(p));
  });

  test("moves off an open dialog to a free corner", () => {
    const dialog = { x: 300, y: 60, w: 500, h: 660 };
    const p = placeCard({ x: 400, y: 200 }, CARD, [BAR, dialog], { w: 1440, h: 900 })!;
    const overlaps = !(p.x + CARD.w <= dialog.x || dialog.x + dialog.w <= p.x || p.y + CARD.h <= dialog.y || dialog.y + dialog.h <= p.y);
    assert.equal(overlaps, false, JSON.stringify(p));
  });

  test("no free corner for the full card: nothing returned (the card minimizes instead)", () => {
    const dialog = { x: 290, y: 40, w: 520, h: 720 };
    assert.equal(placeCard({ x: 16, y: 380 }, CARD, [BAR, dialog], VIEW), null);
    assert.ok(placeCard({ x: 12, y: 728 }, { w: 132, h: 40 }, [BAR, dialog], VIEW), "the small chat button still fits");
  });

  test("the chat is usable while watching and is never part of cursor tracking or the shared screen", () => {
    const watch = readFileSync(new URL("./WatchOnlyArea.tsx", import.meta.url), "utf8");
    assert.ok(watch.includes("[data-session-chat]"), "keys typed in the chat pass the watch-only guard");
    const page = readFileSync(new URL("../../demo/session/[id]/SessionClient.tsx", import.meta.url), "utf8");
    const rootEnd = page.indexOf("</EditBaseProvider>");
    assert.ok(page.indexOf("<SessionChat") > rootEnd, "rendered outside the cursor anchor and watch-only areas");
    const card = readFileSync(new URL("./SessionChat.tsx", import.meta.url), "utf8");
    assert.ok(!/useShared|dispatchView|setCursor|data-tour/.test(card), "no shared-screen, shared-field, or cursor hooks");
    assert.ok(card.includes("onKeyDown={keepKeys}") && card.includes("e.stopPropagation()"), "its keys never reach dashboard shortcuts");
    assert.ok(!card.includes("dangerouslySetInnerHTML"), "plain text only");
  });
});

describe("typing in the session chat while watching", () => {
  test("letters typed in the chat are not blocked; the same keys in the dashboard still are", () => {
    render(
      React.createElement(
        "div",
        null,
        React.createElement(WatchOnlyArea, { watchingMessage: MESSAGE }, React.createElement("button", null, "Add Appointment")),
        React.createElement("section", { "data-session-chat": "" }, React.createElement("textarea", { "aria-label": "Message" }))
      )
    );
    const box = screen.getByRole("textbox", { name: "Message" });
    for (const key of ["h", "i", " ", "Enter", "Backspace"]) {
      assert.equal(pressKey(box, { key }).cancelled, false, `chat key ${JSON.stringify(key)}`);
    }
    assert.equal(pressKey(screen.getByRole("button", { name: "Add Appointment" }), { key: "h" }).cancelled, true);
  });
});

describe("cursor tracking ignores the session chat", () => {
  test("a pointer over the chat reports no cursor (never the dashboard fallback); over the dashboard it still does", async () => {
    const { anchorFor, CURSOR_ROOT_ANCHOR } = await import("./SharedCursors.tsx");
    render(
      React.createElement(
        "div",
        null,
        React.createElement("div", { "data-tour": CURSOR_ROOT_ANCHOR }, React.createElement("button", null, "Add Appointment")),
        React.createElement("section", { "data-session-chat": "" }, React.createElement("textarea", { "aria-label": "Message" }))
      )
    );
    assert.equal(anchorFor(screen.getByRole("textbox", { name: "Message" })), null);
    assert.equal(anchorFor(screen.getByRole("button", { name: "Add Appointment" }))?.getAttribute("data-tour"), CURSOR_ROOT_ANCHOR);
  });
});

describe("session chat card with browser storage failing", () => {
  test("renders, sends, and never stores messages or drafts -- even when every storage call throws", async () => {
    const { default: SessionChat } = await import("./SessionChat.tsx");
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    const boom = () => { throw new Error("storage blocked"); };
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 } });
    const sent: string[] = [];
    try {
      render(
        React.createElement(SessionChat, {
          role: "visitor",
          chat: { available: true, messages: [{ id: 1, role: "host", name: "Alberto", body: "Hello Dana", at: "2026-11-01T12:00:00Z", clientId: "c1" }], outgoing: [] },
          ended: false,
          onSend: (t: string) => { sent.push(t); return true; },
          onRetry: () => {},
          onDiscard: () => null,
        })
      );
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(screen.getByText("Hello Dana"), "messages shown");
      const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      const { fireEvent } = await import("@testing-library/react");
      fireEvent.change(box, { target: { value: "Hi Alberto" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      assert.deepEqual(sent, ["Hi Alberto"]);
      assert.equal(box.value, "", "draft cleared after a successful send");
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
      else delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });
});
