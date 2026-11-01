"use client";

// Above a shared form in a Guided Demo Session: who is editing it, and --
// for the host always, for an allowed guest while the host is idle -- a way
// to take over. The draft (and its original edit version) carries over.
// Renders nothing outside a session or while you are the one editing.
// (createElement rather than JSX so plain-TypeScript components and their
// tests -- e.g. AdjustWorkedTimeControl.ts -- can import it.)
import { createElement } from "react";
import { useSharedScreen, type SharedDraft } from "@/app/components/dashboard/sharedScreen";

const button = "rounded-md px-2 py-1 text-xs font-medium";

export default function SharedEditNotice({ draft }: { draft: SharedDraft }) {
  const shared = useSharedScreen();
  if (!shared || (!draft.editor && !draft.heldBack)) return null;
  const other = shared.otherName;

  if (draft.heldBack) {
    return createElement(
      "div",
      { role: "status", "data-shared-edit-notice": "", className: "mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" },
      `${other} started editing this first, so your change wasn't shared. It's kept here until you choose.`,
      createElement(
        "div",
        { className: "mt-1.5 flex gap-2" },
        createElement("button", { type: "button", onClick: draft.useTheirs, className: `${button} border border-amber-300 bg-white` }, "Use their version"),
        shared.role === "host" && createElement("button", { type: "button", onClick: draft.takeOver, className: `${button} bg-slate-900 text-white` }, "Take over editing")
      )
    );
  }

  if (draft.mine || !draft.editor) return null;
  const canTakeOver = shared.canAct && (shared.role === "host" || !draft.editor.dirty);
  return createElement(
    "div",
    { role: "status", "data-shared-edit-notice": "", className: "mt-3 flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900" },
    createElement("span", null, `${other} is editing this. You're following along; their changes appear here.`),
    canTakeOver &&
      createElement(
        "button",
        { type: "button", onClick: draft.takeOver, className: `${button} shrink-0 bg-blue-600 text-white` },
        shared.role === "host" ? "Take over editing" : "Start editing"
      )
  );
}
