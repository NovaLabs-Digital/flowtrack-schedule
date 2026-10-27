// Real rendered-component behavior tests for ResizeHandle.ts, using the
// jsdom + @testing-library/react foundation already established by
// CapabilityGatedButton.test.ts. The primitive is dependency-free (no
// fetch, no session, no app state), so every scenario is driven purely by
// the props under test -- no mock.module() needed.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import "../../../lib/testDom.ts";

import React from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { default: ResizeHandle, RESIZE_STEP_PX, RESIZE_BIG_STEP_PX } = await import("./ResizeHandle.ts");

afterEach(() => {
  cleanup();
});

function renderHandle(overrides: Partial<Parameters<typeof ResizeHandle>[0]> = {}) {
  const deltas: number[] = [];
  let minCalls = 0;
  let maxCalls = 0;
  render(
    React.createElement(ResizeHandle, {
      orientation: "horizontal",
      ariaLabel: "Resize calendar and details panel",
      valueNow: 68,
      valueMin: 35,
      valueMax: 82,
      valueText: "Calendar 68% of available height",
      onDelta: (d: number) => deltas.push(d),
      onJumpToMin: () => { minCalls++; },
      onJumpToMax: () => { maxCalls++; },
      ...overrides,
    })
  );
  const handle = screen.getByRole("separator", { name: overrides.ariaLabel ?? "Resize calendar and details panel" });
  return { handle, deltas, getMinCalls: () => minCalls, getMaxCalls: () => maxCalls };
}

describe("ResizeHandle: ARIA separator semantics", () => {
  test("exposes role=separator with orientation and value attributes", () => {
    const { handle } = renderHandle();
    assert.equal(handle.getAttribute("aria-orientation"), "horizontal");
    assert.equal(handle.getAttribute("aria-valuenow"), "68");
    assert.equal(handle.getAttribute("aria-valuemin"), "35");
    assert.equal(handle.getAttribute("aria-valuemax"), "82");
    assert.equal(handle.getAttribute("aria-valuetext"), "Calendar 68% of available height");
    assert.equal(handle.getAttribute("tabindex"), "0");
  });

  test("vertical orientation reports aria-orientation=vertical", () => {
    const { handle } = renderHandle({ orientation: "vertical", ariaLabel: "Resize main content and dispatch sidebar" });
    assert.equal(handle.getAttribute("aria-orientation"), "vertical");
  });
});

describe("ResizeHandle: pointer dragging", () => {
  test("horizontal: dragging down reports a positive delta equal to the pixel movement", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 140, pointerId: 1 });
    assert.deepEqual(deltas, [40]);
  });

  test("horizontal: dragging up reports a negative delta", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 70, pointerId: 1 });
    assert.deepEqual(deltas, [-30]);
  });

  test("vertical: dragging right reports a positive delta; dragging left reports a negative delta", () => {
    const { handle, deltas } = renderHandle({ orientation: "vertical", ariaLabel: "Resize main content and dispatch sidebar" });
    fireEvent.pointerDown(handle, { clientX: 200, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 225, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 205, clientY: 0, pointerId: 1 });
    assert.deepEqual(deltas, [25, -20]);
  });

  test("reports incremental movement since the previous event, not total movement since pointerdown", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 25, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 15, pointerId: 1 });
    assert.deepEqual(deltas, [10, 15, -10]);
  });

  test("pointermove before any pointerdown is ignored (no stray drag state)", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 999, pointerId: 1 });
    assert.deepEqual(deltas, []);
  });

  test("movement after pointerup is ignored (drag has ended)", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 500, pointerId: 1 });
    assert.deepEqual(deltas, [10]);
  });

  test("movement after pointercancel is ignored, matching pointerup", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 500, pointerId: 1 });
    assert.deepEqual(deltas, [10]);
  });

  test("a zero-movement pointermove does not call onDelta", () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    fireEvent.pointerDown(handle, { clientX: 0, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 0, clientY: 50, pointerId: 1 });
    assert.deepEqual(deltas, []);
  });
});

describe("ResizeHandle: keyboard resizing", () => {
  test("horizontal: ArrowDown nudges by +RESIZE_STEP_PX, ArrowUp by -RESIZE_STEP_PX", async () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowUp}");
    assert.deepEqual(deltas, [RESIZE_STEP_PX, -RESIZE_STEP_PX]);
  });

  test("vertical: ArrowRight nudges by +RESIZE_STEP_PX, ArrowLeft by -RESIZE_STEP_PX", async () => {
    const { handle, deltas } = renderHandle({ orientation: "vertical", ariaLabel: "Resize main content and dispatch sidebar" });
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{ArrowLeft}");
    assert.deepEqual(deltas, [RESIZE_STEP_PX, -RESIZE_STEP_PX]);
  });

  test("Shift+Arrow nudges by the larger RESIZE_BIG_STEP_PX step", async () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    assert.deepEqual(deltas, [RESIZE_BIG_STEP_PX]);
  });

  test("the orthogonal arrow keys are ignored (ArrowLeft/ArrowRight do nothing for a horizontal handle)", async () => {
    const { handle, deltas } = renderHandle({ orientation: "horizontal" });
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    assert.deepEqual(deltas, []);
  });

  test("Home calls onJumpToMin; End calls onJumpToMax (standard separator semantics, independent of orientation)", async () => {
    const { handle, getMinCalls, getMaxCalls } = renderHandle({ orientation: "horizontal" });
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{Home}");
    assert.equal(getMinCalls(), 1);
    assert.equal(getMaxCalls(), 0);
    await user.keyboard("{End}");
    assert.equal(getMinCalls(), 1);
    assert.equal(getMaxCalls(), 1);
  });
});

describe("ResizeHandle: focus and discoverability", () => {
  test("is reachable by Tab and shows a visible grip", () => {
    const { handle } = renderHandle();
    assert.equal(handle.getAttribute("tabindex"), "0");
    assert.ok(handle.querySelector('[aria-hidden="true"]'), "renders a decorative grip element");
  });

  test("horizontal handle uses a row-resize cursor; vertical handle uses a col-resize cursor", () => {
    const { handle: horizontal } = renderHandle({ orientation: "horizontal" });
    assert.ok(horizontal.className.includes("cursor-row-resize"));
    cleanup();
    const { handle: vertical } = renderHandle({ orientation: "vertical", ariaLabel: "Resize main content and dispatch sidebar" });
    assert.ok(vertical.className.includes("cursor-col-resize"));
  });
});
