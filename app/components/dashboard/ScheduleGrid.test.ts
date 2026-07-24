// Phase 5.5E-E1B: ScheduleGrid.tsx is a .tsx file and cannot be loaded by
// Node's built-in test runner (this repo's only test runner) -- the same
// limitation documented in AppointmentModal.test.ts, AppointmentDetailPanel.
// test.ts, and MoveConfirmDialog.test.ts.
//
// A SECOND, independent limitation applies specifically to this file's
// drag-and-drop behavior: even if ScheduleGrid.tsx could be rendered, native
// HTML5 drag-and-drop (draggable/onDragStart/onDragOver/onDrop, using the
// browser's DataTransfer object) is not implemented by jsdom and is not
// meaningfully simulated by @testing-library/user-event -- there is no
// dragstart/dragover/drop sequence this repo's test stack can dispatch that
// exercises real browser drag semantics. This is a structural limitation of
// the test environment, not something a differently-written test could work
// around. Real drag-and-drop behavior (can a restricted card be picked up,
// does a blocked drag ever reach a drop target) has NOT been executed by any
// test in this repository, before or after this phase, and this file does
// not claim otherwise.
//
// What this file DOES prove, by source inspection: the `draggable` attribute
// and every drag event handler (onDragStart/onDragEnd/onDragOver/
// onDragLeave/onDrop) are wired to the SAME combined boolean
// (dragMutationEnabled = dragEnabled && canMutateOperationalData) rather
// than the pre-existing dragEnabled alone, and that handleDrop -- the one
// function that actually calls the mutation callback -- has its own
// independent guard as a second, defense-in-depth line of protection against
// stale state or a hypothetical direct call. Combined with
// CapabilityGatedButton.test.ts's real interaction proof for the shared
// primitive (used elsewhere in this phase, not by this file, since drag
// mechanics are not a <button> and must not be forced through it per this
// phase's explicit instructions), this is the strongest proof available
// within this repository's existing test architecture without introducing a
// new dependency or rewriting a large, established production file --
// neither of which this phase authorizes.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  fileURLToPath(new URL("./ScheduleGrid.tsx", import.meta.url)),
  "utf8"
);
const shellSource = fs.readFileSync(
  fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)),
  "utf8"
);

