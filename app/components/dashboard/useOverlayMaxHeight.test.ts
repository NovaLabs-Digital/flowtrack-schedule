// Real rendered-hook behavior tests for useOverlayMaxHeight.ts -- hooks
// can't be called outside a component, so a tiny host component exposes
// the computed value through a data attribute, same technique as
// useDashboardLayoutPrefs.test.ts.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { useOverlayMaxHeight } = await import("./useOverlayMaxHeight.ts");

afterEach(() => {
  cleanup();
});

function Host({ open, fallbackCapPx, anchorBottom }: { open: boolean; fallbackCapPx: number; anchorBottom: number }) {
  const anchorRef = React.useRef<HTMLDivElement | null>(null);
  // A callback ref (not a useEffect) so the stubbed getBoundingClientRect
  // is in place during the commit phase, BEFORE any effect runs -- the
  // hook's own effect (which calls getBoundingClientRect on mount) is set
  // up earlier in this component than a plain useEffect here would be, so
  // a useEffect-based stub would always run one render too late for the
  // very first computation.
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      anchorRef.current = el;
      if (el) {
        el.getBoundingClientRect = () =>
          ({ bottom: anchorBottom, top: 0, left: 0, right: 0, height: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      }
    },
    [anchorBottom]
  );
  const maxHeight = useOverlayMaxHeight(anchorRef, open, fallbackCapPx);
  return React.createElement("div", { ref: setRef, "data-max-height": maxHeight == null ? "null" : String(maxHeight) });
}

describe("useOverlayMaxHeight", () => {
  test("returns null while closed", () => {
    render(React.createElement(Host, { open: false, fallbackCapPx: 520, anchorBottom: 100 }));
    const el = document.querySelector("[data-max-height]")!;
    assert.equal(el.getAttribute("data-max-height"), "null");
  });

  test("when open, clamps to the fallback cap when there's abundant room below the anchor", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    try {
      render(React.createElement(Host, { open: true, fallbackCapPx: 520, anchorBottom: 100 }));
      const el = document.querySelector("[data-max-height]")!;
      // available = 1000 - 100 - 16 = 884, capped at the 520 fallback
      assert.equal(el.getAttribute("data-max-height"), "520");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  test("when the anchor sits low in a small viewport, clamps DOWN to the real available space, not the fallback cap", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    try {
      render(React.createElement(Host, { open: true, fallbackCapPx: 520, anchorBottom: 400 }));
      const el = document.querySelector("[data-max-height]")!;
      // available = 500 - 400 - 16 = 84, below the 160 minimum floor -> clamped up to 160
      assert.equal(el.getAttribute("data-max-height"), "160");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  test("a moderate available space between the floor and the fallback cap is used as-is", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    try {
      render(React.createElement(Host, { open: true, fallbackCapPx: 520, anchorBottom: 200 }));
      const el = document.querySelector("[data-max-height]")!;
      // available = 500 - 200 - 16 = 284
      assert.equal(el.getAttribute("data-max-height"), "284");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  test("recomputes on window resize while open", () => {
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    try {
      render(React.createElement(Host, { open: true, fallbackCapPx: 520, anchorBottom: 100 }));
      const el = document.querySelector("[data-max-height]")!;
      assert.equal(el.getAttribute("data-max-height"), "520");

      act(() => {
        Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
        window.dispatchEvent(new Event("resize"));
      });
      // available = 300 - 100 - 16 = 184
      assert.equal(el.getAttribute("data-max-height"), "184");
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
    }
  });

  test("resets to null when closed again", () => {
    const { rerender } = render(React.createElement(Host, { open: true, fallbackCapPx: 520, anchorBottom: 100 }));
    const el = document.querySelector("[data-max-height]")!;
    assert.notEqual(el.getAttribute("data-max-height"), "null");
    rerender(React.createElement(Host, { open: false, fallbackCapPx: 520, anchorBottom: 100 }));
    assert.equal(el.getAttribute("data-max-height"), "null");
  });
});
