"use client";

import { useEffect, useState } from "react";
import { useDemoExperienceContext } from "./DemoExperienceProvider";
import { backdropCells, type Box } from "./spotlightGeometry";

const SPOTLIGHT_PADDING = 8;

const APPOINTMENT_MODAL_SELECTOR = '[data-tour="appointment-modal"]';

export default function DemoExperienceOverlay() {
  const { active, currentStep, hint, stepIndex, totalSteps, next, back, skip, restart } = useDemoExperienceContext();
  // One rect per element matching the step's targetSelector (a selector
  // list such as '[data-tour="a"], [data-tour="b"]' spotlights each).
  const [rects, setRects] = useState<DOMRect[]>([]);
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
      setRects([]);
      setFloating(false);
      return;
    }

    const selector = currentStep.targetSelector;

    function measure() {
      const els = Array.from(document.querySelectorAll(selector)).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const modalEl = document.querySelector(APPOINTMENT_MODAL_SELECTOR);
      setRects(els.map((el) => el.getBoundingClientRect()));
      const modalHidesTarget = !!modalEl && !(els.length > 0 && els.every((el) => modalEl.contains(el)));
      const targetNotYetReachable = els.length === 0;
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
  const hasTarget = rects.length > 0 && !floating;
  const holes: Box[] = hasTarget
    ? rects.map((r) => ({
        top: r.top - SPOTLIGHT_PADDING,
        left: r.left - SPOTLIGHT_PADDING,
        width: r.width + SPOTLIGHT_PADDING * 2,
        height: r.height + SPOTLIGHT_PADDING * 2,
      }))
    : [];
  // The instruction card is positioned around the combined spotlight area
  // so it never sits on top of any highlighted control.
  const top = hasTarget ? Math.min(...holes.map((h) => h.top)) : 0;
  const left = hasTarget ? Math.min(...holes.map((h) => h.left)) : 0;
  const width = hasTarget ? Math.max(...holes.map((h) => h.left + h.width)) - left : 0;
  const height = hasTarget ? Math.max(...holes.map((h) => h.top + h.height)) - top : 0;

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
          {backdropCells(holes, window.innerWidth, window.innerHeight).map((cell, i) => (
            <div key={`dim-${i}`} className="fixed bg-black/60 pointer-events-auto" style={cell} />
          ))}
          {holes.map((hole, i) => (
            <div
              key={`ring-${i}`}
              className="fixed rounded-xl ring-2 ring-blue-400 pointer-events-none"
              style={{ ...hole, boxShadow: "0 0 0 4px rgba(59,130,246,0.35)" }}
            />
          ))}
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
              <li>✓ Reviewed revenue &amp; worked hours</li>
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
              <button
                type="button"
                onClick={back}
                className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                ← Back
              </button>
            </div>
            <div className="mt-3 text-center text-xs text-slate-400">
              {/* Deliberately not naming a specific destination: the real
                  tester backend's Restart Experience lives in its "Demo
                  Mode" Settings card, while the browser-local demo's lives
                  in the banner's Demo Controls popover (see
                  DemoBannerControls.tsx) -- this component takes no props
                  distinguishing the two, so a single generic sentence stays
                  honest for both rather than naming only one. */}
              You can restart this Experience anytime.
            </div>
          </>
        ) : (
          <>
            <div className="text-xs font-semibold uppercase tracking-wider text-blue-600">
              Step {stepIndex + 1} of {totalSteps}
            </div>
            <div className="mt-1 text-base font-semibold text-slate-900">{currentStep.title}</div>
            {/* A rejected-action hint replaces the body (it repeats what to
                do next) so the card keeps its size and placement. */}
            {hint ? (
              <div role="status" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {hint}
              </div>
            ) : (
              <div className="mt-2 text-sm text-slate-600">{currentStep.body}</div>
            )}

            <div className="mt-4 flex items-center justify-between">
              <button type="button" onClick={restart} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                Restart
              </button>
              <div className="flex items-center gap-2">
                {stepIndex > 0 && (
                  <button
                    type="button"
                    onClick={back}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    ← Back
                  </button>
                )}
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
