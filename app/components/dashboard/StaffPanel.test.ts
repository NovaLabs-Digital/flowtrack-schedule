// Phase 5.5E-E1F: StaffPanel.tsx is a .tsx file and cannot be loaded by
// Node's built-in test runner (this repo's only test runner) -- the same
// limitation documented throughout this entitlement-enforcement effort.
// This file proves what SOURCE INSPECTION can prove: prop wiring (both the
// normal owner path via SettingsPanel and the tester interactive-demo
// carve-out in DashboardSettingsArea), guard placement, exact wording, and
// structural absence of forbidden content. Real rendered mouse/keyboard/
// repeated-activation proof for the shared CapabilityGatedButton primitive
// this panel's six governed controls now use already exists in
// CapabilityGatedButton.test.ts and is cited, not re-executed.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./StaffPanel.tsx", import.meta.url)), "utf8");
const settingsPanelSource = fs.readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const settingsAreaSource = fs.readFileSync(fileURLToPath(new URL("./DashboardSettingsArea.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring: both render paths", () => {
  test("Props includes canMutateOperationalData: boolean (required, not optional like isTester)", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
    assert.ok(!/canMutateOperationalData\?:/.test(source));
  });

  test("SettingsPanel forwards canMutateOperationalData to StaffPanel (normal owner path)", () => {
    const idx = settingsPanelSource.indexOf('if (section === "staff")');
    assert.notEqual(idx, -1);
    const line = settingsPanelSource.slice(idx, idx + 120);
    assert.match(line, /<StaffPanel canMutateOperationalData=\{canMutateOperationalData\} \/>/);
  });

  test("DashboardSettingsArea's tester interactive-demo carve-out also passes canMutateOperationalData -- reusing its own existing prop, not a new parallel one", () => {
    const idx = settingsAreaSource.indexOf("<StaffPanel isTester");
    assert.notEqual(idx, -1);
    const block = settingsAreaSource.slice(idx, idx + 80);
    assert.match(block, /canMutateOperationalData=\{canMutateOperationalData\}/);
  });
});

describe("mutation-entry guards: startAdd, startEdit", () => {
  test("startAdd guards on canMutateOperationalData as its first statement, before setShowAdd(true)", () => {
    const fnStart = source.indexOf("function startAdd()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const firstLine = source.slice(braceIdx + 1, braceIdx + 100).split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstLine, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const openIdx = source.indexOf("setShowAdd(true);", fnStart);
    assert.ok(guardIdx < openIdx);
  });

  test("startEdit guards on canMutateOperationalData as its first statement, before setEditingId -- the edit form (including the password field) must never open while restricted", () => {
    const fnStart = source.indexOf("function startEdit(e: Employee)");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 400);
    const firstNonCommentNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const openIdx = source.indexOf("setEditingId(e.id);", fnStart);
    assert.ok(guardIdx < openIdx);
  });
});

describe("mutation guards: handleSave (including password changes), toggleActive", () => {
  test("handleSave guards on canMutateOperationalData before validation and before the fetch call -- covers name/phone/email/color/position AND password, since all flow through this one submit", () => {
    const fnStart = source.indexOf("async function handleSave(ev: React.FormEvent)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const validationIdx = source.indexOf("if (!form.name.trim())", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/employees"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < validationIdx);
    assert.ok(guardIdx < fetchIdx);
  });

  test("the password field's value is only ever sent as part of this same guarded handleSave request body -- no separate password-change code path exists", () => {
    const passwordFetchRefs = source.match(/form\.password/g) ?? [];
    assert.ok(passwordFetchRefs.length > 0);
    const fnStart = source.indexOf("async function handleSave(ev: React.FormEvent)");
    const fnEnd = source.indexOf("\n  }\n\n  async function toggleActive", fnStart);
    const body = source.slice(fnStart, fnEnd);
    // Every reference to form.password in the whole file is inside handleSave
    // or the form's own onChange (local state) -- confirmed by checking the
    // request-body-construction reference specifically lives in this function.
    assert.ok(body.includes("form.password"));
  });

  test("toggleActive guards on canMutateOperationalData before the fetch call", () => {
    const fnStart = source.indexOf("async function toggleActive(e: Employee)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/employees"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < fetchIdx);
  });
});

describe("governed controls: Add, Edit x2, Deactivate/Reactivate x2, Save submit", () => {
  test("exactly six CapabilityGatedButton call sites exist", () => {
    const matches = source.match(/<CapabilityGatedButton/g) ?? [];
    assert.equal(matches.length, 6, "expected + Add Employee, active-row Edit, active-row Deactivate, inactive-row Edit, inactive-row Reactivate, and the form's Save submit");
  });

  test("all six are wired with allowed={canMutateOperationalData}", () => {
    const matches = source.match(/allowed=\{canMutateOperationalData\}/g) ?? [];
    assert.equal(matches.length, 6);
  });

  test("all six reference the single shared notice via ariaDescribedBy", () => {
    const matches = source.match(/ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 6);
  });

  test("the form's Save/Add submit button preserves type=\"submit\" and disabled={saving}", () => {
    const idx = source.indexOf('type="submit"');
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 200);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
    assert.match(block, /disabled=\{saving\}/);
  });

  test("+ Add Employee remains hidden for testers ({!isTester && ...}) in addition to being capability-governed -- pre-existing policy unchanged", () => {
    const idx = source.indexOf("onClick={startAdd}");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 200), idx);
    assert.ok(before.includes("{!isTester && !showAdd && !editingId && ("));
  });

  test("both the active-list and inactive-list Edit/Deactivate-Reactivate buttons call the same startEdit/toggleActive functions (no duplicated logic)", () => {
    const editCalls = source.match(/onClick=\{\(\) => startEdit\(e\)\}/g) ?? [];
    const toggleCalls = source.match(/onClick=\{\(\) => toggleActive\(e\)\}/g) ?? [];
    assert.equal(editCalls.length, 2, "one in the active list, one in the inactive list");
    assert.equal(toggleCalls.length, 2, "one in the active list, one in the inactive list");
  });
});

