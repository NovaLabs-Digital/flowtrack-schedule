// Proves the guided tour was updated (not redesigned) to introduce the
// features that shipped after the original storyboard: Projected Revenue,
// Weekly Worked Hours, Employee Worked Hours, and Job Tracking. All four
// live in the same right-hand dispatch sidebar, so this is one added step,
// not four — see the "dispatch-insights" comment in demoExperienceSteps.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_EXPERIENCE_STEPS } from "./demoExperienceSteps";

const shellSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/DashboardShell.tsx", import.meta.url)),
  "utf8"
);
const overlaySource = fs.readFileSync(
  fileURLToPath(new URL("./DemoExperienceOverlay.tsx", import.meta.url)),
  "utf8"
);

describe("DEMO_EXPERIENCE_STEPS -- existing storyboard order is preserved", () => {
  test("original 10 steps remain, in their original order, untouched by the update", () => {
    const ids = DEMO_EXPERIENCE_STEPS.map((s) => s.id);
    assert.deepEqual(ids, [
      "welcome",
      "schedule",
      "appointment-details",
      "dispatch-insights",
      "edit-service",
      "clients",
      "employees",
      "services",
      "add-appointment",
      "mobile-experience",
      "completion",
    ]);
  });

  test("exactly one new step was added", () => {
    assert.equal(DEMO_EXPERIENCE_STEPS.length, 11);
  });
});

describe("dispatch-insights -- the new step introducing Projected Revenue / Weekly Worked Hours / Employee Worked Hours / Job Tracking", () => {
  const step = DEMO_EXPERIENCE_STEPS.find((s) => s.id === "dispatch-insights");

  test("exists, placed right after Appointment Details (same visual area, appointment already selected)", () => {
    assert.ok(step);
    const idx = DEMO_EXPERIENCE_STEPS.indexOf(step!);
    assert.equal(DEMO_EXPERIENCE_STEPS[idx - 1].id, "appointment-details");
  });

  test("mentions all four features by name", () => {
    for (const feature of ["Projected Revenue", "Weekly Worked Hours", "Employee Worked Hours", "Job Tracking"]) {
      assert.ok(step!.body.includes(feature), `body must mention ${feature}`);
    }
  });

  test("targets the dispatch sidebar, matching the real DOM hook added to DashboardShell.tsx", () => {
    assert.equal(step!.targetSelector, '[data-tour="dispatch-sidebar"]');
  });

  test("is a view-only step (no required action), matching Welcome/Completion's own non-blocking style -- these are read-only cards, there is no natural single action to require", () => {
    assert.equal(step!.actionRequired, false);
    assert.equal(step!.actionId, undefined);
  });
});

describe("DashboardShell.tsx -- carries the real data-tour hook the new step targets", () => {
  test('the dispatch sidebar <aside> carries data-tour="dispatch-sidebar"', () => {
    assert.ok(shellSource.includes('<aside data-tour="dispatch-sidebar"'));
  });
});

describe("DemoExperienceOverlay.tsx -- completion checklist reflects the new step", () => {
  test('the "Today you" checklist includes the revenue/worked-hours item', () => {
    assert.ok(overlaySource.includes("Reviewed revenue &amp; worked hours"));
  });
});
