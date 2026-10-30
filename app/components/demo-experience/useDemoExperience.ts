"use client";

import { useCallback, useEffect, useState } from "react";
import { DEMO_EXPERIENCE_STEPS } from "./demoExperienceSteps";
import { notifyDemoStepEntered, subscribeDemoAction } from "./demoExperienceBus";

const STORAGE_KEY = "sft_demo_experience_step";
// Set once the tour has been auto-started, skipped, or completed, so a
// tester who already saw it doesn't get re-prompted on every later page
// load — auto-start is meant to fire once, right after the first demo login.
const SEEN_KEY = "sft_demo_experience_seen";
const AUTO_START_DELAY_MS = 1000;

export function useDemoExperience(autoStartEnabled: boolean = false) {
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  // Hint shown after a rejected action (see DemoExperienceStep.rejectedHint).
  // Stored with the step it belongs to, so it disappears as soon as the
  // step changes without needing an effect to clear it.
  const [rejection, setRejection] = useState<{ stepIndex: number; hint: string } | null>(null);
  // Bumped by start/restart so re-entering the step already showing (e.g.
  // Restart while on Welcome) still re-opens that step's screen.
  const [visit, setVisit] = useState(0);

  // Resume from localStorage on mount. This must run in an effect (not a lazy
  // useState initializer) so the first client render matches the server
  // render (both start inactive) before syncing from the external
  // localStorage value — a lazy initializer would read localStorage during
  // the initial client render and cause a hydration mismatch.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    let resumed = false;
    if (saved !== null) {
      const parsed = Number(saved);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed < DEMO_EXPERIENCE_STEPS.length) {
        setStepIndex(parsed);
        setActive(true);
        resumed = true;
      }
    }
    setHydrated(true);

    if (!resumed && autoStartEnabled && !window.localStorage.getItem(SEEN_KEY)) {
      const timer = window.setTimeout(() => {
        window.localStorage.setItem(SEEN_KEY, "1");
        setStepIndex(0);
        setActive(true);
      }, AUTO_START_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
  }, [autoStartEnabled]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!hydrated) return;
    if (active) {
      window.localStorage.setItem(STORAGE_KEY, String(stepIndex));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, [active, stepIndex, hydrated]);

  // Announce every step entered so the dashboard can open its screen.
  useEffect(() => {
    if (!hydrated || !active) return;
    const step = DEMO_EXPERIENCE_STEPS[stepIndex];
    if (step) notifyDemoStepEntered(step.id);
  }, [active, stepIndex, visit, hydrated]);

  const start = useCallback(() => {
    setRejection(null);
    setStepIndex(0);
    setActive(true);
    setVisit((v) => v + 1);
  }, []);

  const skip = useCallback(() => {
    window.localStorage.setItem(SEEN_KEY, "1");
    setActive(false);
  }, []);

  // Restart only rewinds the tour (and, via the step announcement above,
  // the screen). Fictional data edits are kept; Reset Demo is the separate
  // action that restores the original data.
  const restart = useCallback(() => {
    setRejection(null);
    setStepIndex(0);
    setActive(true);
    setVisit((v) => v + 1);
  }, []);

  const back = useCallback(() => {
    setRejection(null);
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const next = useCallback(() => {
    setRejection(null);
    setStepIndex((i) => {
      const nextIndex = i + 1;
      if (nextIndex >= DEMO_EXPERIENCE_STEPS.length) {
        window.localStorage.setItem(SEEN_KEY, "1");
        setActive(false);
        return i;
      }
      return nextIndex;
    });
  }, []);

  const markAction = useCallback(
    (actionId: string) => {
      const current = DEMO_EXPERIENCE_STEPS[stepIndex];
      if (current?.actionId === actionId) {
        next();
      } else if (current && !current.actionRequired && DEMO_EXPERIENCE_STEPS[stepIndex + 1]?.actionId === actionId) {
        // The visitor already did what the NEXT step asks (e.g. double-
        // clicking a card opens Edit while "Revenue & Worked Hours" is
        // showing) -- skip the view-only step rather than leave its
        // instructions behind the editor.
        setRejection(null);
        setStepIndex((i) => Math.min(i + 2, DEMO_EXPERIENCE_STEPS.length - 1));
      } else if (current?.rejectedActionId === actionId && current.rejectedHint) {
        setRejection({ stepIndex, hint: current.rejectedHint });
      }
    },
    [stepIndex, next]
  );

  // Any component can call notifyDemoAction(id) (from demoExperienceBus)
  // without being a context consumer — this is what actually listens.
  useEffect(() => subscribeDemoAction(markAction), [markAction]);

  const currentStep = active ? DEMO_EXPERIENCE_STEPS[stepIndex] ?? null : null;
  const hint = active && rejection?.stepIndex === stepIndex ? rejection.hint : null;

  return {
    active,
    stepIndex,
    currentStep,
    hint,
    totalSteps: DEMO_EXPERIENCE_STEPS.length,
    start,
    skip,
    restart,
    back,
    next,
    markAction,
  };
}
