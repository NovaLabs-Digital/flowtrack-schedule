"use client";

// Phase 5.5E-E1A — a small, reusable, capability-aware button primitive,
// written as a plain .ts file using React.createElement instead of JSX for
// the same structural reason OwnerBillingBanner.ts (Phase 5.5D) and
// EmployeeJobActionButton.ts (Phase 5.5E-D) were: Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content. This is the one thing in this phase that
// genuinely needs real rendered mouse/keyboard interaction proof, so it
// lives in a loadable file.
//
// Deliberately attribute-only: this component renders exactly one <button>
// element and nothing else -- no wrapping <div>, no self-rendered notice
// text. AppointmentModal.tsx (and any future owner component using this
// primitive) places this button inside existing flex/stack layouts whose
// styling (e.g. `flex-1` on a flex-row sibling) depends on the button being
// a direct, unwrapped child; adding a wrapper or a second sibling element
// would silently change that layout. Instead, the caller renders its own
// neutral-wording notice wherever it fits the existing layout, and passes
// that notice's id in as `ariaDescribedBy` -- this component only ever
// wires `aria-describedby` to it when restricted, never renders the text
// itself. This also naturally satisfies "avoid repeating large billing
// notices" -- a caller with several governed buttons close together (e.g.
// AppointmentModal's submit/delete/recurrence buttons) can point all of
// them at one shared notice element instead of duplicating it per button.
//
// Receives ONLY a plain `allowed: boolean` -- never a raw EntitlementView,
// EntitlementResult, workspace id, or Stripe/subscription identifier. The
// server-side capability gate on the route this button's onClick (or the
// parent form's onSubmit) ultimately reaches remains the sole security
// boundary (security principle: disabled client controls must not be
// treated as the security boundary) -- this component only decides
// whether to even attempt the click, and exposes enough state (disabled,
// aria-disabled, aria-describedby) for the caller to explain why.
import { createElement, type ReactNode } from "react";

export type CapabilityGatedButtonProps = {
  type?: "button" | "submit";
  allowed: boolean;
  // An additional, unrelated reason to disable the button (e.g. an
  // in-flight submit/loading state) -- combined with `!allowed`, never
  // overriding it. Preserves each caller's own existing loading/duplicate-
  // submit-protection disabled logic exactly as it was before this
  // capability gate was added.
  disabled?: boolean;
  onClick?: () => void;
  className: string;
  // Optional in the type only so React.createElement's variadic-children
  // call form (used by this file's own tests, and matching how React
  // itself types createElement for components with children) type-checks;
  // every real caller always supplies a label/content.
  children?: ReactNode;
  // Id of a notice element the caller already renders elsewhere describing
  // the restriction (e.g. AppointmentModal's single shared restricted-
  // notice block) -- referenced via aria-describedby only while restricted.
  // Omit when no such notice exists at the call site.
  ariaDescribedBy?: string;
};

export default function CapabilityGatedButton({
  type = "button",
  allowed,
  disabled,
  onClick,
  className,
  children,
  ariaDescribedBy,
}: CapabilityGatedButtonProps) {
  const restricted = !allowed;
  const isDisabled = restricted || !!disabled;

  function handleClick() {
    // Mirrors the `disabled` attribute below -- belt-and-suspenders against
    // any activation path (a stray synthetic event, a testing harness that
    // dispatches click without honoring `disabled`) reaching onClick while
    // restricted or otherwise disabled. The server-side capability gate on
    // the route this eventually calls is still the only real security
    // boundary; this guard exists only so a disabled client control can
    // never itself be the thing standing between a restricted owner and a
    // real mutation request.
    if (isDisabled) return;
    onClick?.();
  }

  return createElement(
    "button",
    {
      type,
      onClick: handleClick,
      disabled: isDisabled,
      "aria-disabled": isDisabled,
      "aria-describedby": restricted ? ariaDescribedBy : undefined,
      className,
    },
    children
  );
}
