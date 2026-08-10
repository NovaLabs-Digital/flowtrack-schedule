// Block 2B: source-level proof tests for RecurringSeriesPanel.tsx. Like
// every other dashboard .tsx production file in this repo, this cannot be
// loaded by Node's built-in test runner -- these tests prove what source
// inspection can prove: which endpoints are called, which fields gate the
// Activate control, and the structural absence of anything out of scope
// (no appointment create/update/cancel call anywhere in this file).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./RecurringSeriesPanel.tsx", import.meta.url)), "utf8");

describe("RecurringSeriesPanel -- data source and mutation surface", () => {
  test("loads the review queue from GET /api/recurring-series", () => {
    assert.ok(source.includes('fetch("/api/recurring-series")'));
  });

  test("activation posts to /api/recurring-series/activate with series_id and template_appointment_id", () => {
    assert.ok(source.includes('fetch("/api/recurring-series/activate"'));
    assert.ok(source.includes("series_id: s.id"));
    assert.ok(source.includes("template_appointment_id: templateAppointmentId"));
  });

  test("never calls any appointment create/update/delete/cancel endpoint -- review must never mutate an appointment", () => {
    for (const forbidden of [
      "/api/appointments/create",
      "/api/appointments/update",
      "/api/appointments/delete",
      "/api/appointments/manage-recurrence",
    ]) {
      assert.ok(!source.includes(forbidden), `must not reference ${forbidden}`);
    }
  });

  test("uses CapabilityGatedButton for the Activate control, matching the established capability-gating pattern", () => {
    assert.ok(source.includes('import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";'));
    assert.ok(source.includes("<CapabilityGatedButton"));
  });
});

describe("RecurringSeriesPanel -- activation is disabled for series that must never activate accidentally", () => {
  test("canActivate requires hasLiveOccurrences, a non-inactive/archived client, and is_demo=false, in addition to canMutateOperationalData", () => {
    assert.match(
      source,
      /const canActivate =\s*\n\s*canMutateOperationalData && s\.hasLiveOccurrences && !s\.clientInactiveOrArchived && !s\.isDemo;/
    );
  });

  test("the template-selection dropdown is disabled whenever canActivate is false", () => {
    assert.ok(source.includes("disabled={!canActivate}"));
  });
});

describe("RecurringSeriesPanel -- no silent guessing of activation intent", () => {
  test("the owner must explicitly choose/confirm a template appointment via a <select>, never an auto-submitted default", () => {
    assert.ok(source.includes("<select"));
    assert.ok(source.includes("onChange={(e) => setSelectedTemplate"));
  });

  test("blocker codes returned by the API are translated into plain-language reasons, not swallowed silently", () => {
    assert.ok(source.includes("BLOCKER_LABELS"));
    assert.ok(source.includes("data.blockers"));
  });
});
