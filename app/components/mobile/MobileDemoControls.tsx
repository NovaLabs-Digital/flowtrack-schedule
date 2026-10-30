"use client";

// Mobile counterpart to DemoBannerControls.tsx (desktop): same "Demo
// Controls" trigger living inside the amber Demo Mode banner, same
// underlying DemoControlsPanel reused completely unmodified for Restart
// Experience/Reset Demo -- only the surrounding chrome differs, because
// mobile has no room for a floating popover. This instead follows this
// app's existing mobile overlay convention (see MobileClientDrawer.tsx: a
// fixed inset-0 backdrop that closes on tap, plus a sliding panel), anchored
// to the bottom edge as a slide-up sheet rather than the right edge, since
// DemoControlsPanel's content (three cards + two buttons) is taller than it
// is wide.
import { useState } from "react";
import DemoControlsPanel from "@/app/components/dashboard/DemoControlsPanel";

export default function MobileDemoControls() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-amber-950/20 bg-amber-300/70 px-2 py-0.5 text-[11px] font-semibold text-amber-950 active:bg-amber-200 transition-colors"
      >
        Demo Controls
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Demo Controls"
            className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-auto rounded-t-2xl bg-white p-4 text-left text-slate-900 font-normal shadow-xl safe-area-bottom"
          >
            {/* onBack here means "close the sheet," not "navigate away" --
                DemoControlsPanel's own Restart Experience already calls
                restart() then onBack(), which now simply collapses this
                sheet. */}
            <DemoControlsPanel onBack={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}
