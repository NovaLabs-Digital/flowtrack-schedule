// Phase 5.7D-R19: MobileAppointmentCard.tsx is a .tsx file and cannot be
// loaded by Node's built-in test runner (this repo's only test runner) --
// the same limitation documented throughout this repo's other .tsx
// production files. This file proves what source inspection can prove: the
// new accentColor prop's fallback chain, and that it never regresses the
// pre-R19 unassigned-appointment appearance.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileAppointmentCard.tsx", import.meta.url)), "utf8");

describe("Phase 5.7D-R19: accentColor prop -- employee/team accent with a service-tint fallback (source-level proof)", () => {
  test("Props declares accentColor: string | null, documented as resolved via lib/teamColor.ts", () => {
    assert.ok(source.includes("accentColor: string | null;"));
  });

  test("the component destructures accentColor from its props", () => {
    assert.ok(source.includes("export default function MobileAppointmentCard({ appointment, client, employees, accentColor, serviceColor, durationMinutes, onTap, timezone }: Props) {"));
  });

  test("the left accent bar prefers accentColor, falling back to serviceColor, then the pre-existing gray default -- exact same fallback chain and default color as before this phase", () => {
    assert.ok(source.includes('style={{ backgroundColor: accentColor ?? serviceColor ?? "#94a3b8" }}'));
  });

  test("employees are still listed as plain text -- this phase does not add per-employee coloring to the mobile card (desktop-only, see ScheduleGrid.tsx)", () => {
    assert.ok(source.includes('{employees.map((e) => e.name).join(", ")}'));
  });
});

describe("Phase 5C: workspace-timezone-aware time label", () => {
  test("Props declares timezone: string, and the displayed start time is resolved via toBusinessLocal with the explicit prop", () => {
    assert.ok(source.includes("timezone: string;"));
    assert.ok(source.includes("const start = toBusinessLocal(appointment.scheduled_for, timezone);"));
  });
});
