// Phase 5.5E-E1E: ClientPanel.tsx is a .tsx file. Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all,
// with or without JSX content -- the same well-documented limitation hit by
// every .tsx production file in this entitlement-enforcement effort. This
// file proves what SOURCE INSPECTION can actually prove -- prop wiring,
// guard placement/ordering, exact wording, and structural absence of
// forbidden content -- and does not claim to exercise real DOM rendering or
// real mouse/keyboard events for THIS component.
//
// The one thing that genuinely needs real rendered interaction proof --
// whether a restricted CapabilityGatedButton actually blocks a
// click/Enter/Space and remains disabled/aria-disabled -- is already proven
// exhaustively, for the exact same component this file wires in, by
// CapabilityGatedButton.test.ts's 20 real rendered-DOM tests. That proof is
// not re-executed here; it is cited as already covering the shared
// primitive all four of this component's governed controls now use.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./ClientPanel.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("Props includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
  });

  test("the component destructures canMutateOperationalData from its props", () => {
    assert.match(source, /^\s*client, appointments, onClientUpdated, canMutateOperationalData, timezone,$/m);
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to ClientPanel", () => {
    const idx = shellSource.indexOf("<ClientPanel");
    assert.notEqual(idx, -1, "ClientPanel must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });
});

describe("handler guard placement", () => {
  test("startEdit guards on canMutateOperationalData before the client-null check and before opening the edit form", () => {
    const fnStart = source.indexOf("function startEdit()");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const clientCheckIdx = source.indexOf("if (!client) return;", fnStart);
    const setEditingIdx = source.indexOf("setEditing(true);", fnStart);
    assert.notEqual(guardIdx, -1, "startEdit must contain the capability guard");
    assert.ok(guardIdx < clientCheckIdx, "guard must run before the client-null check");
    assert.ok(guardIdx < setEditingIdx, "guard must run before the edit form opens (setEditing(true))");
  });

  test("the guard is the first statement inside startEdit (prevents the edit form from ever opening while restricted)", () => {
    const fnStart = source.indexOf("function startEdit()");
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 500);
    const firstNonCommentNonBlank = afterBrace
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
  });

  test("saveEdit guards on canMutateOperationalData before the fetch call", () => {
    const fnStart = source.indexOf("async function saveEdit()");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/clients"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < fetchIdx, "guard must run before the fetch call");
  });

  test("saveEdit's guard is the first statement", () => {
    const fnStart = source.indexOf("async function saveEdit()");
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 100);
    const firstLine = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstLine, "if (!canMutateOperationalData) return;");
  });

  test("doAction (archive/restore) guards on canMutateOperationalData before the fetch call, covering both actions since they share one function", () => {
    const fnStart = source.indexOf('async function doAction(action: "archive" | "restore")');
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/clients"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < fetchIdx, "guard must run before the fetch call");
  });

  test("doAction's guard is the first statement", () => {
    const fnStart = source.indexOf('async function doAction(action: "archive" | "restore")');
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 100);
    const firstLine = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstLine, "if (!canMutateOperationalData) return;");
  });
});

describe("governed controls: Edit, Archive, Restore, Save Client", () => {
  test("exactly four CapabilityGatedButton call sites exist", () => {
    const matches = source.match(/<CapabilityGatedButton/g) ?? [];
    assert.equal(matches.length, 4, "expected Edit, Restore, Archive, and Save Client");
  });

  test("all four are wired with allowed={canMutateOperationalData}", () => {
    const matches = source.match(/allowed=\{canMutateOperationalData\}/g) ?? [];
    assert.equal(matches.length, 4);
  });

  test("all four reference the single shared notice via ariaDescribedBy", () => {
    const matches = source.match(/ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 4);
  });

  test("Edit calls startEdit directly (no extra inline wrapping)", () => {
    assert.match(source, /<CapabilityGatedButton[^>]*onClick=\{startEdit\}/);
  });

  test("Archive and Restore each call doAction with the correct action string", () => {
    assert.ok(source.includes('onClick={() => doAction("restore")}'));
    assert.ok(source.includes('onClick={() => doAction("archive")}'));
  });

  test("Archive and Restore preserve the existing disabled={saving} loading-protection prop", () => {
    const restoreIdx = source.indexOf('onClick={() => doAction("restore")}');
    const archiveIdx = source.indexOf('onClick={() => doAction("archive")}');
    assert.match(source.slice(restoreIdx, restoreIdx + 100), /disabled=\{saving\}/);
    assert.match(source.slice(archiveIdx, archiveIdx + 100), /disabled=\{saving\}/);
  });

  test("Save Client calls saveEdit directly and preserves disabled={saving}", () => {
    const idx = source.indexOf("onClick={saveEdit}");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 100);
    assert.match(block, /disabled=\{saving\}/);
  });

  test("Save Client's loading label text (Saving... / Save Client) is unchanged", () => {
    assert.ok(source.includes('{saving ? "Saving..." : "Save Client"}'));
  });

  test("Edit/Archive/Restore/Save Client classNames are preserved (byte-identical core styling, disabled:opacity-50 present)", () => {
    assert.ok(source.includes('className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 transition-colors"'));
    assert.ok(source.includes('className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 shadow-sm hover:bg-emerald-100 disabled:opacity-50"'));
    assert.ok(source.includes('className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 shadow-sm hover:bg-amber-100 disabled:opacity-50"'));
    assert.ok(source.includes('className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50"'));
  });
});

