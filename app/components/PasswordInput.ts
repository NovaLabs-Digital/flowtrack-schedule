"use client";

// Phase 5.7D-R17: one reusable password field with a show/hide toggle,
// shared by every password input in the app (owner/employee login, signup,
// signup confirm-password, and staff employee credential entry) so the
// toggle behavior, accessible labels, and keyboard support never diverge
// between call sites. A pure UI wrapper around a plain <input> -- value/
// onChange/placeholder/className behave identically to a native input, so
// no caller needs to change its own state or submit logic to adopt this.
//
// Written as a plain .ts file using React.createElement instead of JSX, for
// the same structural reason CapabilityGatedButton.ts/OwnerBillingBanner.ts/
// EmployeeJobActionButton.ts are: Node's built-in test runner (this repo's
// only test runner) cannot load a .tsx file at all, with or without JSX
// content, and this component's show/hide toggle genuinely needs real
// rendered click/keyboard interaction proof.
import { createElement, useId, useState, type ChangeEvent } from "react";

export type PasswordInputProps = {
  id?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
};

function eyeIcon() {
  return createElement(
    "svg",
    { viewBox: "0 0 20 20", fill: "none", className: "w-4 h-4", "aria-hidden": "true" },
    createElement("path", {
      d: "M1 10s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
    createElement("circle", { cx: "10", cy: "10", r: "2.5", stroke: "currentColor", strokeWidth: "1.5" })
  );
}

function eyeOffIcon() {
  return createElement(
    "svg",
    { viewBox: "0 0 20 20", fill: "none", className: "w-4 h-4", "aria-hidden": "true" },
    createElement("path", {
      d: "M1 10s3.5-6 9-6c1.86 0 3.44.63 4.72 1.44M19 10s-1.02 1.75-2.9 3.32M10 4c5.5 0 9 6 9 6s-.66 1.14-1.86 2.4M5.1 5.85C2.9 7.3 1 10 1 10s3.5 6 9 6c1.35 0 2.58-.36 3.65-.9",
      stroke: "currentColor",
      strokeWidth: "1.5",
      strokeLinecap: "round",
      strokeLinejoin: "round",
    }),
    createElement("path", { d: "M1 1l18 18", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" })
  );
}

export default function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  className,
  autoComplete,
  disabled,
  required,
}: PasswordInputProps) {
  // Hidden by default -- every field starts as type="password", never
  // pre-revealed, regardless of prior state elsewhere on the page.
  const [visible, setVisible] = useState(false);
  const autoId = useId();
  const inputId = id ?? autoId;

  return createElement(
    "div",
    { className: "relative" },
    createElement("input", {
      id: inputId,
      type: visible ? "text" : "password",
      value,
      onChange,
      placeholder,
      autoComplete,
      disabled,
      required,
      className,
      style: { paddingRight: "2.5rem" },
    }),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setVisible((v) => !v),
        "aria-label": visible ? "Hide password" : "Show password",
        "aria-pressed": visible,
        tabIndex: 0,
        className: "absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-r-xl",
      },
      visible ? eyeOffIcon() : eyeIcon()
    )
  );
}
