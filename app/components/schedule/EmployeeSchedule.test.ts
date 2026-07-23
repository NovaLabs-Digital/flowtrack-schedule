// Phase 5.5E-D: source-level proof tests for EmployeeSchedule.tsx.
//
// EmployeeSchedule.tsx is a real .tsx/JSX file, and Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content -- confirmed empirically again in this phase
// (the same "Unknown file extension \".tsx\"" failure first documented in
// Phase 5.5D). It is also a large, pre-existing production component (day
// navigation, appointment list, worked-hours display, logout) that this
// phase deliberately does not rewrite to .ts/React.createElement just to
// make it renderable -- that would be a large, out-of-scope diff. The one
// control this phase actually governs (Start/Complete) was extracted into
// EmployeeJobActionButton.ts specifically so it COULD get real rendered
// mouse/keyboard interaction tests (see EmployeeJobActionButton.test.ts,
// 20 tests, full jsdom + @testing-library/react + @testing-library/
// user-event coverage).
//
// What remains -- proving THIS file (a) doesn't gate schedule/worked-hours
// visibility on entitlement, (b) wires entitlement.canUseJobTracking into
// the extracted button correctly, and (c) never renders owner billing UI --
// cannot be proven by rendering, so it's proven here by inspecting the
// actual shipped source text. This is a documented, explained choice, not
// a fragile substitute reached for without reason: every assertion below
// anchors to an exact, copy-pasted literal from the real file, so a change
// to the real behavior (not just cosmetic reformatting) is what would break
// it. No real Supabase/Stripe/Twilio/Resend/network call is reachable --
// this file reads no external state, and doesn't even import React.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./EmployeeSchedule.tsx", import.meta.url)), "utf8");

describe("entitlement is read and wired into the extracted job-action control, nowhere else", () => {
  test("the component destructures entitlement from its props", () => {
    assert.ok(source.includes("lastWeekHours, entitlement }: Props)"));
  });

  test("EmployeeJobActionButton receives canUseJobTracking={entitlement.canUseJobTracking}", () => {
    assert.ok(source.includes("canUseJobTracking={entitlement.canUseJobTracking}"));
  });

  test("EmployeeJobActionButton is imported from the dedicated extracted component, not defined inline", () => {
    assert.ok(source.includes('import EmployeeJobActionButton from "@/app/components/schedule/EmployeeJobActionButton";'));
  });

  test("no other reference to entitlement exists outside the one prop pass-through (no duplicated entitlement policy in this file)", () => {
    const count = source.split("entitlement").length - 1;
    // Exactly four occurrences: the "@/lib/entitlementView" import path,
    // the Props type field, the destructured parameter, and the one
    // canUseJobTracking pass-through above -- any more would mean a
    // second, undocumented use of the projection crept into this file.
    assert.equal(count, 4, `expected exactly 4 references to "entitlement", found ${count}`);
  });
});

describe("schedule and worked-hours reads are never gated by entitlement", () => {
  test("the 'My Worked Hours' block renders unconditionally (thisWeekHours/lastWeekHours are not wrapped in an entitlement check)", () => {
    const heading = source.indexOf("My Worked Hours");
    assert.ok(heading > -1);
    // No `entitlement` reference between the two nearest conditional
    // wrappers around this block and the heading itself -- i.e. nothing
    // upstream of it depends on canUseJobTracking.
    const nearestConditionalAbove = source.lastIndexOf("{dayAppts.length === 0", heading);
    const between = source.slice(0, heading);
    assert.ok(!between.includes("entitlement.canUseJobTracking &&"));
    assert.ok(nearestConditionalAbove === -1 || nearestConditionalAbove < heading);
  });

  test("the appointment list (dayAppts) is rendered independent of entitlement -- only isCompleted gates the job-action control itself", () => {
    assert.ok(source.includes("dayAppts.map((a) => {"));
    assert.ok(source.includes("{!isCompleted && ("), "only completion status gates the job-action control, not entitlement");
  });

  test("scheduled/started/completed timestamps, client info, and notes render unconditionally on entitlement", () => {
    for (const marker of ["Scheduled: {formatTime(start)}", "{client && (", "{a.notes && ("]) {
      assert.ok(source.includes(marker), `expected to find "${marker}"`);
    }
  });
});

describe("no owner billing UI is ever rendered to an employee", () => {
  test("OwnerBillingBanner is never imported or referenced", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no subscription/billing/Stripe/plan wording appears anywhere in this file", () => {
    for (const forbidden of ["Subscription", "subscription", "Billing", "billing", "Stripe", "stripe", "Plan &", "grace period", "checkout", "portal"]) {
      assert.ok(!source.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });
});

describe("manual worked-hours submission is not an employee control (owner-only, per inspection)", () => {
  test("no manual-hours submission fetch or form exists in this file", () => {
    assert.ok(!source.includes("/api/appointments/employee-hours"));
    assert.ok(!source.includes("EmployeeHoursSection"));
  });

  test("the only worked-hours UI in this file is the existing read-only 'My Worked Hours' summary", () => {
    assert.ok(source.includes("formatHoursAsDuration(thisWeekHours)"));
    assert.ok(source.includes("formatHoursAsDuration(lastWeekHours)"));
  });
});

describe("the extracted button remains the sole owner of Start/Complete rendering", () => {
  test("no inline 'Start Job' / 'Complete Job' button markup remains in this file (fully delegated to EmployeeJobActionButton)", () => {
    assert.ok(!source.includes(">Start Job<"));
    assert.ok(!source.includes(">Complete Job<"));
    assert.ok(!source.includes('"Starting..." : "Start Job"'));
  });

  test("handleJobAction (the fetch to /api/appointments/job) is unchanged and only reachable via the extracted button's onActivate", () => {
    assert.ok(source.includes('fetch("/api/appointments/job"'));
    assert.ok(source.includes("onActivate={() => handleJobAction(a.id, !isStarted ? \"start\" : \"complete\")}"));
  });
});