describe("Cancel (form) remains ungoverned -- non-mutating, only closes the form", () => {
  test("Cancel is still a plain <button>, not CapabilityGatedButton", () => {
    const idx = source.indexOf("setEditing(false); setMessage(null); }}");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 40), idx);
    assert.ok(before.includes("<button"));
  });

  test("closing the form carries no capability guard", () => {
    assert.ok(!/if \(!canMutateOperationalData\) return;[\s\S]{0,60}setEditing\(false\)/.test(source));
  });
});

describe("notice block", () => {
  test("exact approved wording constant", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("notice only renders when restricted (negated condition)", () => {
    assert.match(source, /\{!canMutateOperationalData && \(/);
  });

  test("notice id's declared value is unique to this component", () => {
    const declared = source.match(/const RESTRICTED_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "client-panel-restricted-notice");
    for (const other of [
      "appointment-modal-restricted-notice",
      "appointment-detail-restricted-notice",
      "move-confirm-dialog-restricted-notice",
      "topbar-restricted-notice",
      "mobile-dashboard-restricted-notice",
      "mobile-appointment-detail-restricted-notice",
      "archived-clients-panel-restricted-notice",
    ]) {
      assert.notEqual(declared, other);
    }
  });

  test("only one notice block exists in this file, in the always-rendered header (not inside the editing-only or workspace-only branches)", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
    const noticeIdx = source.indexOf("id={RESTRICTED_NOTICE_ID}");
    const formBranchIdx = source.indexOf("{editing && client ? (");
    assert.ok(noticeIdx < formBranchIdx, "the notice must be declared in the always-rendered header, before the editing/workspace branch");
  });
});

describe("read-only data remains unconditional", () => {
  test("the 5-column workspace (client info, past/future services, notes, communication) is not wrapped in a canMutateOperationalData check", () => {
    const workspaceStart = source.indexOf("/* 5-column workspace */");
    assert.notEqual(workspaceStart, -1);
    const workspaceEnd = source.indexOf("\n  );\n}", workspaceStart);
    const block = source.slice(workspaceStart, workspaceEnd);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("client name/summary line and archived badge remain unconditional", () => {
    const idx = source.indexOf('{client ? client.name : "No client selected"}');
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(!before.includes("canMutateOperationalData"));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace-identifier vocabulary appears in this file", () => {
    // "workspace"/"Workspace" deliberately excluded from this list: this
    // file's own pre-existing, unrelated UI-layout comments ("5-column
    // workspace") legitimately use the plain English word, which a bare
    // substring check would misread as a workspace-identifier leak. The
    // actual concern -- a workspace ID value -- is checked precisely below
    // via workspaceId/workspace_id instead.
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspaceId", "workspace_id",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `ClientPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `ClientPanel.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("Phase 5C: workspace-timezone-aware Past/Future Services display", () => {
  test("Props declares timezone: string, and DashboardShell passes timezone={timezone}", () => {
    assert.ok(source.includes("timezone: string;"));
    const idx = shellSource.indexOf("<ClientPanel");
    assert.notEqual(idx, -1);
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /timezone=\{timezone\}/);
  });

  test("fmtDate/fmtTime (real appointment timestamps) take an explicit tz parameter and both call sites pass the timezone prop", () => {
    assert.ok(source.includes("function fmtDate(iso: string, tz: string)"));
    assert.ok(source.includes("function fmtTime(iso: string, tz: string)"));
    assert.ok(source.includes("fmtDate(a.scheduled_for, timezone)"));
    assert.ok(source.includes("fmtTime(a.scheduled_for, timezone)"));
  });

  test("fmtCalendarDate (client_since, a date-only field) remains untouched by timezone -- a date-only ISO string is deliberately never run through a timezone conversion", () => {
    assert.ok(source.includes("function fmtCalendarDate(dateOnly: string)"));
    assert.ok(source.includes("fmtCalendarDate(client.client_since)"));
  });

  test("past/future classification (a pure instant comparison) remains on bare new Date(), unaffected by the display-formatter fix", () => {
    assert.ok(source.includes("const now = new Date();"));
  });
});