describe("prop wiring", () => {
  test("the prop-destructuring parameter list includes canMutateOperationalData", () => {
    assert.match(source, /^\s*canMutateOperationalData,$/m);
  });

  test("the type annotation includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to ScheduleGrid", () => {
    const idx = shellSource.indexOf("<ScheduleGrid");
    assert.notEqual(idx, -1, "ScheduleGrid must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });
});

describe("dragMutationEnabled derivation", () => {
  test("dragMutationEnabled is derived from dragEnabled && canMutateOperationalData", () => {
    assert.ok(source.includes("const dragMutationEnabled = dragEnabled && canMutateOperationalData;"));
  });

  test("dragEnabled itself is unchanged (still !!onDropAppointment) -- the new gate is additive, not a replacement of the existing prop-presence check", () => {
    assert.ok(source.includes("const dragEnabled = !!onDropAppointment;"));
  });
});

describe("drag-initiation boundary (the appointment card)", () => {
  test("draggable uses dragMutationEnabled, not the raw dragEnabled", () => {
    assert.ok(source.includes("draggable={dragMutationEnabled}"));
    assert.ok(!source.includes("draggable={dragEnabled}"));
  });

  test("onDragStart is gated on dragMutationEnabled", () => {
    assert.match(source, /onDragStart=\{dragMutationEnabled \? \(e\) => \{/);
  });

  test("onDragEnd is gated on dragMutationEnabled", () => {
    assert.match(source, /onDragEnd=\{dragMutationEnabled \? \(\) => \{ setDraggingId\(null\); setDragOverCell\(null\); \} : undefined\}/);
  });

  test("the grab-cursor styling (cursor-grab active:cursor-grabbing) is also gated on dragMutationEnabled, so a restricted card gives no visual affordance suggesting it can be dragged", () => {
    assert.ok(source.includes('dragMutationEnabled ? "cursor-grab active:cursor-grabbing" : "",'));
  });

  test("card selection (onClick -> onSelectAppointment) and edit (onDoubleClick -> onEditAppointment) remain unconditional -- read-only interactions are never gated", () => {
    assert.ok(source.includes("onClick={(e) => { e.stopPropagation(); onSelectAppointment(a.id); }}"));
    assert.ok(source.includes("onDoubleClick={(e) => { e.stopPropagation(); onEditAppointment?.(a.id); }}"));
  });
});

describe("drop-target boundary (the quarter-hour grid cells)", () => {
  test("onDragOver is gated on dragMutationEnabled, not the raw dragEnabled", () => {
    assert.match(source, /onDragOver=\{dragMutationEnabled \? \(e\) => \{/);
    assert.ok(!/onDragOver=\{dragEnabled \?/.test(source));
  });

  test("onDragLeave is gated on dragMutationEnabled", () => {
    assert.match(source, /onDragLeave=\{dragMutationEnabled \? \(\) => \{/);
    assert.ok(!/onDragLeave=\{dragEnabled \?/.test(source));
  });

  test("onDrop is gated on dragMutationEnabled", () => {
    assert.match(source, /onDrop=\{dragMutationEnabled \? \(e\) => \{/);
    assert.ok(!/onDrop=\{dragEnabled \?/.test(source));
  });

  test("onClick (cell click, opens the already-governed create-appointment modal) remains unconditional", () => {
    const idx = source.indexOf("onClick={() => {");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 200);
    assert.ok(block.includes("onCellClick(d, h, min)"));
    assert.ok(!block.includes("canMutateOperationalData"));
  });
});

describe("handleDrop defense-in-depth guard", () => {
  test("handleDrop guards on canMutateOperationalData before reading draggingId or calling onDropAppointment", () => {
    const fnStart = source.indexOf("function handleDrop(day: Date, hour: number, minute: number)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const onDropCallIdx = source.indexOf("onDropAppointment(id,", fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < onDropCallIdx, "guard must run before the mutation callback is invoked");
  });

  test("the guard clears dragOverCell/draggingId state before returning, so a blocked drop leaves no stale drag-over highlight", () => {
    const fnStart = source.indexOf("function handleDrop(day: Date, hour: number, minute: number)");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const before = source.slice(fnStart, guardIdx);
    assert.ok(before.includes("setDragOverCell(null);"));
    assert.ok(before.includes("setDraggingId(null);"));
  });
});

describe("no per-card restricted notice duplicated", () => {
  test("this file contains no restricted-notice wording or id -- ScheduleGrid silently disables drag capability without rendering explanatory text on every card", () => {
    assert.ok(!source.includes("Changes are temporarily unavailable"));
    assert.ok(!source.includes("RESTRICTED_NOTICE_ID"));
    assert.ok(!source.includes("RESTRICTED_WORDING"));
  });

  test("this file does not import CapabilityGatedButton -- drag mechanics are non-button interactions and must not be forced through the button primitive", () => {
    assert.ok(!source.includes("CapabilityGatedButton"));
  });
});

describe("read-only schedule navigation and appointment visibility remain available", () => {
  test("appointments remain rendered (no conditional wrapping the appointment-card return block on canMutateOperationalData)", () => {
    const returnIdx = source.indexOf("return dayAppts.map((a) => {");
    assert.notEqual(returnIdx, -1);
    const blockEnd = source.indexOf("});", returnIdx);
    const block = source.slice(returnIdx, blockEnd);
    // The only two legitimate mentions inside the per-card render are the
    // draggable/onDragStart/onDragEnd/cursor wiring already asserted above;
    // this test additionally confirms the early-return visibility guard
    // (`if (apptHour < startHour ...) return null;`) is unchanged and has no
    // new canMutateOperationalData branch added to it.
    assert.ok(block.includes("if (apptHour < startHour || apptHour > endHour) return null;"));
    const earlyReturnIdx = block.indexOf("if (apptHour < startHour");
    const earlyReturnLine = block.slice(earlyReturnIdx, earlyReturnIdx + 100);
    assert.ok(!earlyReturnLine.includes("canMutateOperationalData"));
  });

  test("the day/time grid header, hour labels, and cell click-to-create targets are rendered unconditionally", () => {
    assert.ok(!/\{canMutateOperationalData && \(/.test(source), "no top-level block should be hidden entirely behind this flag -- only drag affordances are disabled");
  });
});

describe("no leaked internal detail", () => {
  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode", "OwnerBillingBanner",
    ]) {
      assert.ok(!source.includes(forbidden), `ScheduleGrid.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `ScheduleGrid.tsx must not contain "${forbidden}"`);
    }
  });
});
