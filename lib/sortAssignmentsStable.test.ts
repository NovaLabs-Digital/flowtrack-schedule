// Phase 5.7D-R19 launch-blocker fix: tests for lib/sortAssignmentsStable.ts.
// This file's own zero-dependency-ness is exactly what fixes the production
// incident (a client component pulling the server-only supabaseAdmin client
// into the /dashboard browser bundle via lib/appointmentEmployees.ts, which
// used to hold this function) -- so this file is loadable via a plain,
// ordinary static import, no env vars, no mocks, no Supabase reachable at
// all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sortAssignmentsStable } from "./sortAssignmentsStable.ts";

const source = fs.readFileSync(fileURLToPath(new URL("./sortAssignmentsStable.ts", import.meta.url)), "utf8");

describe("lib/sortAssignmentsStable.ts has no server-only or Supabase dependency (the actual production-incident fix)", () => {
  // Scoped to real import/code statements, not this file's own prose --
  // the header comment legitimately names "supabaseAdmin"/"process.env" by
  // name to explain what this file deliberately does NOT depend on.
  const codeLines = source.split("\n").filter((l) => !l.trim().startsWith("//"));
  const code = codeLines.join("\n");

  test("no Supabase import of any kind", () => {
    assert.ok(!code.includes("supabaseAdmin"));
    assert.ok(!code.includes("@supabase/supabase-js"));
    assert.ok(!/from\s+["']@\/lib\/supabase/.test(code));
  });

  test("no server-only import (env vars, fs, or any @/lib module known to touch Supabase)", () => {
    assert.ok(!code.includes("process.env"));
    assert.ok(!/from\s+["']@\/lib\/appointmentEmployees["']/.test(code));
  });

  test("the only non-type-only import is the AppointmentEmployeeAssignment type (erased at build time, zero runtime dependency)", () => {
    const importLines = source.split("\n").filter((l) => l.trim().startsWith("import "));
    assert.equal(importLines.length, 1);
    assert.ok(importLines[0].startsWith("import type "), `expected a type-only import, got: ${importLines[0]}`);
  });
});

describe("sortAssignmentsStable -- exact behavior preserved from the pre-fix implementation", () => {
  test("orders by created_at ascending", () => {
    const a = { id: "a", created_at: "2026-01-01T00:00:01.000Z" };
    const b = { id: "b", created_at: "2026-01-01T00:00:00.000Z" };
    assert.deepEqual(sortAssignmentsStable([a, b]).map((x) => x.id), ["b", "a"]);
  });

  test("breaks a created_at tie by id ascending, not employee_id or input order", () => {
    const a = { id: "zzz", created_at: "2026-01-01T00:00:00.000Z" };
    const b = { id: "aaa", created_at: "2026-01-01T00:00:00.000Z" };
    assert.deepEqual(sortAssignmentsStable([a, b]).map((x) => x.id), ["aaa", "zzz"]);
  });

  test("does not mutate the input array", () => {
    const a = { id: "z", created_at: "2026-01-01T00:00:01.000Z" };
    const b = { id: "a", created_at: "2026-01-01T00:00:00.000Z" };
    const input = [a, b];
    const result = sortAssignmentsStable(input);
    assert.deepEqual(input, [a, b], "input array order must be unchanged");
    assert.notEqual(result, input, "must return a new array, not the same reference");
  });

  test("an empty array returns an empty array", () => {
    assert.deepEqual(sortAssignmentsStable([]), []);
  });

  test("a single-element array is returned unchanged", () => {
    const a = { id: "a", created_at: "2026-01-01T00:00:00.000Z" };
    assert.deepEqual(sortAssignmentsStable([a]), [a]);
  });

  test("three items with mixed ties sort correctly", () => {
    const items = [
      { id: "c", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "a", created_at: "2026-01-02T00:00:00.000Z" },
      { id: "b", created_at: "2026-01-01T00:00:00.000Z" },
    ];
    assert.deepEqual(sortAssignmentsStable(items).map((x) => x.id), ["b", "c", "a"]);
  });
});
