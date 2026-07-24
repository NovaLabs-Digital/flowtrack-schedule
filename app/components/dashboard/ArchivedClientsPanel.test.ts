// Phase 5.5E-E1E: ArchivedClientsPanel.tsx is a .tsx file and cannot be
// loaded by Node's built-in test runner (this repo's only test runner) --
// the same limitation documented throughout this entitlement-enforcement
// effort. This file proves what SOURCE INSPECTION can prove: prop wiring
// (including the three-hop DashboardShell -> DashboardSettingsArea ->
// SettingsPanel -> ArchivedClientsPanel chain), guard placement, exact
// wording, and structural absence of forbidden content. It does not claim
// to exercise real DOM rendering or real mouse/keyboard events for THIS
// component. Real rendered interaction proof for the shared
// CapabilityGatedButton primitive this panel's Restore control now uses
// already exists in CapabilityGatedButton.test.ts and is cited, not
// re-executed.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./ArchivedClientsPanel.tsx", import.meta.url)), "utf8");
const settingsPanelSource = fs.readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const settingsAreaSource = fs.readFileSync(fileURLToPath(new URL("./DashboardSettingsArea.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring: full DashboardShell -> ... -> ArchivedClientsPanel chain", () => {
  test("Props includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean/);
  });

  test("SettingsPanel forwards canMutateOperationalData to ArchivedClientsPanel only, not to Company/Services/Staff", () => {
    const archivedIdx = settingsPanelSource.indexOf('if (section === "archived")');
    assert.notEqual(archivedIdx, -1);
    const line = settingsPanelSource.slice(archivedIdx, archivedIdx + 150);
    assert.match(line, /<ArchivedClientsPanel canMutateOperationalData=\{canMutateOperationalData\} \/>/);

    for (const marker of ['<CompanyInfoPanel />', '<ServicesPanel />', '<StaffPanel />']) {
      assert.ok(settingsPanelSource.includes(marker), `expected ${marker} unchanged`);
    }
  });

  test("DashboardSettingsArea passes canMutateOperationalData straight through to SettingsPanel", () => {
    const idx = settingsAreaSource.indexOf("<SettingsPanel");
    assert.notEqual(idx, -1);
    const closeIdx = settingsAreaSource.indexOf("/>", idx);
    const jsx = settingsAreaSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{canMutateOperationalData\}/);
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to DashboardSettingsArea", () => {
    const idx = shellSource.indexOf("<DashboardSettingsArea");
    assert.notEqual(idx, -1);
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });

  test("the tester demo carve-out branch (Staff/Services interactive steps) does not render an <ArchivedClientsPanel> element and needs no wiring change", () => {
    // Checked for the JSX tag specifically, not a whole-file substring
    // search -- this file's own header comment legitimately names
    // ArchivedClientsPanel by way of explaining the prop-forwarding chain,
    // which a naive whole-file .includes() check would misread as the
    // component being rendered here.
    assert.ok(!settingsAreaSource.includes("<ArchivedClientsPanel"));
  });
});

describe("restore() guard placement", () => {
  test("restore guards on canMutateOperationalData before setRestoring/fetch", () => {
    const fnStart = source.indexOf("async function restore(id: string)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const setRestoringIdx = source.indexOf("setRestoring(id);", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/clients"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < setRestoringIdx, "guard must run before setRestoring");
    assert.ok(guardIdx < fetchIdx, "guard must run before the fetch call");
  });

  test("the guard is the first statement inside restore()", () => {
    const fnStart = source.indexOf("async function restore(id: string)");
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 400);
    const firstNonCommentNonBlank = afterBrace
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
  });
});

describe("Restore control governed by CapabilityGatedButton", () => {
  test("Restore is a CapabilityGatedButton, not a plain <button>", () => {
    assert.match(source, /<CapabilityGatedButton[\s\S]{0,200}onClick=\{\(\) => restore\(c\.id\)\}/);
  });

  test("allowed is wired to canMutateOperationalData", () => {
    const idx = source.indexOf("onClick={() => restore(c.id)}");
    const block = source.slice(Math.max(0, idx - 100), idx + 100);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
  });

  test("existing loading-protection disabled={restoring === c.id} is preserved", () => {
    const idx = source.indexOf("onClick={() => restore(c.id)}");
    const block = source.slice(idx, idx + 150);
    assert.match(block, /disabled=\{restoring === c\.id\}/);
  });

  test("ariaDescribedBy points at the shared notice id", () => {
    const idx = source.indexOf("onClick={() => restore(c.id)}");
    const block = source.slice(idx, idx + 200);
    assert.match(block, /ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/);
  });

  test("className and loading label text are unchanged", () => {
    assert.ok(source.includes('className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors"'));
    assert.ok(source.includes('{restoring === c.id ? "Restoring..." : "Restore"}'));
  });
});

describe("Retry control remains ungoverned (non-mutating, only reloads read data)", () => {
  test("Retry is still a plain <button>, not CapabilityGatedButton", () => {
    const idx = source.indexOf("setLoading(true); setMessage(null); loadClients();");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(before.includes("<button"));
  });

  test("Retry carries no capability guard", () => {
    assert.ok(!/if \(!canMutateOperationalData\) return;[\s\S]{0,80}loadClients\(\)/.test(source));
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
    assert.equal(declared, "archived-clients-panel-restricted-notice");
    for (const other of [
      "appointment-modal-restricted-notice",
      "appointment-detail-restricted-notice",
      "move-confirm-dialog-restricted-notice",
      "topbar-restricted-notice",
      "mobile-dashboard-restricted-notice",
      "mobile-appointment-detail-restricted-notice",
      "client-panel-restricted-notice",
    ]) {
      assert.notEqual(declared, other);
    }
  });

  test("only one notice block exists, positioned outside the per-row .map() -- not duplicated per archived client row", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
    const noticeIdx = source.indexOf("id={RESTRICTED_NOTICE_ID}");
    const mapIdx = source.indexOf("clients.map((c) =>");
    assert.ok(noticeIdx < mapIdx, "the notice must be declared before the per-row map, not inside it");
  });
});

describe("read-only data remains unconditional", () => {
  test("the archived-client list rows (name/phone/email/archived-date/status) are not wrapped in a canMutateOperationalData check", () => {
    const rowStart = source.indexOf('<div key={c.id}');
    const rowEnd = source.indexOf("<div>\n                  <CapabilityGatedButton", rowStart);
    assert.notEqual(rowStart, -1);
    assert.notEqual(rowEnd, -1);
    const block = source.slice(rowStart, rowEnd);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("the header title/description and empty-state message remain unconditional", () => {
    const idx = source.indexOf("Archived Clients");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 300);
    assert.ok(!block.includes("canMutateOperationalData"));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `ArchivedClientsPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `ArchivedClientsPanel.tsx must not contain "${forbidden}"`);
    }
  });
});
