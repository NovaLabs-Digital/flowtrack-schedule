"use client";

// Keeps an anchored dropdown's max-height inside the ACTUAL visible
// viewport, not just a fixed vh percentage. A fixed "max-h-[65vh]" alone
// does not account for WHERE on the page the anchoring button sits --
// sidebar resizing/collapsing can move it, a smaller laptop viewport or
// browser zoom shrinks the effective space below it, and a button already
// most of the way down the screen leaves far less than 65% of the viewport
// actually available underneath it. This computes an upper bound measured
// from the anchor's own bottom edge to the real viewport bottom (minus a
// small margin), recomputed when the overlay opens and on window resize
// while it's open -- so NeedsAttentionControl/MobileNeedsAttentionControl
// stay inside the viewport at any sidebar width or zoom level, not just the
// ones tested at design time.
import { useEffect, useState, type RefObject } from "react";

const MIN_HEIGHT_PX = 160;
const VIEWPORT_MARGIN_PX = 16;

export function useOverlayMaxHeight(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  fallbackCapPx: number
): number | null {
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!open) {
      setMaxHeight(null);
      return;
    }
    function recompute() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const available = window.innerHeight - rect.bottom - VIEWPORT_MARGIN_PX;
      setMaxHeight(Math.max(MIN_HEIGHT_PX, Math.min(available, fallbackCapPx)));
    }
    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fallbackCapPx]);

  return maxHeight;
}
