// ScheduleFlowTrack Learning Center -- Phase 1 guide data + search tests.
// Pure data/functions, no rendering involved -- a plain node:test file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  GUIDES,
  categoryName,
  getGuideBySlug,
  getGuidesByCategory,
  getRelatedGuides,
  searchGuides,
  type CategoryId,
} from "./learningCenter.ts";

describe("CATEGORIES -- the 10 declared Phase 1 categories", () => {
  test("exactly 10 categories, in the specified order", () => {
    assert.deepEqual(
      CATEGORIES.map((c) => c.name),
      [
        "Getting Started",
        "Scheduling & Calendar",
        "Clients",
        "Employees & Staff",
        "Job Tracking",
        "Worked Hours & Payroll",
        "Projected Revenue",
        "Notifications",
        "Mobile",
        "Settings",
      ]
    );
  });

  test("every category id is unique", () => {
    const ids = CATEGORIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("categoryName resolves a known id to its display name, and falls back to the id itself for an unknown one", () => {
    assert.equal(categoryName("worked-hours-payroll"), "Worked Hours & Payroll");
    assert.equal(categoryName("not-a-real-category" as CategoryId), "not-a-real-category");
  });
});

describe("GUIDES -- the 12 Phase 1 guides", () => {
  test("exactly 12 guides", () => {
    assert.equal(GUIDES.length, 12);
  });

  test("every guide has a non-empty slug, title, description, at least one keyword, and at least one step", () => {
    for (const g of GUIDES) {
      assert.ok(g.slug.trim().length > 0, `guide missing slug: ${JSON.stringify(g)}`);
      assert.ok(g.title.trim().length > 0, `${g.slug}: missing title`);
      assert.ok(g.description.trim().length > 0, `${g.slug}: missing description`);
      assert.ok(g.keywords.length > 0, `${g.slug}: no keywords`);
      assert.ok(g.steps.length > 0, `${g.slug}: no steps`);
    }
  });

  test("every guide slug is unique (this is also the URL segment: /learn/[slug])", () => {
    const slugs = GUIDES.map((g) => g.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });

  test("every guide's category is one of the 10 declared CATEGORIES", () => {
    const validIds = new Set(CATEGORIES.map((c) => c.id));
    for (const g of GUIDES) {
      assert.ok(validIds.has(g.category), `${g.slug}: category "${g.category}" is not declared in CATEGORIES`);
    }
  });

  test("every relatedSlugs entry refers to an existing guide -- no dangling references", () => {
    const validSlugs = new Set(GUIDES.map((g) => g.slug));
    for (const g of GUIDES) {
      for (const related of g.relatedSlugs ?? []) {
        assert.ok(validSlugs.has(related), `${g.slug}: relatedSlugs references unknown slug "${related}"`);
      }
    }
  });

  test("no guide lists itself as related", () => {
    for (const g of GUIDES) {
      assert.ok(!(g.relatedSlugs ?? []).includes(g.slug), `${g.slug} lists itself in relatedSlugs`);
    }
  });

  test("no guide has a video in Phase 1 (videoUrl and videoId both absent) -- video support exists but is unused until a real video is attached", () => {
    for (const g of GUIDES) {
      assert.equal(g.videoUrl, undefined, `${g.slug} unexpectedly has a videoUrl in Phase 1`);
      assert.equal(g.videoId, undefined, `${g.slug} unexpectedly has a videoId in Phase 1`);
    }
  });

  test("the exact 12 required Phase 1 guides exist, each in its required category", () => {
    const expected: Array<{ slug: string; category: CategoryId }> = [
      { slug: "create-appointment", category: "scheduling-calendar" },
      { slug: "move-reschedule-appointment", category: "scheduling-calendar" },
      { slug: "recurring-appointments", category: "scheduling-calendar" },
      { slug: "add-manage-clients", category: "clients" },
      { slug: "employee-start-complete-job", category: "job-tracking" },
      { slug: "employee-job-notes", category: "job-tracking" },
      { slug: "fix-forgotten-clock-out", category: "worked-hours-payroll" },
      { slug: "review-unusual-worked-time", category: "worked-hours-payroll" },
      { slug: "keep-time-as-is", category: "worked-hours-payroll" },
      { slug: "weekly-worked-hours-payroll", category: "worked-hours-payroll" },
      { slug: "projected-revenue", category: "projected-revenue" },
      { slug: "email-sms-notifications", category: "notifications" },
    ];
    for (const { slug, category } of expected) {
      const guide = getGuideBySlug(slug);
      assert.ok(guide, `expected a guide with slug "${slug}"`);
      assert.equal(guide!.category, category, `${slug} expected category "${category}", got "${guide!.category}"`);
    }
  });
});

describe("getGuideBySlug / getGuidesByCategory / getRelatedGuides", () => {
  test("getGuideBySlug returns the matching guide, or undefined for an unknown slug", () => {
    assert.equal(getGuideBySlug("projected-revenue")?.title, "How Projected Revenue Works");
    assert.equal(getGuideBySlug("does-not-exist"), undefined);
  });

  test("getGuidesByCategory returns only guides in that category", () => {
    const payrollGuides = getGuidesByCategory("worked-hours-payroll");
    assert.equal(payrollGuides.length, 4);
    assert.ok(payrollGuides.every((g) => g.category === "worked-hours-payroll"));
  });

  test("getGuidesByCategory returns an empty array for a category with no guides yet", () => {
    assert.deepEqual(getGuidesByCategory("mobile"), []);
    assert.deepEqual(getGuidesByCategory("settings"), []);
    assert.deepEqual(getGuidesByCategory("getting-started"), []);
    assert.deepEqual(getGuidesByCategory("employees-staff"), []);
  });

  test("getRelatedGuides resolves relatedSlugs to real Guide objects, in order", () => {
    const guide = getGuideBySlug("fix-forgotten-clock-out")!;
    const related = getRelatedGuides(guide);
    assert.deepEqual(
      related.map((g) => g.slug),
      guide.relatedSlugs
    );
  });

  test("getRelatedGuides returns an empty array when relatedSlugs is absent", () => {
    // Construct a minimal guide with no relatedSlugs at all rather than
    // relying on one happening to be missing from GUIDES.
    const noRelated = { ...getGuideBySlug("create-appointment")!, relatedSlugs: undefined };
    assert.deepEqual(getRelatedGuides(noRelated), []);
  });
});

describe("searchGuides -- client-side, case-insensitive, terminology-agnostic search", () => {
  test("search by title (partial, case-insensitive)", () => {
    const results = searchGuides("projected revenue");
    assert.ok(results.some((g) => g.slug === "projected-revenue"));
  });

  test("search by description", () => {
    // "master switch" appears only in email-sms-notifications' description.
    const results = searchGuides("master switch");
    assert.deepEqual(results.map((g) => g.slug), ["email-sms-notifications"]);
  });

  test("search by category name alone (a term that appears in NO guide's title/description/keywords, only in its category's display name)", () => {
    const results = searchGuides("scheduling");
    const slugs = results.map((g) => g.slug).sort();
    assert.deepEqual(slugs, ["create-appointment", "move-reschedule-appointment", "recurring-appointments"].sort());
  });

  test("search by tags/keywords (a term that appears only in a guide's keywords, not its title/description)", () => {
    // "biweekly" only appears in recurring-appointments' keywords.
    const results = searchGuides("biweekly");
    assert.deepEqual(results.map((g) => g.slug), ["recurring-appointments"]);
  });

  test("search is case-insensitive", () => {
    const upper = searchGuides("PAYROLL").map((g) => g.slug).sort();
    const lower = searchGuides("payroll").map((g) => g.slug).sort();
    const mixed = searchGuides("PayRoll").map((g) => g.slug).sort();
    assert.ok(upper.length > 0);
    assert.deepEqual(upper, lower);
    assert.deepEqual(upper, mixed);
  });

  test("no-results state: a query matching nothing returns an empty array", () => {
    assert.deepEqual(searchGuides("xyznonexistentquery123"), []);
  });

  test("an empty (or whitespace-only) query returns every guide -- this is what powers the browse (non-search) view", () => {
    assert.equal(searchGuides("").length, GUIDES.length);
    assert.equal(searchGuides("   ").length, GUIDES.length);
  });

  // The exact example queries from the Learning Center Phase 1 spec -- the
  // user should not need to know SFT's own terminology to find the right
  // guide.
  const EXAMPLES: Array<{ query: string; expectedSlug: string }> = [
    { query: "forgot clock out", expectedSlug: "fix-forgotten-clock-out" },
    { query: "wrong employee hours", expectedSlug: "fix-forgotten-clock-out" },
    { query: "recurring appointment", expectedSlug: "recurring-appointments" },
    { query: "projected revenue", expectedSlug: "projected-revenue" },
    { query: "add client", expectedSlug: "add-manage-clients" },
    { query: "SMS", expectedSlug: "email-sms-notifications" },
    { query: "employee notes", expectedSlug: "employee-job-notes" },
    { query: "payroll", expectedSlug: "weekly-worked-hours-payroll" },
    { query: "move appointment", expectedSlug: "move-reschedule-appointment" },
  ];
  for (const { query, expectedSlug } of EXAMPLES) {
    test(`"${query}" finds ${expectedSlug}`, () => {
      const slugs = searchGuides(query).map((g) => g.slug);
      assert.ok(slugs.includes(expectedSlug), `"${query}" -> [${slugs.join(", ")}] does not include "${expectedSlug}"`);
    });
  }
});
