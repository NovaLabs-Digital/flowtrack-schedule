"use client";

// The Learning Center's client-side search + browse UI. A plain .ts file
// using React.createElement, not JSX, for the same structural reason
// CapabilityGatedButton.ts/AdjustWorkedTimeControl.ts are: Node's built-in
// test runner cannot load a .tsx file at all, and this is exactly the kind
// of component that needs real rendered typing/filtering interaction proof
// rather than source inspection.
//
// Deliberately uses plain <a> tags for guide links, not next/link's <Link>
// -- this keeps the component renderable/testable in a bare jsdom
// environment with no Next.js app-router context to mock, and a full-page
// navigation between two static content pages costs nothing meaningful
// here (Phase 1 explicitly calls for something small, not a client-routed
// documentation platform). app/learn/page.tsx and app/learn/[slug]/page.tsx
// themselves are plain server components and use next/link as usual.
//
// Search runs entirely client-side (searchGuides, lib/learningCenter.ts) --
// no network request, no server round-trip, filters as the owner types.
import { createElement, useMemo, useState } from "react";
import { CATEGORIES, categoryName, searchGuides, type Guide } from "@/lib/learningCenter";

export type LearningCenterSearchProps = {
  guides: Guide[];
};

function GuideCard(guide: Guide) {
  return createElement(
    "a",
    {
      key: guide.slug,
      href: `/learn/${guide.slug}`,
      className:
        "block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-slate-300 hover:shadow transition-colors",
    },
    createElement(
      "div",
      { className: "inline-block rounded-full bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700" },
      categoryName(guide.category)
    ),
    createElement("div", { className: "mt-2 text-base font-semibold text-slate-900" }, guide.title),
    createElement("div", { className: "mt-1.5 text-sm text-slate-600 leading-relaxed" }, guide.description)
  );
}

function guideGrid(guides: Guide[]) {
  return createElement(
    "div",
    { className: "grid grid-cols-1 sm:grid-cols-2 gap-4" },
    guides.map((g) => GuideCard(g))
  );
}

export default function LearningCenterSearch({ guides }: LearningCenterSearchProps) {
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  // Only recomputed when the query or guide list actually changes -- Phase
  // 1's guide count is small enough that this would be cheap either way,
  // but there's no reason to re-filter on every unrelated re-render.
  const results = useMemo(() => (trimmed ? searchGuides(query, guides) : []), [query, trimmed, guides]);

  return createElement(
    "div",
    null,
    // Search bar -- prominent, near the top of the page (this component is
    // rendered right below the page's own intro heading).
    createElement(
      "div",
      { className: "relative max-w-xl mx-auto" },
      createElement("input", {
        type: "search",
        value: query,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
        placeholder: "What do you want to learn?",
        "aria-label": "What do you want to learn?",
        className:
          "w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500",
      })
    ),
    createElement(
      "div",
      { className: "mt-8" },
      trimmed
        ? // Search mode: a single flat list of matches, or the no-results state.
          results.length === 0
          ? createElement(
              "div",
              { className: "text-center text-sm text-slate-500 py-12" },
              "No guides found. Try another search."
            )
          : guideGrid(results)
        : // Browse mode: every category that currently has at least one
          // guide, in the declared category order. A category with no
          // guides yet (Phase 1: Getting Started, Employees & Staff,
          // Mobile, Settings) is simply not shown -- an empty section
          // header would look unfinished, not "coming soon."
          CATEGORIES.map((cat) => {
            const inCategory = guides.filter((g) => g.category === cat.id);
            if (inCategory.length === 0) return null;
            return createElement(
              "section",
              { key: cat.id, className: "mb-10 last:mb-0" },
              createElement("h2", { className: "text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4" }, cat.name),
              guideGrid(inCategory)
            );
          })
    )
  );
}
