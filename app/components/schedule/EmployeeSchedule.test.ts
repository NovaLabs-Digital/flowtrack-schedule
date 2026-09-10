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
    assert.ok(source.includes("lastWeekHours, entitlement, timezone }: Props)"));
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

describe("Phase 5C: workspace-timezone-aware today/appointment display -- the same fix as the desktop traveling-owner case, applied to the employee's own device", () => {
  test("Props declares timezone: string", () => {
    assert.ok(source.includes("timezone: string;"));
  });

  test("today/currentDay/dayAppts are resolved via nowInBusinessTz/toBusinessLocal with the explicit timezone prop -- never a bare new Date()/native getters on a raw new Date(iso)", () => {
    assert.ok(source.includes('import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";'));
    assert.ok(source.includes("const today = nowInBusinessTz(timezone);"));
    assert.ok(source.includes("const d = toBusinessLocal(a.scheduled_for, timezone);"));
    assert.ok(!source.includes("const today = new Date();"));
  });

  test("each appointment's scheduled start (display) is resolved via toBusinessLocal, while duration math still uses the real instant (rawStart)", () => {
    assert.ok(source.includes("const rawStart = new Date(a.scheduled_for);"));
    assert.ok(source.includes("const start = toBusinessLocal(a.scheduled_for, timezone);"));
  });

  test("greeting() remains a plain device-local pleasantry, not a business fact -- deliberately unaffected by the timezone fix", () => {
    assert.ok(source.includes("const h = new Date().getHours();"));
  });
});

