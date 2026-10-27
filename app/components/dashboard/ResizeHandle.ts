"use client";

// Dependency-free resizable-panel divider primitive -- no fetch, no
// session, no app state. Follows CapabilityGatedButton.ts's own
// convention for a small interaction primitive written as a plain .ts
// file with React.createElement (no JSX), so it needs no tsx transpile
// hook in tests and no new dependency.
import React, { useRef } from "react";

export const RESIZE_STEP_PX = 16;
export const RESIZE_BIG_STEP_PX = 64;

export type ResizeHandleOrientation = "horizontal" | "vertical";

export default function ResizeHandle({
  orientation,
  ariaLabel,
  valueNow,
  valueMin,
  valueMax,
  valueText,
  onDelta,
  onJumpToMin,
  onJumpToMax,
}: {
  // "horizontal": a horizontal bar whose drag axis is vertical (the
  // calendar/details split). "vertical": a vertical bar whose drag axis
  // is horizontal (the main-content/sidebar split).
  orientation: ResizeHandleOrientation;
  ariaLabel: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  valueText?: string;
  // Pointer drag and arrow-key nudges report incremental pixel movement
  // since the last event -- positive means "down" (horizontal) or
  // "right" (vertical). The caller owns the sign convention for how that
  // maps onto its own controlled value.
  onDelta: (deltaPx: number) => void;
  // Home / End jump directly to the represented value's own min/max
  // (standard separator/slider semantics), not a pixel delta -- the
  // caller already knows its own bounds.
  onJumpToMin: () => void;
  onJumpToMax: () => void;
}) {
  // Tracks the pointer's last known position while a drag is active, so
  // onDelta always receives incremental movement since the previous
  // event rather than total movement since pointerdown -- every caller
  // can apply deltas with simple addition regardless of how many
  // pointermove events fire.
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragOriginRef.current = { x: e.clientX, y: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Not critical -- dragging still works via document-level moves in
      // browsers where capture isn't available for this pointer type.
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const deltaPx = orientation === "horizontal" ? e.clientY - origin.y : e.clientX - origin.x;
    dragOriginRef.current = { x: e.clientX, y: e.clientY };
    if (deltaPx !== 0) onDelta(deltaPx);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    dragOriginRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Already released (e.g. pointercancel) -- never worth surfacing.
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? RESIZE_BIG_STEP_PX : RESIZE_STEP_PX;
    const negativeKey = orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
    const positiveKey = orientation === "horizontal" ? "ArrowDown" : "ArrowRight";
    if (e.key === negativeKey) {
      e.preventDefault();
      onDelta(-step);
    } else if (e.key === positiveKey) {
      e.preventDefault();
      onDelta(step);
    } else if (e.key === "Home") {
      e.preventDefault();
      onJumpToMin();
    } else if (e.key === "End") {
      e.preventDefault();
      onJumpToMax();
    }
  }

  const sharedClasses =
    "group shrink-0 flex items-center justify-center bg-transparent hover:bg-slate-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-1 transition-colors touch-none";
  const orientationClasses =
    orientation === "horizontal" ? "w-full h-2.5 cursor-row-resize" : "h-full w-2.5 cursor-col-resize self-stretch";
  const gripClasses =
    orientation === "horizontal"
      ? "w-10 h-1 rounded-full bg-slate-300 group-hover:bg-slate-400 group-focus-visible:bg-slate-500"
      : "h-10 w-1 rounded-full bg-slate-300 group-hover:bg-slate-400 group-focus-visible:bg-slate-500";

  return React.createElement(
    "div",
    {
      role: "separator",
      "aria-orientation": orientation,
      "aria-label": ariaLabel,
      "aria-valuenow": Math.round(valueNow),
      "aria-valuemin": Math.round(valueMin),
      "aria-valuemax": Math.round(valueMax),
      "aria-valuetext": valueText,
      tabIndex: 0,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown: handleKeyDown,
      className: `${sharedClasses} ${orientationClasses}`,
    },
    React.createElement("span", { className: gripClasses, "aria-hidden": "true" })
  );
}
