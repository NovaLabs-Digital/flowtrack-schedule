// Phase 5.7D-R19: tests for lib/teamColor.ts's validation, palette, and
// resolution rules -- the single source of truth shared by the
// create/update/manage-recurrence API routes and every schedule-rendering
// surface.
//
// Phase 5.7D-R19 launch-blocker fix: lib/teamColor.ts previously imported
// sortAssignmentsStable from lib/appointmentEmployees.ts, which also
// imports lib/supabaseAdmin.ts -- a module that constructs a real Supabase
// client at IMPORT time from process.env, requiring the mock/dynamic-import
// setup below (a static top-level `import` would be hoisted and evaluated
// before any process.env assignment in this file even runs). That import
// path caused the real production incident this fix corrects: any client
// component importing from lib/teamColor.ts pulled the server-only
// supabaseAdmin client into the browser bundle. sortAssignmentsStable now
// lives in lib/sortAssignmentsStable.ts, which has no Supabase/server
// dependency at all -- lib/teamColor.ts no longer transitively touches
// supabaseAdmin. The mock/dynamic-import setup below is kept as-is (still
// correct, still harmless) rather than changed as part of this urgent fix;
// no real Supabase call is reachable from any test in this file either way.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: () => { throw new Error("no Supabase call is expected in lib/teamColor.test.ts"); } } },
});

const {
  normalizeHexColor,
  isValidHexColor,
  validateTeamColorInput,
  buildTeamColorChoices,
  resolveTeamAccentColor,
  TEAM_COLOR_PALETTE,
} = await import("./teamColor.ts");

describe("normalizeHexColor / isValidHexColor -- strict #RRGGBB only", () => {
  test("accepts a valid uppercase hex value", () => {
    assert.equal(normalizeHexColor("#2563EB"), "#2563EB");
  });

  test("accepts a valid lowercase hex value and normalizes it to uppercase", () => {
    assert.equal(normalizeHexColor("#2563eb"), "#2563EB");
  });

  test("accepts a mixed-case hex value and normalizes it", () => {
    assert.equal(normalizeHexColor("#aAbBcC"), "#AABBCC");
  });

  test("rejects null/undefined/empty", () => {
    assert.equal(normalizeHexColor(null), null);
    assert.equal(normalizeHexColor(undefined), null);
    assert.equal(normalizeHexColor(""), null);
  });

  test("rejects shorthand 3-digit hex", () => {
    assert.equal(normalizeHexColor("#FFF"), null);
  });

  test("rejects a value with an alpha channel", () => {
    assert.equal(normalizeHexColor("#2563EBFF"), null);
  });

  test("rejects a hex value with no leading #", () => {
    assert.equal(normalizeHexColor("2563EB"), null);
  });

  test("rejects CSS color names", () => {
    assert.equal(normalizeHexColor("blue"), null);
    assert.equal(normalizeHexColor("red"), null);
  });

  test("rejects CSS functions", () => {
    assert.equal(normalizeHexColor("rgb(37, 99, 235)"), null);
    assert.equal(normalizeHexColor("rgba(37, 99, 235, 0.5)"), null);
  });

  test("rejects CSS variables", () => {
    assert.equal(normalizeHexColor("var(--brand-color)"), null);
  });

  test("rejects injection-like strings", () => {
    assert.equal(normalizeHexColor("javascript:alert(1)"), null);
    assert.equal(normalizeHexColor("<script>alert(1)</script>"), null);
    assert.equal(normalizeHexColor("#2563EB; color: red"), null);
  });

  test("rejects a malformed value with invalid hex digits", () => {
    assert.equal(normalizeHexColor("#GGGGGG"), null);
  });

  test("isValidHexColor mirrors normalizeHexColor's accept/reject decisions", () => {
    assert.equal(isValidHexColor("#2563EB"), true);
    assert.equal(isValidHexColor("#FFF"), false);
    assert.equal(isValidHexColor("blue"), false);
  });
});

describe("validateTeamColorInput -- server-side write validation", () => {
  test("null is always valid and explicitly clears", () => {
    assert.deepEqual(validateTeamColorInput(null), { ok: true, value: null });
  });

  test("a valid hex string is accepted and normalized", () => {
    assert.deepEqual(validateTeamColorInput("#2563eb"), { ok: true, value: "#2563EB" });
  });

  test("an invalid hex string is rejected", () => {
    const result = validateTeamColorInput("#FFF");
    assert.equal(result.ok, false);
  });

  test("a non-string, non-null value (number, object, array) is rejected", () => {
    assert.equal(validateTeamColorInput(42).ok, false);
    assert.equal(validateTeamColorInput({}).ok, false);
    assert.equal(validateTeamColorInput([]).ok, false);
  });

  test("a CSS name or function is rejected", () => {
    assert.equal(validateTeamColorInput("blue").ok, false);
    assert.equal(validateTeamColorInput("rgb(0,0,0)").ok, false);
  });
});

