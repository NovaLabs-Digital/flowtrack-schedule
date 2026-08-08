// Source-level proof for app/components/dashboard/IncomeProjection.tsx.
// This is a .tsx file; Node's built-in test runner cannot load .tsx
// directly -- matching the established convention (see
// app/components/dashboard/DispatchPanel.test.ts, app/signup/page.test.ts).
// The actual calculation this component displays is fully unit-tested in
// lib/incomeProjection.test.ts; this file proves the component wires that
// calculation up correctly and implements the show/hide privacy toggle
// safely.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./IncomeProjection.tsx", import.meta.url)), "utf8");
// Scoped to real code, not this file's own explanatory comments -- several
// of which legitimately mention "localStorage" and "company_settings" by
// name to document what this component deliberately does/doesn't touch.
const code = source.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

describe("IncomeProjection.tsx -- reuses the real calculation, never reimplements it inline", () => {
  test("imports and calls computeIncomeProjection and formatProjectedIncome from lib/incomeProjection", () => {
    assert.ok(source.includes('import { computeIncomeProjection, formatProjectedIncome } from "@/lib/incomeProjection";'));
    assert.ok(source.includes("computeIncomeProjection({"));
    assert.ok(source.includes("formatProjectedIncome(estimatedIncomeCents)"));
  });

  test("does not reimplement price summing, duration math, or cancelled/date filtering inline", () => {
    for (const forbidden of ["price_cents ??", "status === \"cancelled\"", "scheduledHours("]) {
      assert.ok(!source.includes(forbidden), `must not duplicate calculation logic (${forbidden})`);
    }
  });
});

describe("IncomeProjection.tsx -- card content and title", () => {
  test("titled exactly 'Projected Revenue' -- the approved user-facing name, not the internal 'Income Projection' component name", () => {
    assert.ok(source.includes(">Projected Revenue<"));
    assert.ok(!source.includes(">Income Projection<"), "the old user-facing title must not remain");
  });

  test("displays exactly the two required labels ('Estimated Revenue', 'Estimated Work Hours'), no others, and never the old 'Estimated Income' wording", () => {
    assert.ok(source.includes("Estimated Revenue"));
    assert.ok(source.includes("Estimated Work Hours"));
    assert.ok(!source.includes("Estimated Income"), "the old user-facing label must not remain");
    for (const forbidden of ["Profit", "Margin", "Average", "Expense"]) {
      assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `must not display a ${forbidden} metric`);
    }
  });

  test("Estimated Work Hours is suffixed with 'hrs', formatted to 2 decimal places, matching PayrollSummary's own convention", () => {
    assert.ok(source.includes("estimatedWorkHours.toFixed(2)} hrs"));
  });
});

describe("IncomeProjection.tsx -- green treatment, distinct from the neutral sidebar cards", () => {
  test("uses an emerald (green) border/background, not the neutral slate used by every other sidebar card", () => {
    assert.ok(source.includes("border-emerald-200"));
    assert.ok(source.includes("bg-emerald-50"));
  });

  test("keeps the same rounded-2xl/shadow-sm/shrink-0 card shape as the rest of the sidebar", () => {
    assert.ok(source.includes("rounded-2xl"));
    assert.ok(source.includes("shadow-sm"));
    assert.ok(source.includes("shrink-0"));
  });
});

describe("IncomeProjection.tsx -- show/hide privacy toggle", () => {
  test("has a toggle button with an accessible label that reflects its own current state, using the approved 'projected revenue' wording", () => {
    assert.ok(source.includes('aria-label={hidden ? "Show projected revenue" : "Hide projected revenue"}'));
    assert.ok(source.includes("aria-pressed={hidden}"));
  });

  test("hidden state conditionally renders a mask, not a CSS-hidden real value -- the real formatted value is absent from the DOM entirely when hidden", () => {
    assert.ok(source.includes('{hidden ? MASK : formatProjectedIncome(estimatedIncomeCents)}'));
    assert.ok(source.includes("{hidden ? MASK : `${estimatedWorkHours.toFixed(2)} hrs`}"));
    assert.ok(!source.includes("hidden\\:"), "must not rely on a CSS hidden-utility class that would leave the real value in the DOM");
  });

  test("toggling calls setHidden with the inverse of the current value", () => {
    assert.ok(source.includes("setHidden((h) => !h)"));
  });
});

describe("IncomeProjection.tsx -- localStorage persistence, hydration-safe", () => {
  test("uses a distinct, SFT-specific storage key, not a generic one", () => {
    assert.ok(source.includes('const VISIBILITY_STORAGE_KEY = "sft_income_projection_hidden";'));
  });

  test("never reads localStorage in a useState initializer -- only inside a useEffect, after mount", () => {
    assert.ok(!/useState\([^)]*localStorage/.test(source), "must not read localStorage directly inside useState(...)");
    const effectIdx = source.indexOf("useEffect(() => {");
    assert.notEqual(effectIdx, -1);
    const firstEffectBlock = source.slice(effectIdx, source.indexOf("}, []);", effectIdx));
    assert.ok(firstEffectBlock.includes("window.localStorage.getItem(VISIBILITY_STORAGE_KEY)"));
  });

  test("writes are gated behind a hydrated flag, so the initial read can never be clobbered by its own write effect", () => {
    assert.ok(source.includes("if (!hydrated) return;"));
    assert.ok(source.includes("setHydrated(true)"));
  });

  test("persists 'hidden' by setting the key, and clears it entirely (not just falsifying it) when shown again", () => {
    assert.ok(source.includes('window.localStorage.setItem(VISIBILITY_STORAGE_KEY, "true")'));
    assert.ok(source.includes("window.localStorage.removeItem(VISIBILITY_STORAGE_KEY)"));
  });

  test("uses window.localStorage, never bare localStorage (this file is a client component, but matches the established explicit convention)", () => {
    assert.ok(!/[^.]\blocalStorage\b/.test(code.replace(/window\.localStorage/g, "")), "expected every localStorage reference to be window-qualified");
  });
});

describe("IncomeProjection.tsx -- no database/company_settings/authorization changes", () => {
  test("makes no fetch call, no Supabase reference, no company_settings reference -- this is a purely local UI preference", () => {
    assert.ok(!code.includes("fetch("));
    assert.ok(!code.toLowerCase().includes("supabase"));
    assert.ok(!code.includes("company_settings"));
  });
});