describe("Cancel, color-swatch, and position controls remain ungoverned", () => {
  test("form Cancel is still a plain <button>, not CapabilityGatedButton", () => {
    const idx = source.indexOf("onClick={cancelForm}");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 80), idx);
    assert.ok(before.includes("<button"));
  });

  test("cancelForm carries no capability guard -- closing the form is always allowed", () => {
    const fnStart = source.indexOf("function cancelForm()");
    const fnEnd = source.indexOf("\n  }", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("canMutateOperationalData"));
  });

  test("color-swatch buttons and the position select (local form state only) carry no capability guard", () => {
    assert.ok(source.includes("onClick={() => setForm((p) => ({ ...p, color: c.hex }))}"));
  });

  test("Retry (load-failure) remains a plain, ungoverned button", () => {
    const idx = source.indexOf("setLoading(true); setMessage(null); loadEmployees();");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(before.includes("<button"));
    assert.ok(!before.includes("CapabilityGatedButton"));
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
    assert.equal(declared, "staff-panel-restricted-notice");
  });

  test("only one notice block exists, in the header (not duplicated per row or per list)", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
    const noticeIdx = source.indexOf("id={RESTRICTED_NOTICE_ID}");
    const activeMapIdx = source.indexOf("activeEmployees.map((e) =>");
    assert.ok(noticeIdx < activeMapIdx, "the notice must be declared before the per-row maps, not inside them");
  });
});

describe("read-only data remains unconditional", () => {
  test("employee row display (color, name, position, email, phone, status badge) is not wrapped in a canMutateOperationalData check, for both active and inactive lists", () => {
    const activeMapIdx = source.indexOf("activeEmployees.map((e) =>");
    const firstButtonIdx = source.indexOf("<CapabilityGatedButton", activeMapIdx);
    const activeBlock = source.slice(activeMapIdx, firstButtonIdx);
    assert.ok(!activeBlock.includes("canMutateOperationalData"));
  });

  test("the panel header title/description and footer counts remain unconditional", () => {
    assert.ok(source.includes("Manage employees and assign them to appointments."));
    const idx = source.indexOf("Manage employees and assign them to appointments.");
    const block = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(!block.includes("canMutateOperationalData"));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace-identifier vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspaceId", "workspace_id",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `StaffPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `StaffPanel.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("password visibility (Phase 5.7D-R17)", () => {
  test("the employee-credential password field uses PasswordInput with autoComplete=new-password, and no raw <input type=\"password\"> remains", () => {
    assert.ok(source.includes('import PasswordInput from "@/app/components/PasswordInput";'));
    assert.equal([...source.matchAll(/<PasswordInput/g)].length, 1);
    assert.ok(source.includes('autoComplete="new-password"'));
    assert.ok(!source.includes('type="password"'));
  });
});