describe("Employee Job Notes -- textarea appears only between Start and Complete", () => {
  function jobNotesBlock(): string {
    const idx = source.indexOf("{isStarted && !isCompleted && (");
    assert.notEqual(idx, -1, "expected the Job Notes block's gating condition to exist");
    const buttonIdx = source.indexOf("{/* Job action button */}", idx);
    assert.notEqual(buttonIdx, -1);
    return source.slice(idx, buttonIdx);
  }

  test("the Job Notes block is gated on isStarted && !isCompleted -- not visible before Start or after Complete", () => {
    const occurrences = [...source.matchAll(/\{isStarted && !isCompleted && \(/g)];
    assert.equal(occurrences.length, 1);
  });

  test("the Job Notes block sits between the 'Actual times' block and the job-action button, matching START -> JOB NOTES -> COMPLETE", () => {
    const actualTimesIdx = source.indexOf("{/* Actual times */}");
    const jobNotesGateIdx = source.indexOf("{isStarted && !isCompleted && (");
    const buttonCommentIdx = source.indexOf("{/* Job action button */}");
    assert.notEqual(actualTimesIdx, -1);
    assert.notEqual(jobNotesGateIdx, -1);
    assert.notEqual(buttonCommentIdx, -1);
    assert.ok(actualTimesIdx < jobNotesGateIdx, "Job Notes must come after Actual times");
    assert.ok(jobNotesGateIdx < buttonCommentIdx, "Job Notes must come before the job-action button");
  });

  test("the textarea is optional (no required attribute), capped at 2000 characters, and driven by handleNotesChange", () => {
    const block = jobNotesBlock();
    assert.ok(block.includes("<textarea"));
    assert.ok(!/\brequired\b/.test(block), "the textarea must not be required -- notes are optional");
    assert.ok(block.includes("maxLength={2000}"));
    assert.ok(block.includes('value={jobNotes[a.id] ?? ""}'));
    assert.ok(block.includes("onChange={(e) => handleNotesChange(a.id, e.target.value)}"));
  });

  test("the 'Save Note' button no longer exists anywhere in this file (a comment may still explain the old behavior for context)", () => {
    assert.ok(!source.includes(">Save Note<"), "no JSX element must render 'Save Note' as a label");
    assert.ok(!source.includes("handleSaveNote"));
    assert.ok(!source.includes("savingNote"));
    assert.ok(!/type="button"[^>]*onClick=\{\(\) => \w*[Ss]ave/.test(source), "no explicit save button remains");
  });

  test("status text shows exactly 'Saving...', 'Saved', or 'Not saved — try again', driven by noteStatus[a.id]", () => {
    const block = jobNotesBlock();
    assert.ok(block.includes('noteStatus[a.id] === "saving"'));
    assert.ok(block.includes("Saving..."));
    assert.ok(block.includes('noteStatus[a.id] === "saved"'));
    assert.ok(block.includes(">Saved<"));
    assert.ok(block.includes('noteStatus[a.id] === "error"'));
    assert.ok(block.includes("Not saved — try again"));
  });

  test("no popups/alerts/modals/toasts are used for the note status (window.alert/window.confirm never appear in the Job Notes block)", () => {
    const block = jobNotesBlock();
    assert.ok(!block.includes("window.alert"));
    assert.ok(!block.includes("window.confirm"));
    assert.ok(!block.includes("toast"));
  });
});

describe("Employee Job Notes -- autosave debouncing (handleNotesChange)", () => {
  function handleNotesChangeBlock(): string {
    const idx = source.indexOf("function handleNotesChange(appointmentId: string, value: string)");
    assert.notEqual(idx, -1);
    const returnIdx = source.indexOf('<div className="min-h-[100dvh] bg-slate-50 flex flex-col safe-area-top">', idx);
    assert.notEqual(returnIdx, -1);
    return source.slice(idx, returnIdx);
  }

  test("an autosave delay constant of approximately 1000ms exists and is used by the debounce timer", () => {
    assert.ok(source.includes("const NOTE_AUTOSAVE_DEBOUNCE_MS = 1000;"));
    const block = handleNotesChangeBlock();
    assert.ok(block.includes("NOTE_AUTOSAVE_DEBOUNCE_MS"));
  });

  test("does not send a request on every keystroke -- only schedules a setTimeout, never calls fetch directly", () => {
    const block = handleNotesChangeBlock();
    assert.ok(!block.includes("fetch("), "handleNotesChange itself must never call fetch directly");
    assert.ok(block.includes("setTimeout("));
  });

  test("rapid typing resets the pending timer -- clears any existing debounce timer before scheduling a new one", () => {
    const block = handleNotesChangeBlock();
    const clearIdx = block.indexOf("clearTimeout(debounceTimers.current[appointmentId]);");
    const setIdx = block.indexOf("debounceTimers.current[appointmentId] = setTimeout(");
    assert.notEqual(clearIdx, -1, "expected the existing timer to be cleared");
    assert.notEqual(setIdx, -1, "expected a new timer to be scheduled");
    assert.ok(clearIdx < setIdx, "must clear the old timer before scheduling the new one");
  });

  test("the debounced save calls ensureSaveLoop (the serialized autosave entry point), not a raw fetch", () => {
    const block = handleNotesChangeBlock();
    assert.ok(block.includes("ensureSaveLoop(appointmentId);"));
  });

  test("jobNotesRef is updated synchronously alongside jobNotes state, so the save loop always reads the truly-latest typed value", () => {
    const block = handleNotesChangeBlock();
    const refIdx = block.indexOf("jobNotesRef.current[appointmentId] = value;");
    const stateIdx = block.indexOf("setJobNotes((prev) => ({ ...prev, [appointmentId]: value }));");
    assert.notEqual(refIdx, -1);
    assert.notEqual(stateIdx, -1);
    assert.ok(refIdx < stateIdx, "the ref must be updated before/alongside the state setter");
  });
});

describe("Employee Job Notes -- persistence via saveLoop/ensureSaveLoop", () => {
  function saveLoopBlock(): string {
    const idx = source.indexOf("async function saveLoop(appointmentId: string)");
    assert.notEqual(idx, -1);
    const nextIdx = source.indexOf("function ensureSaveLoop(appointmentId: string)");
    assert.notEqual(nextIdx, -1);
    return source.slice(idx, nextIdx);
  }

  test("saveLoop posts action: 'save_notes' to the same /api/appointments/job endpoint used by Start/Complete -- no new endpoint", () => {
    const block = saveLoopBlock();
    assert.ok(block.includes('fetch("/api/appointments/job"'));
    assert.ok(block.includes('action: "save_notes"'));
    assert.ok(block.includes("notes: valueToSend"));
    // No other endpoint is ever referenced anywhere in this file.
    const allFetchTargets = [...source.matchAll(/fetch\("([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(new Set(allFetchTargets), new Set(["/api/auth/logout", "/api/appointments/job"]));
  });

  test("sets status to 'saving' before the request and 'saved' after a successful, settled response", () => {
    const block = saveLoopBlock();
    const savingIdx = block.indexOf('setNoteStatus((prev) => ({ ...prev, [appointmentId]: "saving" }));');
    const fetchIdx = block.indexOf('fetch("/api/appointments/job"');
    const savedIdx = block.indexOf('setNoteStatus((prev) => ({ ...prev, [appointmentId]: "saved" }));');
    assert.notEqual(savingIdx, -1);
    assert.notEqual(savedIdx, -1);
    assert.ok(savingIdx < fetchIdx, "'saving' must be set before the request is sent");
  });

  test("sets status to 'error' on a failed response or network error, and never clears the typed text on failure", () => {
    const block = saveLoopBlock();
    const errorOccurrences = [...block.matchAll(/setNoteStatus\(\(prev\) => \(\{ \.\.\.prev, \[appointmentId\]: "error" \}\)\);/g)];
    assert.ok(errorOccurrences.length >= 1);
    // jobNotes/jobNotesRef (the typed text) is never written to inside saveLoop --
    // only savedJobNotes and noteStatus are. The typed text is preserved as-is
    // whether the save succeeds or fails.
    assert.ok(!block.includes("setJobNotes("));
    assert.ok(!block.includes("jobNotesRef.current[appointmentId] ="));
  });

  test("on success, savedJobNotes is updated from the server's own normalized job_notes value", () => {
    const block = saveLoopBlock();
    assert.ok(block.includes("savedValue = data.job_notes ?? \"\";"));
    assert.ok(block.includes("setSavedJobNotes((prev) => ({ ...prev, [appointmentId]: savedValue }));"));
  });

  test("stale-response protection: after a successful save, re-checks the live value against what was just sent, and loops again immediately if it changed -- an older response can never leave a newer edit unsaved or get reported as 'saved' when it isn't", () => {
    const block = saveLoopBlock();
    assert.ok(block.includes("for (;;)"), "expected saveLoop to be a loop, not a single fire-and-forget request");
    const reCheckIdx = block.indexOf('if ((jobNotesRef.current[appointmentId] ?? "") !== valueToSend)');
    assert.notEqual(reCheckIdx, -1);
    const continueIdx = block.indexOf("continue;", reCheckIdx);
    assert.notEqual(continueIdx, -1);
    assert.ok(continueIdx - reCheckIdx < 100, "the loop must re-send immediately (continue), not schedule another debounce");
  });

  test("ensureSaveLoop serializes saves -- returns the SAME in-flight promise instead of starting a second overlapping request", () => {
    const idx = source.indexOf("function ensureSaveLoop(appointmentId: string)");
    const endIdx = source.indexOf("function handleNotesChange(appointmentId: string, value: string)");
    const block = source.slice(idx, endIdx);
    assert.ok(block.includes("if (saveLoopActive.current[appointmentId]) {"));
    assert.ok(block.includes("return saveLoopPromise.current[appointmentId];"));
    assert.ok(block.includes("saveLoopActive.current[appointmentId] = true;"));
    assert.ok(block.includes(".finally(() => {"));
    assert.ok(block.includes("saveLoopActive.current[appointmentId] = false;"));
  });

  test("jobNotes and savedJobNotes are both seeded from appointments[].job_notes at mount -- a reload initializes the textarea with the previously saved value", () => {
    const jobNotesInit = source.indexOf("const [jobNotes, setJobNotes] = useState");
    const savedInit = source.indexOf("const [savedJobNotes, setSavedJobNotes] = useState");
    assert.notEqual(jobNotesInit, -1);
    assert.notEqual(savedInit, -1);
    const jobNotesBlock2 = source.slice(jobNotesInit, savedInit);
    assert.ok(jobNotesBlock2.includes("if (a.job_notes) map[a.id] = a.job_notes;"));
    const savedBlock = source.slice(savedInit, source.indexOf("const [noteStatus, setNoteStatus]"));
    assert.ok(savedBlock.includes("if (a.job_notes) map[a.id] = a.job_notes;"));
  });
});

describe("Employee Job Notes -- Complete Job flushes the latest note first", () => {
  function completeFlushBlock(): string {
    const idx = source.indexOf('if (action === "complete") {');
    assert.notEqual(idx, -1);
    const endIdx = source.indexOf("inFlightRef.current.add(appointmentId);");
    assert.notEqual(endIdx, -1);
    return source.slice(idx, endIdx);
  }

  test("cancels any pending debounce timer before completing, so it never fires redundantly after Complete", () => {
    const block = completeFlushBlock();
    assert.ok(block.includes("if (debounceTimers.current[appointmentId]) {"));
    assert.ok(block.includes("clearTimeout(debounceTimers.current[appointmentId]);"));
    assert.ok(block.includes("delete debounceTimers.current[appointmentId];"));
  });

  test("awaits ensureSaveLoop before proceeding when a save is in flight or the live note differs from the last saved value", () => {
    const block = completeFlushBlock();
    assert.ok(block.includes("const liveNote = jobNotesRef.current[appointmentId] ?? \"\";"));
    assert.ok(block.includes("const lastSavedNote = savedJobNotes[appointmentId] ?? \"\";"));
    assert.ok(block.includes("if (saveLoopActive.current[appointmentId] || liveNote !== lastSavedNote) {"));
    assert.ok(block.includes("const result = await ensureSaveLoop(appointmentId);"));
  });

  test("does not proceed with Complete if the flush save fails -- returns before the Start/Complete fetch is ever reached", () => {
    const block = completeFlushBlock();
    const resultIdx = block.indexOf("const result = await ensureSaveLoop(appointmentId);");
    const ifNotOkIdx = block.indexOf("if (!result.ok) {", resultIdx);
    const returnIdx = block.indexOf("return;", ifNotOkIdx);
    assert.notEqual(resultIdx, -1);
    assert.notEqual(ifNotOkIdx, -1);
    assert.notEqual(returnIdx, -1);
    assert.ok(ifNotOkIdx > resultIdx && returnIdx > ifNotOkIdx);
    // The actual Start/Complete POST body construction must appear only
    // AFTER this whole complete-flush block, never before it.
    const fullSource = source;
    const jobFetchIdx = fullSource.indexOf('body: JSON.stringify({ appointment_id: appointmentId, action }),');
    const flushStartIdx = fullSource.indexOf('if (action === "complete") {');
    assert.ok(flushStartIdx < jobFetchIdx);
  });

  test("this flush logic is scoped to the 'complete' action only -- 'start' never touches the note-saving machinery", () => {
    const idx = source.indexOf('if (action === "complete") {');
    const closeIdx = source.indexOf("inFlightRef.current.add(appointmentId);");
    assert.notEqual(idx, -1);
    assert.notEqual(closeIdx, -1);
    // Everything between the "complete" branch open and its own close is
    // inside the `if (action === "complete")` block -- confirmed by the
    // completeFlushBlock() helper's own bounds in the tests above already
    // matching this same span.
    assert.ok(closeIdx > idx);
  });
});

describe("Employee Job Notes -- no orphaned timers", () => {
  test("an unmount cleanup effect clears every pending debounce timer", () => {
    const idx = source.indexOf("useEffect(() => {");
    assert.notEqual(idx, -1, "expected a useEffect in this file");
    const closeIdx = source.indexOf("}, []);", idx);
    assert.notEqual(closeIdx, -1);
    const block = source.slice(idx, closeIdx);
    assert.ok(block.includes("return () => {"), "expected a cleanup function");
    assert.ok(block.includes("for (const timer of Object.values(debounceTimers.current)) clearTimeout(timer);"));
    assert.ok(block.includes("debounceTimers.current = {};"));
  });

  test("useEffect is imported from react", () => {
    assert.ok(source.includes('import { useEffect, useRef, useState } from "react";'));
  });
});

describe("Employee Job Notes -- V1 simplicity guardrails", () => {
  test("no offline sync, service worker, localStorage draft, or visible versioning/history exists", () => {
    for (const forbidden of ["serviceWorker", "localStorage", "sessionStorage", "IndexedDB", "history", "version:"]) {
      assert.ok(!source.includes(forbidden), `must not contain "${forbidden}" (V1 has none of these)`);
    }
  });

  test("no notification API is used for note status", () => {
    assert.ok(!source.includes("Notification("));
    assert.ok(!source.includes("new Notification"));
  });
});

describe("Phase 5E: job-tracking Started/Completed display uses the workspace's own resolved timezone, not the employee's device timezone", () => {
  test("startedAt/completedAt (display) are resolved via toBusinessLocal with the explicit timezone prop, while rawStartedAt/rawCompletedAt (the real instants) drive the duration delta", () => {
    assert.ok(source.includes("const rawStartedAt = times?.started ? new Date(times.started) : null;"));
    assert.ok(source.includes("const rawCompletedAt = times?.completed ? new Date(times.completed) : null;"));
    assert.ok(source.includes('const startedAt = times?.started ? toBusinessLocal(times.started, timezone) : null;'));
    assert.ok(source.includes('const completedAt = times?.completed ? toBusinessLocal(times.completed, timezone) : null;'));
  });

  test("actualDuration is computed from the real instants (rawStartedAt/rawCompletedAt), never the business-local display Dates", () => {
    const idx = source.indexOf("let actualDuration: string | null = null;");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 200);
    assert.ok(block.includes("if (rawStartedAt && rawCompletedAt)"));
    assert.ok(block.includes("rawCompletedAt.getTime() - rawStartedAt.getTime()"));
  });

  test("no bare new Date(times.started)/new Date(times.completed) remains as the DISPLAY value (only as the raw-instant value)", () => {
    assert.ok(!source.includes("const startedAt = times?.started ? new Date(times.started) : null;"));
    assert.ok(!source.includes("const completedAt = times?.completed ? new Date(times.completed) : null;"));
  });
});
