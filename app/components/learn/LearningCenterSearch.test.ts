// Real rendered-component behavior tests for LearningCenterSearch.ts, using
// the jsdom + @testing-library/react + @testing-library/user-event
// foundation (see AdjustWorkedTimeControl.test.ts for the established
// pattern). Uses a small, self-contained fixture guide list (not the real
// GUIDES from lib/learningCenter.ts) so these tests stay stable regardless
// of future Phase 1+ content edits -- lib/learningCenter.test.ts already
// covers the real guide data and the searchGuides function directly.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Guide } from "@/lib/learningCenter";

const { default: LearningCenterSearch } = await import("./LearningCenterSearch.ts");

afterEach(() => {
  cleanup();
});

const FIXTURE_GUIDES: Guide[] = [
  {
    slug: "alpha-guide",
    title: "How Alpha Works",
    category: "scheduling-calendar",
    description: "Everything about the alpha feature.",
    keywords: ["first thing", "alpha"],
    steps: ["Do the alpha thing."],
  },
  {
    slug: "beta-guide",
    title: "How Beta Works",
    category: "job-tracking",
    description: "Everything about the beta feature.",
    keywords: ["second thing", "beta"],
    steps: ["Do the beta thing."],
  },
  {
    slug: "gamma-guide",
    title: "How Gamma Works",
    category: "job-tracking",
    description: "Everything about the payroll-adjacent gamma feature.",
    keywords: ["third thing", "gamma", "payroll"],
    steps: ["Do the gamma thing."],
  },
];

function renderSearch(guides: Guide[] = FIXTURE_GUIDES) {
  render(React.createElement(LearningCenterSearch, { guides }));
}

const user = () => userEvent.setup();

describe("search bar", () => {
  test("renders a prominent search input with the exact placeholder/label text", () => {
    renderSearch();
    const input = screen.getByPlaceholderText("What do you want to learn?") as HTMLInputElement;
    assert.ok(input);
    assert.equal(input.type, "search");
    assert.ok(screen.getByLabelText("What do you want to learn?"));
  });
});

describe("browse mode (no query typed yet)", () => {
  test("groups guides under their category headers", () => {
    // Each category's name also appears a second time, as the small badge
    // on every one of its guide cards -- getByRole("heading") disambiguates
    // the actual <h2> section header from those badges.
    renderSearch();
    assert.ok(screen.getByRole("heading", { name: "Scheduling & Calendar" }));
    assert.ok(screen.getByRole("heading", { name: "Job Tracking" }));
    assert.ok(screen.getByText("How Alpha Works"));
    assert.ok(screen.getByText("How Beta Works"));
    assert.ok(screen.getByText("How Gamma Works"));
  });

  test("a category with zero guides is never shown as an empty section", () => {
    renderSearch();
    // None of the fixture guides use "clients" -- its category header must
    // not appear at all.
    assert.equal(screen.queryByRole("heading", { name: "Clients" }), null);
  });

  test("each guide card links to /learn/[slug]", () => {
    renderSearch();
    const link = screen.getByText("How Alpha Works").closest("a");
    assert.equal(link?.getAttribute("href"), "/learn/alpha-guide");
  });

  test("each guide card shows its category and description alongside the title", () => {
    renderSearch();
    const card = screen.getByText("How Beta Works").closest("a")!;
    assert.ok(card.textContent?.includes("Job Tracking"));
    assert.ok(card.textContent?.includes("Everything about the beta feature."));
  });
});

describe("typing a query filters immediately", () => {
  test("a query matching one guide's title shows only that guide", async () => {
    renderSearch();
    const u = user();
    await u.type(screen.getByPlaceholderText("What do you want to learn?"), "Alpha");
    assert.ok(screen.getByText("How Alpha Works"));
    assert.equal(screen.queryByText("How Beta Works"), null);
    assert.equal(screen.queryByText("How Gamma Works"), null);
  });

  test("a query matching a keyword shared by no title/description still finds the right guide", async () => {
    renderSearch();
    const u = user();
    await u.type(screen.getByPlaceholderText("What do you want to learn?"), "payroll");
    assert.ok(screen.getByText("How Gamma Works"));
    assert.equal(screen.queryByText("How Alpha Works"), null);
  });

  test("search is case-insensitive", async () => {
    renderSearch();
    const u = user();
    await u.type(screen.getByPlaceholderText("What do you want to learn?"), "ALPHA");
    assert.ok(screen.getByText("How Alpha Works"));
  });

  test("while searching, category headers from browse mode are not shown -- results are a flat list", async () => {
    renderSearch();
    const u = user();
    await u.type(screen.getByPlaceholderText("What do you want to learn?"), "thing");
    // All three fixture guides match ("thing" is common to every keyword),
    // so their category badges are still visible on the result cards --
    // only the browse-mode <h2> section headers must be gone.
    assert.deepEqual(screen.queryAllByRole("heading", { level: 2 }), []);
    assert.ok(screen.getByText("How Alpha Works"));
    assert.ok(screen.getByText("How Beta Works"));
    assert.ok(screen.getByText("How Gamma Works"));
  });

  test("clearing the query back to empty returns to browse mode", async () => {
    renderSearch();
    const u = user();
    const input = screen.getByPlaceholderText("What do you want to learn?");
    await u.type(input, "Alpha");
    assert.equal(screen.queryByText("How Beta Works"), null);
    await u.clear(input);
    assert.ok(screen.getByText("How Alpha Works"));
    assert.ok(screen.getByText("How Beta Works"));
    assert.ok(screen.getByText("How Gamma Works"));
    assert.ok(screen.getByRole("heading", { name: "Scheduling & Calendar" }), "browse-mode category headers are back");
  });
});

describe("no-results state", () => {
  test("a query matching nothing shows the exact required message, and no guide cards", async () => {
    renderSearch();
    const u = user();
    await u.type(screen.getByPlaceholderText("What do you want to learn?"), "xyznonexistentquery");
    assert.ok(screen.getByText("No guides found. Try another search."));
    assert.equal(screen.queryByText("How Alpha Works"), null);
    assert.equal(screen.queryByText("How Beta Works"), null);
    assert.equal(screen.queryByText("How Gamma Works"), null);
  });
});
