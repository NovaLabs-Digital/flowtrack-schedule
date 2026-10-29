"use client";

// Compact popover living in the Demo Mode banner (DashboardShell), not a
// Settings destination -- the owner's explicit requirement is that Reset
// Demo/Restart Tour sit in a "discreet location without replacing the
// normal navigation," so Settings itself stays the real production
// SettingsTabBar/SettingsPanel (see DashboardSettingsArea.tsx's isLocalDemo
// branch). Same anchored-popover pattern as NeedsAttentionControl.tsx:
// useRef root/trigger, pointerdown-outside-closes, Escape-closes-and-
// refocuses. DemoControlsPanel itself is reused completely unmodified --
// its "max-w-xl" is a ceiling, not a forced width, so it renders correctly
// inside this narrower popover.
import { useEffect, useRef, useState } from "react";
import DemoControlsPanel from "@/app/components/dashboard/DemoControlsPanel";

export default function DemoBannerControls() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeAndReturnFocus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function closeAndReturnFocus() {
    setOpen(false);
    buttonRef.current?.focus();
  }

  return (
    <div ref={rootRef} className="absolute right-3 top-1/2 -translate-y-1/2">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="rounded-md border border-amber-950/20 bg-amber-300/70 px-2 py-0.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-200 transition-colors"
      >
        Demo Controls
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Demo Controls"
          className="absolute right-0 top-full mt-1 z-50 w-80 rounded-xl border border-slate-200 bg-white p-4 text-left text-slate-900 font-normal shadow-lg"
        >
          {/* onBack here means "close the popover," not "navigate away" --
              DemoControlsPanel's Restart Experience already calls restart()
              then onBack(), which now simply collapses this popover. */}
          <DemoControlsPanel onBack={closeAndReturnFocus} />
        </div>
      )}
    </div>
  );
}
