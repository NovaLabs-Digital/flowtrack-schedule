// Phase 5.7D-R19: MobileSchedule.tsx is a .tsx file and cannot be loaded by
// Node's built-in test runner -- the same limitation documented throughout
// this repo's other .tsx production files. This file proves what source
// inspection can prove: the Schedule (Agenda List) tab resolves the same
// shared Team Color accent as the Today screen (MobileDashboard.tsx) and
// desktop (ScheduleGrid.tsx), never a locally re-derived rule.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileSchedule.tsx", import.meta.url)), "utf8");

describe("Phase 5.7D-R19: Team Color accent on the Schedule (Agenda List) tab (source-level proof)", () => {
  test("employeesFor uses the shared sortAssignmentsStable helper for stable assignment order", () => {
    // Phase 5.7D-R19 launch-blocker fix: sortAssignmentsStable now lives in
    // lib/sortAssignmentsStable.ts, which has no Supabase/server-only
    // import -- see that file's own header comment. Importing it from
    // lib/appointmentEmployees.ts (which does import the server-only
    // supabaseAdmin client) pulled that client into this client
    // component's browser bundle and crashed /dashboard in production.
    assert.ok(source.includes('import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";'));
    assert.ok(!source.includes('from "@/lib/appointmentEmployees"'), "must never import from the server-only appointmentEmployees module");
    const fnIdx = source.indexOf("function employeesFor(apptId: string): Employee[] {");
    assert.ok(fnIdx > -1);
    const body = source.slice(fnIdx, source.indexOf("\n  }", fnIdx));
    assert.ok(body.includes("sortAssignmentsStable(assignmentsFor(apptId))"));
  });

  test("accentColorFor resolves through the shared resolveTeamAccentColor rule, never a locally re-derived one", () => {
    assert.ok(source.includes('import { resolveTeamAccentColor } from "@/lib/teamColor";'));
    const fnIdx = source.indexOf("function accentColorFor(appt: Appointment): string | null {");
    assert.ok(fnIdx > -1);
    const body = source.slice(fnIdx, source.indexOf("\n  }", fnIdx));
    assert.ok(body.includes("resolveTeamAccentColor(assignmentsFor(appt.id), employeeById, appt.team_color)"));
  });

  test("the MobileAppointmentCard usage passes accentColor={accentColorFor(a)}", () => {
    const cardUsageIdx = source.indexOf("<MobileAppointmentCard");
    assert.ok(cardUsageIdx > -1);
    const cardUsageEnd = source.indexOf("/>", cardUsageIdx);
    const jsx = source.slice(cardUsageIdx, cardUsageEnd);
    assert.ok(jsx.includes("accentColor={accentColorFor(a)}"));
  });
});
