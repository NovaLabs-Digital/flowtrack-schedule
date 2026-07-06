"use client";

import { useEffect, useState } from "react";
import { useDemoExperienceContext } from "./DemoExperienceProvider";

const SPOTLIGHT_PADDING = 8;

export default function DemoExperienceOverlay() {
  const { active, currentStep, stepIndex, totalSteps, next, skip, restart } = useDemoExperienceContext();
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Measures the target element's position from the DOM (an external
  // system relative to React state) and keeps it in sync as the page
  // scrolls/resizes/reflows — the canonical use case the effect rule's own
  // guidance calls out as valid.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!active || !currentStep?.targetSelector) {
      setRect(null);
      return;
    }

    const selector = currentStep.targetSelector;

    function measure() {
      const el = document.querySelector(selector);
      setRect(el ? el.getBoundingClientRect() : null);
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Schedule/appointment layout can shift after data loads or a modal
    // closes without firing a resize/scroll event — a light poll keeps the
    // spotlight aligned without needing every component to notify us.
    const interval = window.setInterval(measure, 300);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(interval);
    };
  }, [active, currentStep]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!active || !currentStep) return null;

  const hasTarget = !!rect;
  const top = hasTarget ? rect!.top - SPOTLIGHT_PADDING : 0;
  const left = hasTarget ? rect!.left - SPOTLIGHT_PADDING : 0;
  const width = hasTarget ? rect!.width + SPOTLIGHT_PADDING * 2 : 0;
  const height = hasTarget ? rect!.height + SPOTLIGHT_PADDING * 2 : 0;

  const cardStyle: React.CSSProperties = hasTarget
    ? {
        top: Math.min(top + height + 16, window.innerHeight - 200),
        left: Math.min(Math.max(left, 16), window.innerWidth - 384),
      }
    : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <div className="fixed inset-0 z-[200]" role="dialog" aria-live="polite">
      {hasTarget ? (
        <>
          <div className="fixed bg-black/60" style={{ top: 0, left: 0, right: 0, height: Math.max(top, 0) }} />
          <div className="fixed bg-black/60" style={{ top: top + height, left: 0, right: 0, bottom: 0 }} />
          <div className="fixed bg-black/60" style={{ top, left: 0, width: Math.max(left, 0), height }} />
          <div className="fixed bg-black/60" style={{ top, left: left + width, right: 0, height }} />
          <div
            className="fixed rounded-xl ring-2 ring-blue-400 pointer-events-none"
            style={{ top, left, width, height, boxShadow: "0 0 0 4px rgba(59,130,246,0.35)" }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60" />
      )}

      <div className="fixed w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl" style={cardStyle}>
        <div className="text-xs font-semibold uppercase tracking-wider text-blue-600">
          Step {stepIndex + 1} of {totalSteps}
        </div>
        <div className="mt-1 text-base font-semibold text-slate-900">{currentStep.title}</div>
        <div className="mt-2 text-sm text-slate-600">{currentStep.body}</div>

        <div className="mt-4 flex items-center justify-between">
          <button type="button" onClick={restart} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
            Restart
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={skip}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
            >
              Skip Experience
            </button>
            {!currentStep.actionRequired && (
              <button
                type="button"
                onClick={next}
                className="rounded-lg bg-[#0f172a] px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 transition-colors"
              >
                {currentStep.nextLabel ?? "Next"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
