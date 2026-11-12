"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDemoExperienceContext } from "./DemoExperienceProvider";
import { backdropCells, placeCard, type Box } from "./spotlightGeometry";
import { FRAME_SELECTOR_SEPARATOR } from "./demoExperienceSteps";

const SPOTLIGHT_PADDING = 8;

const APPOINTMENT_MODAL_SELECTOR = '[data-tour="appointment-modal"]';
// The form panel itself (the selector above is its full-screen backdrop).
const APPOINTMENT_FORM_SELECTOR = '[data-tour="appointment-modal"] > [data-keep-clear]';

const CARD_WIDTH = 384; // matches max-w-sm
const COMPLETION_CARD_WIDTH = 448; // matches max-w-md

const toBox = (r: DOMRect): Box => ({ top: r.top, left: r.left, width: r.width, height: r.height });

// An element's box including content that spills past it (e.g. a wide
// Services table on a small screen, whose Delete buttons sit beyond the
// panel's edge), clipped to what its nearest scrolling ancestor shows.
// Without this the dimming would cover controls the step asks for.
function contentBox(el: Element): Box {
  const r = el.getBoundingClientRect();
  const own = getComputedStyle(el);
  // A scrolling element keeps its hidden content inside its own box.
  if (/(auto|scroll|hidden)/.test(own.overflowX + own.overflowY)) return toBox(r);
  let box: Box = { left: r.left, top: r.top, width: Math.max(r.width, el.scrollWidth), height: Math.max(r.height, el.scrollHeight) };
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    if (/(auto|scroll|hidden)/.test(style.overflowX + style.overflowY)) {
      const c = p.getBoundingClientRect();
      const left = Math.max(box.left, c.left);
      const top = Math.max(box.top, c.top);
      const right = Math.min(box.left + box.width, c.right);
      const bottom = Math.min(box.top + box.height, c.bottom);
      box = { left, top, width: Math.max(right - left, r.width > 0 ? 1 : 0), height: Math.max(bottom - top, r.height > 0 ? 1 : 0) };
      break;
    }
  }
  return box;
}

// Visible rects for a selector list. "<iframe> >>> <inner>" measures inside a
// same-origin iframe (the phone preview), mapped to page coordinates --
// including any CSS scale applied to the frame.
function measureSelector(selector: string): Box[] {
  const boxes: Box[] = [];
  for (const part of selector.split(/,(?![^[]*\])/)) {
    const [outer, inner] = part.split(FRAME_SELECTOR_SEPARATOR).map((s) => s.trim());
    if (!inner) {
      for (const el of Array.from(document.querySelectorAll(outer))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) boxes.push(contentBox(el));
      }
      continue;
    }
    for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>(outer))) {
      try {
        const doc = frame.contentDocument;
        const fr = frame.getBoundingClientRect();
        const scale = frame.offsetWidth > 0 ? fr.width / frame.offsetWidth : 1;
        for (const el of Array.from(doc?.querySelectorAll(inner) ?? [])) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            boxes.push({ left: fr.left + r.left * scale, top: fr.top + r.top * scale, width: r.width * scale, height: r.height * scale });
          }
        }
      } catch {
        // Not loaded yet (or not same-origin): nothing to spotlight yet.
      }
    }
  }
  return boxes;
}

type TabHelp = { label: string; text: string; box: Box };

