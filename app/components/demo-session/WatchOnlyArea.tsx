"use client";

// Watch-only mode for a Guided Demo Session: while someone is watching, the
// whole demo dashboard stays visible but takes no input at all. Everything
// inside is `inert` (no clicks, focus, typing, dragging, or text selection,
// including open dialogs, which render inside this area), a still overlay
// absorbs wheel and touch scrolling, and page-wide key handlers (Escape,
// arrows, space) are stopped before they reach the dashboard. The session
// control bar sits outside this area and is marked SESSION_CONTROLS_ATTR,
// so Take Back Control, End Session, and Leave always work.
//
// This only blocks input. The watcher's screen does not follow the person in
// control: each participant still navigates independently (screen mirroring
// is milestone 3). The session server refuses changes from the watcher
// regardless of this layer.
import { useEffect, useRef } from "react";

export const SESSION_CONTROLS_ATTR = "data-session-controls";

type Props = {
  // The message to show while watching, or null when this person is in control.
  watchingMessage: string | null;
  children?: React.ReactNode;
};

// Keys that still do something for a watcher: moving focus to the session
// bar, and browser shortcuts (reload, zoom, find, copy). The dashboard has
// no modifier-key shortcuts of its own.
function passesThrough(e: KeyboardEvent): boolean {
  if (e.key === "Tab") return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  return /^F\d{1,2}$/.test(e.key);
}

export default function WatchOnlyArea({ watchingMessage, children }: Props) {
  const watching = watchingMessage !== null;
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!watching) return;
    const blockKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(`[${SESSION_CONTROLS_ATTR}]`) || passesThrough(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Capture phase on window runs before every dashboard listener.
    window.addEventListener("keydown", blockKey, true);
    window.addEventListener("keyup", blockKey, true);
    window.addEventListener("keypress", blockKey, true);
    // React's wheel/touch handlers are passive; scrolling needs a real
    // non-passive listener to be cancelled.
    const overlay = overlayRef.current;
    const stop = (e: Event) => e.preventDefault();
    overlay?.addEventListener("wheel", stop, { passive: false });
    overlay?.addEventListener("touchmove", stop, { passive: false });
    return () => {
      window.removeEventListener("keydown", blockKey, true);
      window.removeEventListener("keyup", blockKey, true);
      window.removeEventListener("keypress", blockKey, true);
      overlay?.removeEventListener("wheel", stop);
      overlay?.removeEventListener("touchmove", stop);
    };
  }, [watching]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div inert={watching} className="flex-1 min-h-0 flex flex-col">
        {children}
      </div>
      {watching && (
        <div
          ref={overlayRef}
          data-watch-only-overlay=""
          className="absolute inset-0 z-[70] cursor-not-allowed select-none touch-none"
        >
          <div
            role="status"
            className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg"
          >
            {watchingMessage}
          </div>
        </div>
      )}
    </div>
  );
}
