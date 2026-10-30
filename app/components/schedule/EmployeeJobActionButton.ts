"use client";

// Phase 5.5E-D — extracted from EmployeeSchedule.tsx as a small, dedicated
// .ts component (React.createElement, not JSX), for exactly the same
// structural reason OwnerBillingBanner.ts (Phase 5.5D) was: Node's built-in
// test runner (this repo's only test runner) cannot load a .tsx file at
// all, with or without JSX content. EmployeeSchedule.tsx is a large,
// fully-built production component (day navigation, appointment list,
// worked-hours display, logout) with no test coverage of its own yet --
// rewriting the whole file to .ts/React.createElement just to make it
// loadable would be a large, out-of-scope diff unrelated to job-tracking
// entitlement. Extracting only the Start/Complete control keeps
// EmployeeSchedule.tsx itself almost entirely untouched (one inline button
// block becomes one component call) while making the one control this
// phase actually governs genuinely renderable and testable via the
// established jsdom + @testing-library/react + @testing-library/user-event
// foundation (Phase 5.5D-P).
//
// Receives ONLY canUseJobTracking -- the one EmployeeEntitlementView field
// (Phase 5.5B) -- never a raw EntitlementResult, never billing/subscription
// state, never a workspace or Stripe identifier. The server-side
// canUseJobTracking capability gate in app/api/appointments/job/route.ts
// (unchanged by this phase) remains the sole security boundary; this
// component only decides whether to even attempt the request, and shows
// neutral wording when it won't.
import { createElement } from "react";
import type { ScheduledDayStatus } from "@/lib/timezone";

export type EmployeeJobAction = "start" | "complete";

export type EmployeeJobActionButtonProps = {
  action: EmployeeJobAction;
  loading: boolean;
  // Where the appointment's scheduled business day sits relative to today
  // (lib/timezone.ts scheduledDayStatus). Start is offered only on that
  // day; Complete (finishing work already started) is never limited by it.
  scheduledDay?: ScheduledDayStatus;
  canUseJobTracking: boolean;
  onActivate: () => void;
};

// Labels and colors preserved verbatim from the original inline buttons in
// EmployeeSchedule.tsx -- this extraction changes no employee-facing text
// or styling for the allowed case.
const LABEL: Record<EmployeeJobAction, string> = {
  start: "Start Job",
  complete: "Complete Job",
};
const LOADING_LABEL: Record<EmployeeJobAction, string> = {
  start: "Starting...",
  complete: "Completing...",
};
const COLOR_CLASSES: Record<EmployeeJobAction, string> = {
  start: "bg-blue-600 active:bg-blue-700",
  complete: "bg-emerald-600 active:bg-emerald-700",
};

// Deliberately neutral: no mention of subscription, billing, Stripe, plan
// status, grace periods, workspace restrictions, or the owner's account --
// this is the one and only employee-facing string this phase introduces.
const NEUTRAL_UNAVAILABLE_MESSAGE = "This action is temporarily unavailable. Please contact the office.";

// Why Start is unavailable on any day other than the scheduled one. The
// server (migration 041) enforces the same rule with its own clock.
export const START_DAY_MESSAGE: Record<Exclude<ScheduledDayStatus, "today">, string> = {
  before: "You can start this job on its scheduled day. Please contact the office if the date needs to change.",
  after: "This job's scheduled day has passed, so it can no longer be started. Please contact the office to record your time.",
};

export default function EmployeeJobActionButton({
  action,
  loading,
  scheduledDay = "today",
  canUseJobTracking,
  onActivate,
}: EmployeeJobActionButtonProps) {
  const restricted = !canUseJobTracking;
  const wrongDay = action === "start" && scheduledDay !== "today";
  const disabled = restricted || loading || wrongDay;
  const noticeId = `employee-job-action-notice-${action}`;

  function handleClick() {
    // Mirrors the `disabled` attribute above -- belt-and-suspenders against
    // any activation path (a stray synthetic event, a testing harness that
    // dispatches click without honoring `disabled`) reaching onActivate
    // while restricted or already in flight. The server-side capability
    // gate is still the only real security boundary (security principle
    // #8) -- this guard exists only so a disabled client control can never
    // itself be the thing standing between a restricted employee and a
    // real mutation request.
    if (disabled) return;
    onActivate();
  }

  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        onClick: handleClick,
        disabled,
        "aria-disabled": disabled,
        "aria-describedby": restricted || wrongDay ? noticeId : undefined,
        className: `w-full rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 transition-colors ${COLOR_CLASSES[action]}`,
      },
      loading ? LOADING_LABEL[action] : LABEL[action]
    ),
    (restricted || wrongDay) &&
      createElement(
        "div",
        { id: noticeId, className: "text-xs text-slate-500 mt-1.5 text-center" },
        restricted ? NEUTRAL_UNAVAILABLE_MESSAGE : START_DAY_MESSAGE[scheduledDay as "before" | "after"]
      )
  );
}