describe("buildTeamColorChoices -- employee colors + palette, deduplicated", () => {
  test("lists each assigned employee's own color first, labeled with their name", () => {
    const choices = buildTeamColorChoices([
      { name: "Teresa", color: "#111111" },
      { name: "Roxana", color: "#222222" },
    ]);
    assert.equal(choices[0].hex, "#111111");
    assert.equal(choices[0].label, "Teresa");
    assert.equal(choices[0].kind, "employee");
    assert.equal(choices[1].hex, "#222222");
    assert.equal(choices[1].label, "Roxana");
    assert.equal(choices[1].kind, "employee");
  });

  test("appends the full fixed palette after employee colors", () => {
    const choices = buildTeamColorChoices([{ name: "Teresa", color: "#111111" }]);
    const paletteChoices = choices.filter((c) => c.kind === "palette");
    assert.equal(paletteChoices.length, TEAM_COLOR_PALETTE.length);
  });

  test("drops a palette entry that exactly matches an employee's color (case-insensitive)", () => {
    const choices = buildTeamColorChoices([{ name: "Teresa", color: "#2563eb" }]);
    const paletteBlue = choices.filter((c) => c.kind === "palette" && c.hex === "#2563EB");
    assert.equal(paletteBlue.length, 0);
    const employeeBlue = choices.filter((c) => c.hex === "#2563EB");
    assert.equal(employeeBlue.length, 1);
    assert.equal(employeeBlue[0].kind, "employee");
  });

  test("drops a second employee sharing the exact same color as an earlier one", () => {
    const choices = buildTeamColorChoices([
      { name: "Teresa", color: "#111111" },
      { name: "Roxana", color: "#111111" },
    ]);
    const matching = choices.filter((c) => c.hex === "#111111");
    assert.equal(matching.length, 1);
    assert.equal(matching[0].label, "Teresa");
  });

  test("an employee with an invalid stored color is silently skipped, not shown as a choice", () => {
    const choices = buildTeamColorChoices([{ name: "Bad", color: "not-a-color" }]);
    assert.ok(!choices.some((c) => c.label === "Bad"));
  });

  test("no two choices in the returned list ever share the same hex", () => {
    const choices = buildTeamColorChoices([
      { name: "Teresa", color: "#2563EB" },
      { name: "Roxana", color: "#7C3AED" },
    ]);
    const hexes = choices.map((c) => c.hex);
    assert.equal(new Set(hexes).size, hexes.length);
  });
});

describe("resolveTeamAccentColor -- the shared 0/1/2+ resolution rule", () => {
  const teresa = { id: "a1", employee_id: "teresa", created_at: "2026-01-01T00:00:00.000Z" };
  const roxana = { id: "a2", employee_id: "roxana", created_at: "2026-01-01T00:00:01.000Z" };
  const employeeById = {
    teresa: { color: "#111111" },
    roxana: { color: "#222222" },
  };

  test("zero assignments returns null (caller uses its own unassigned appearance)", () => {
    assert.equal(resolveTeamAccentColor([], employeeById, null), null);
  });

  test("one assignment uses that employee's own color, ignoring any stored team_color", () => {
    assert.equal(resolveTeamAccentColor([teresa], employeeById, "#7C3AED"), "#111111");
  });

  test("two or more assignments with a valid team_color use it", () => {
    assert.equal(resolveTeamAccentColor([teresa, roxana], employeeById, "#7C3AED"), "#7C3AED");
  });

  test("two or more assignments with team_color null fall back to the first assignment's employee color, by stable order", () => {
    assert.equal(resolveTeamAccentColor([roxana, teresa], employeeById, null), "#111111");
  });

  test("two or more assignments with an invalid stored team_color safely fall back, never throwing or using the bad value", () => {
    assert.equal(resolveTeamAccentColor([teresa, roxana], employeeById, "not-a-color"), "#111111");
  });

  test("the fallback follows stable assignment order (earliest created_at), not array input order", () => {
    // roxana passed first in the array, but teresa's created_at is earlier.
    assert.equal(resolveTeamAccentColor([roxana, teresa], employeeById, undefined), "#111111");
  });

  test("a missing employee record resolves to null rather than throwing", () => {
    assert.equal(resolveTeamAccentColor([teresa], {}, null), null);
  });
});
