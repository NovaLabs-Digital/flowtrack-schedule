"use client";

// Labelled cursors for a Guided Demo Session. Your pointer is reported as a
// position inside the part of the screen it is over (the nearest element
// with a data-tour name -- the calendar, a dialog, the top bar...), as
// fractions of that element's size, so it lands in the same place on a
// differently sized window. It rides along on the once-a-second check-in;
// the other person's cursor glides between reports. The layer never takes
// clicks (pointer-events: none), and a cursor disappears when its owner
// disconnects or hasn't been seen for 5 seconds (the server stops sending it).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SessionCursor } from "@/lib/demoSession/client";

export const CURSOR_ROOT_ANCHOR = "shared-dashboard";
const ANCHOR_ATTR = "data-tour";

// The nearest named area around the pointer whose name is UNIQUE on the page
// (a name used by several elements, e.g. one per card, can't be found again
// reliably on the other screen), else the whole dashboard. Over the session
// chat (local to each browser, not part of the shared screen): none.
export function anchorFor(target: Element | null): HTMLElement | null {
  if (target?.closest("[data-session-chat]")) return null;
  for (let el = target?.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) ?? null; el; el = el.parentElement?.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) ?? null) {
    const name = el.getAttribute(ANCHOR_ATTR) ?? "";
    if (/^[a-z0-9-]{1,40}$/.test(name) && document.querySelectorAll(`[${ANCHOR_ATTR}="${name}"]`).length === 1) return el;
  }
  return document.querySelector<HTMLElement>(`[${ANCHOR_ATTR}="${CURSOR_ROOT_ANCHOR}"]`);
}

// Reports this participant's pointer (only when `active`).
export function useCursorReporter(active: boolean, report: (cursor: SessionCursor | null) => void) {
  const reportRef = useRef(report);
  useLayoutEffect(() => {
    reportRef.current = report;
  });
  useEffect(() => {
    if (!active) {
      reportRef.current(null);
      return;
    }
    const onMove = (e: PointerEvent) => {
      const el = anchorFor(document.elementFromPoint(e.clientX, e.clientY));
      if (!el) return reportRef.current(null);
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const clamp = (n: number) => Math.min(1, Math.max(0, n));
      reportRef.current({ anchor: el.getAttribute(ANCHOR_ATTR)!, x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) });
    };
    const onLeave = () => reportRef.current(null);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
    };
  }, [active]);
}

// Shows the other participant's cursor, if any.
export default function SharedCursor({ cursor, label, color }: { cursor: SessionCursor | null; label: string; color: string }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!cursor) return;
    const place = () => {
      const found = document.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTR}="${cursor.anchor}"]`);
      if (found.length !== 1) return setPos(null);
      const el = found[0];
      const r = el.getBoundingClientRect();
      setPos({ left: r.left + cursor.x * r.width, top: r.top + cursor.y * r.height });
    };
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [cursor]);
  if (!cursor || !pos) return null;
  return (
    <div
      aria-hidden="true"
      data-shared-cursor=""
      className="pointer-events-none fixed left-0 top-0 z-[90]"
      style={{ transform: `translate(${pos.left}px, ${pos.top}px)`, transition: "transform 900ms linear" }}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" className="drop-shadow" style={{ color }}>
        <path d="M2 1 L2 15 L6 11 L9 17 L11.5 16 L8.5 10 L14 10 Z" fill="currentColor" stroke="white" strokeWidth="1.2" />
      </svg>
      <span className="ml-3 -mt-1 inline-block whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium text-white shadow" style={{ backgroundColor: color }}>
        {label}
      </span>
    </div>
  );
}
