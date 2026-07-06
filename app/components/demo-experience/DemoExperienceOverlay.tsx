"use client";

import { useEffect, useState } from "react";
import { useDemoExperienceContext } from "./DemoExperienceProvider";

const SPOTLIGHT_PADDING = 8;

const APPOINTMENT_MODAL_SELECTOR = '[data-tour="appointment-modal"]';

export default function DemoExperienceOverlay() {
  const { active, currentStep, stepIndex, totalSteps, next, skip, restart } = useDemoExperienceContext();
  const [rect, setRect] = useState<DOMRect | null>(null);
  // True whenever we should back off entirely (no backdrop, just a corner
  // card) rather than blocking the whole screen: either the AppointmentModal
  // is open and today's target lives outside it (e.g. the "+ Add
  // Appointment" button, now hidden behind the modal), or the step has a
  // real target that simply hasn't been navigated to yet (e.g. Employees/
  // Services expect the tester to open Settings first). A full blocking
  // backdrop in that second case would trap the user — they'd have no way
  // to click through to the view that reveals the real target.
  const [floating, setFloating] = useState(false);

  // Measures the target element's position from the DOM (an external
  // system relative to React state) and keeps it in sync as the page
  // scrolls/resizes/reflows — the canonical use case the effect rule's own
  // guidance calls out as valid.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!active || !currentStep?.targetSelector) {
      setRect(null);
      setFloating(false);
      return;
    }

    const selector = currentStep.targetSelector;

    function measure() {
      const el = document.querySelector(selector);
      const modalEl = document.querySelector(APPOINTMENT_MODAL_SELECTOR);
      setRect(el ? el.getBoundingClientRect() : null);
      const modalHidesTarget = !!modalEl && !(el && modalEl.contains(el));
      const targetNotYetReachable = !el;
      setFloating(modalHidesTarget || targetNotYetReachable);
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

  const isCompletion = currentStep.id === "completion";
  const hasTarget = !!rect && !floating;
  const top = hasTarget ? rect!.top - SPOTLIGHT_PADDING : 0;
  const left = hasTarget ? rect!.left - SPOTLIGHT_PADDING : 0;
  const width = hasTarget ? rect!.width + SPOTLIGHT_PADDING * 2 : 0;
  const height = hasTarget ? rect!.height + SPOTLIGHT_PADDING * 2 : 0;

  const CARD_WIDTH = 384; // matches max-w-sm
  const CARD_HEIGHT_ESTIMATE = 220;
  const GAP = 16;

  let cardStyle: React.CSSProperties;
  if (floating) {
    cardStyle = { top: 16, right: 16 };
  } else if (hasTarget) {
    const fitsBelow = top + height + GAP + CARD_HEIGHT_ESTIMATE <= window.innerHeight;
    if (fitsBelow) {
      cardStyle = {
        top: top + height + GAP,
        left: Math.min(Math.max(left, 16), window.innerWidth - CARD_WIDTH - 16),
      };
    } else {
      // Target is too tall for the card to fit below it on this viewport
      // (e.g. a full schedule grid or a phone-sized preview) — placing it
      // below would clamp upward and overlap the target itself (blocking
      // exactly the control the step needs clicked). Place it beside the
      // spotlight instead.
      const cardTop = Math.min(Math.max(top, 16), window.innerHeight - CARD_HEIGHT_ESTIMATE - 16);
      const spaceRight = window.innerWidth - (left + width) - GAP;
      cardStyle = spaceRight >= CARD_WIDTH + GAP
        ? { top: cardTop, left: left + width + GAP }
        : { top: cardTop, left: Math.max(left - CARD_WIDTH - GAP, 16) };
    }
  } else {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  return (
    // pointer-events-none on the wrapper so the untouched page (the
    // spotlight "hole") stays genuinely clickable for a real mouse — only
    // the dimmed regions and the card itself opt back in below.
    <div className="fixed inset-0 z-[200] pointer-events-none" role="dialog" aria-live="polite">
      {!floating && (hasTarget ? (
        <>
          <div className="fixed bg-black/60 pointer-events-auto" style={{ top: 0, left: 0, right: 0, height: Math.max(top, 0) }} />
          <div className="fixed bg-black/60 pointer-events-auto" style={{ top: top + height, left: 0, right: 0, bottom: 0 }} />
          <div className="fixed bg-black/60 pointer-events-auto" style={{ top, left: 0, width: Math.max(left, 0), height }} />
          <div className="fixed bg-black/60 pointer-events-auto" style={{ top, left: left + width, right: 0, height }} />
          <div
            className="fixed rounded-xl ring-2 ring-blue-400 pointer-events-none"
            style={{ top, left, width, height, boxShadow: "0 0 0 4px rgba(59,130,246,0.35)" }}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60 pointer-events-auto" />
      ))}

      <div
        className={[
          "fixed w-full rounded-2xl bg-white p-5 shadow-2xl pointer-events-auto",
          isCompletion ? "max-w-md" : "max-w-sm",
        ].join(" ")}
        style={cardStyle}
      >
        {isCompletion ? (
          <>
            <div className="text-lg font-semibold text-slate-900">Congratulations!</div>
            <div className="mt-1 text-sm text-slate-600">
              You have successfully experienced ScheduleFlowTrack.
            </div>
            <div className="mt-3 text-xs font-semibold uppercase tracking-wider text-slate-400">Today you</div>
            <ul className="mt-1.5 space-y-1 text-sm text-slate-700">
              <li>✓ Managed appointments</li>
              <li>✓ Edited services</li>
              <li>✓ Worked with employees</li>
              <li>✓ Managed clients</li>
              <li>✓ Created appointments</li>
              <li>✓ Experienced Mobile Admin</li>
            </ul>
            <div className="mt-4 pt-4 border-t border-slate-200 text-center text-base font-semibold text-slate-900">
              Now imagine running <span className="text-blue-600">YOUR</span> business this way.
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={next}
                className="rounded-lg bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
              >
                Start My Business
              </button>
              <button
                type="button"
                onClick={next}
                className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
              >
                Continue Exploring
              </button>
            </div>
            <div className="mt-3 text-center text-xs text-slate-400">
              You can restart this Experience anytime from Demo Settings.
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}