export default function DemoExperienceOverlay() {
  const { active, currentStep, hint, revealed, canAdvance, stepIndex, totalSteps, next, back, skip, restart } = useDemoExperienceContext();
  // One rect per element matching the step's (revealed) target selector.
  const [rects, setRects] = useState<Box[]>([]);
  // Elements the card must keep clear (see DemoExperienceStep.cardAvoidSelector).
  const [avoid, setAvoid] = useState<Box[]>([]);
  // True whenever we should back off entirely (no backdrop, just a card
  // placed clear of what the visitor is working in) rather than blocking
  // the whole screen: either the AppointmentModal is open and today's
  // target lives outside it (e.g. the "+ Add Appointment" button, now
  // hidden behind the modal), or the step has a real target that simply
  // hasn't been navigated to yet. A full blocking backdrop in that second
  // case would trap the user -- they'd have no way to click through to the
  // view that reveals the real target.
  const [floating, setFloating] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardHeights, setCardHeights] = useState<{ key: string; byWidth: Record<number, number> }>({ key: "", byWidth: {} });
  const [tabHelp, setTabHelp] = useState<TabHelp | null>(null);

  const selector = currentStep ? (revealed && currentStep.revealedTargetSelector) || currentStep.targetSelector : null;
  const avoidSelector = currentStep?.cardAvoidSelector ?? null;

  // Measures the target element's position from the DOM (an external
  // system relative to React state) and keeps it in sync as the page
  // scrolls/resizes/reflows -- the canonical use case the effect rule's own
  // guidance calls out as valid.
  useEffect(() => {
    if (!active || !currentStep) {
      setRects([]);
      setAvoid([]);
      setFloating(false);
      return;
    }

    function measure() {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      const modalEl = document.querySelector(APPOINTMENT_MODAL_SELECTOR);
      const avoidBoxes = [
        ...(avoidSelector ? measureSelector(avoidSelector) : []),
        // The appointment form is never covered, whatever the step.
        ...measureSelector(APPOINTMENT_FORM_SELECTOR),
      ];
      setAvoid(avoidBoxes);
      if (!selector) {
        setRects([]);
        setFloating(false);
        return;
      }
      const boxes = measureSelector(selector);
      setRects(boxes);
      const targetEls = Array.from(document.querySelectorAll(selector.split(FRAME_SELECTOR_SEPARATOR)[0]));
      const modalHidesTarget = !!modalEl && !(targetEls.length > 0 && targetEls.every((el) => modalEl.contains(el)));
      setFloating(modalHidesTarget || boxes.length === 0);
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Schedule/appointment layout can shift after data loads or a modal
    // closes without firing a resize/scroll event -- a light poll keeps the
    // spotlight aligned without needing every component to notify us.
    const interval = window.setInterval(measure, 300);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(interval);
    };
  }, [active, currentStep, selector, avoidSelector]);

  // The card's real height at each width it has been shown at (a narrower
  // card is taller). Measured once per width for the current text, so
  // placement settles: it never chases a height that its own choice of
  // width keeps changing.
  const contentKey = `${currentStep?.id}|${revealed}|${hint ?? ""}`;
  // No dependency list on purpose: it checks after every render (the card
  // can change width), and returns the same state for a width it already
  // knows, so it settles instead of looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w <= 0 || h <= 0) return;
    setCardHeights((prev) => {
      // Each width is measured once per text: at most a few updates, never a loop.
      if (prev.key === contentKey && prev.byWidth[w] !== undefined) return prev;
      const known = prev.key === contentKey ? prev.byWidth : {};
      return { key: contentKey, byWidth: { ...known, [w]: h } };
    });
  });

  // Hover help for the Settings tabs (settings-overview step).
  const helpSelector = active && revealed ? currentStep?.tabHelpSelector ?? null : null;
  useEffect(() => {
    if (!helpSelector || !currentStep?.tabHelp) {
      setTabHelp(null);
      return;
    }
    const help = currentStep.tabHelp;
    function onOver(e: PointerEvent) {
      const tab = (e.target as Element | null)?.closest?.(`${helpSelector} button`);
      const label = tab?.textContent?.trim() ?? "";
      if (tab && help[label]) setTabHelp({ label, text: help[label], box: toBox(tab.getBoundingClientRect()) });
      else setTabHelp(null);
    }
    document.addEventListener("pointerover", onOver);
    return () => document.removeEventListener("pointerover", onOver);
  }, [helpSelector, currentStep]);

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

  // The card goes where it covers nothing the visitor is using: never a
  // form being filled in or a card being looked at, and as little of the
  // spotlight as possible (narrowing itself on small screens if needed).
  let cardStyle: React.CSSProperties;
  let cardBox: Box | null = null;
  if (!isCompletion && (hasTarget || floating) && viewport.width > 0) {
    const known = cardHeights.key === contentKey ? cardHeights.byWidth : {};
    const measured = Object.entries(known).map(([w, h]) => [Number(w), h] as const);
    // A width not shown yet: scale the nearest measured width (text reflows
    // roughly in proportion), or a typical card height before any measurement.
    const heightFor = (w: number) => {
      if (known[w] !== undefined) return known[w];
      if (measured.length === 0) return Math.round((220 * CARD_WIDTH) / w);
      const [mw, mh] = measured.reduce((a, b) => (Math.abs(b[0] - w) < Math.abs(a[0] - w) ? b : a));
      return Math.round((mh * mw) / w);
    };
    const box = placeCard({
      cardWidth: CARD_WIDTH,
      cardHeight: heightFor(CARD_WIDTH),
      heightFor,
      holes,
      avoid,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
    cardBox = box;
    cardStyle = { top: box.top, left: box.left, width: box.width, maxWidth: box.width };
  } else {
    cardStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)", maxWidth: isCompletion ? COMPLETION_CARD_WIDTH : CARD_WIDTH };
  }

  // Hover help sits under its tab, slid left of the instruction card when
  // they would overlap, so neither hides the other.
  let tabHelpStyle: React.CSSProperties | null = null;
  if (tabHelp) {
    const TIP_WIDTH = 256;
    const vw = viewport.width || window.innerWidth;
    const top = tabHelp.box.top + tabHelp.box.height + 8;
    let left = Math.min(Math.max(tabHelp.box.left, 8), vw - TIP_WIDTH - 8);
    if (cardBox) {
      const card = document.querySelector('[data-tour="tour-card"]')?.getBoundingClientRect();
      const cardBottom = card ? card.bottom : cardBox.top + cardBox.height;
      const overlapsVertically = top < cardBottom && top + 90 > cardBox.top;
      if (overlapsVertically && left + TIP_WIDTH > cardBox.left && left < cardBox.left + cardBox.width) {
        left = cardBox.left - TIP_WIDTH - 8 >= 8 ? cardBox.left - TIP_WIDTH - 8 : Math.min(cardBox.left + cardBox.width + 8, vw - TIP_WIDTH - 8);
      }
    }
    tabHelpStyle = { top, left };
  }

  const body = revealed && currentStep.revealedBody ? currentStep.revealedBody : currentStep.body;
  const nextLocked = !currentStep.actionRequired && !canAdvance;

  return (
    // pointer-events-none on the wrapper so the untouched page (the
    // spotlight "hole") stays genuinely clickable for a real mouse -- only
    // the dimmed regions and the card itself opt back in below.
    <div className="fixed inset-0 z-[200] pointer-events-none" role="dialog" aria-live="polite">
      {!floating && (hasTarget ? (
        <>
          {backdropCells(holes, viewport.width || window.innerWidth, viewport.height || window.innerHeight).map((cell, i) => (
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

      {tabHelp && tabHelpStyle && (
        <div
          role="tooltip"
          data-tour="tab-help"
          className="fixed z-10 w-64 rounded-lg bg-slate-900 px-3 py-2 text-xs text-white shadow-xl pointer-events-none"
          style={tabHelpStyle}
        >
          <div className="font-semibold">{tabHelp.label}</div>
          <div className="mt-0.5 text-slate-200">{tabHelp.text}</div>
        </div>
      )}

      <div
        ref={cardRef}
        data-tour="tour-card"
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
              <li>✓ Toured Settings</li>
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
              <div className="mt-2 text-sm text-slate-600">{body}</div>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
              <button type="button" onClick={restart} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                Restart
              </button>
              <div className="flex flex-wrap items-center justify-end gap-2">
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
                    disabled={nextLocked}
                    title={nextLocked ? "Do the step above first" : undefined}
                    className="rounded-lg bg-[#0f172a] px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 transition-colors"
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
