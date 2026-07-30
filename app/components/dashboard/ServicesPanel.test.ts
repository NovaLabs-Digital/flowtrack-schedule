// Phase 5.5E-E1F: ServicesPanel.tsx is a .tsx file and cannot be loaded by
// Node's built-in test runner (this repo's only test runner) -- the same
// limitation documented throughout this entitlement-enforcement effort.
// This file proves what SOURCE INSPECTION can prove: prop wiring (including
// both the normal owner path via SettingsPanel and the tester interactive-
// demo carve-out in DashboardSettingsArea), guard placement, exact wording,
// and structural absence of forbidden content. Real rendered mouse/keyboard/
// repeated-activation proof for the shared CapabilityGatedButton primitive
// this panel's five governed controls now use already exists in
// CapabilityGatedButton.test.ts and is cited, not re-executed.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./ServicesPanel.tsx", import.meta.url)), "utf8");
const settingsPanelSource = fs.readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");
const settingsAreaSource = fs.readFileSync(fileURLToPath(new URL("./DashboardSettingsArea.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring: both render paths", () => {
  test("Props includes canMutateOperationalData: boolean (required, not optional like isTester)", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
    assert.ok(!/canMutateOperationalData\?:/.test(source));
  });

  test("SettingsPanel forwards canMutateOperationalData to ServicesPanel (normal owner path)", () => {
    const idx = settingsPanelSource.indexOf('if (section === "services")');
    assert.notEqual(idx, -1);
    const line = settingsPanelSource.slice(idx, idx + 120);
    assert.match(line, /<ServicesPanel canMutateOperationalData=\{canMutateOperationalData\} \/>/);
  });

  test("DashboardSettingsArea's tester interactive-demo carve-out also passes canMutateOperationalData -- reusing its own existing prop, not a new parallel one", () => {
    const idx = settingsAreaSource.indexOf("<ServicesPanel isTester");
    assert.notEqual(idx, -1);
    const block = settingsAreaSource.slice(idx, idx + 80);
    assert.match(block, /canMutateOperationalData=\{canMutateOperationalData\}/);
  });
});

describe("mutation-entry guards: startAdd, startEdit", () => {
  test("startAdd guards on canMutateOperationalData as its first statement, before setShowAdd(true) -- the add form must never open while restricted", () => {
    const fnStart = source.indexOf("function startAdd()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const firstLine = source.slice(braceIdx + 1, braceIdx + 100).split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstLine, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const openIdx = source.indexOf("setShowAdd(true);", fnStart);
    assert.ok(guardIdx < openIdx);
  });

  test("startEdit guards on canMutateOperationalData as its first statement, before setEditingId -- the edit form must never open while restricted", () => {
    const fnStart = source.indexOf("function startEdit(s: Service)");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 400);
    const firstNonCommentNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const openIdx = source.indexOf("setEditingId(s.id);", fnStart);
    assert.ok(guardIdx < openIdx);
  });
});

describe("mutation guards: handleSave, handleDelete, toggleActive", () => {
  test("handleSave guards on canMutateOperationalData before validation and before the fetch call", () => {
    const fnStart = source.indexOf("async function handleSave(e: React.FormEvent)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const validationIdx = source.indexOf("if (!form.name.trim())", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/services"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < validationIdx);
    assert.ok(guardIdx < fetchIdx);
  });

  test("handleDelete guards on canMutateOperationalData before the confirm() dialog and before the fetch call -- a restricted owner must never see the delete confirmation", () => {
    const fnStart = source.indexOf("async function handleDelete(s: Service)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const confirmIdx = source.indexOf("confirm(", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/services"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < confirmIdx, "guard must run before the delete confirmation dialog");
    assert.ok(guardIdx < fetchIdx);
  });

  test("toggleActive guards on canMutateOperationalData before the fetch call", () => {
    const fnStart = source.indexOf("async function toggleActive(s: Service)");
    assert.notEqual(fnStart, -1);
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/services"', fnStart);
    assert.notEqual(guardIdx, -1);
    assert.ok(guardIdx < fetchIdx);
  });
});

describe("governed controls: Add, Edit, Enable/Disable, Delete, Save submit", () => {
  test("exactly five CapabilityGatedButton call sites exist", () => {
    const matches = source.match(/<CapabilityGatedButton/g) ?? [];
    assert.equal(matches.length, 5, "expected + Add Service, Edit, Enable/Disable, Delete (tester), and the form's Save submit");
  });

  test("all five are wired with allowed={canMutateOperationalData}", () => {
    const matches = source.match(/allowed=\{canMutateOperationalData\}/g) ?? [];
    assert.equal(matches.length, 5);
  });

  test("all five reference the single shared notice via ariaDescribedBy", () => {
    const matches = source.match(/ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 5);
  });

  test("the form's Save/Add submit button preserves type=\"submit\" and disabled={saving}", () => {
    const idx = source.indexOf('type="submit"');
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 200);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
    assert.match(block, /disabled=\{saving\}/);
  });

  test("the Delete control remains tester-only ({isTester && ...}) in addition to being capability-governed", () => {
    const idx = source.indexOf("onClick={() => handleDelete(s)}");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 200), idx);
    assert.ok(before.includes("{isTester && ("));
  });
});

describe("Cancel and color-swatch controls remain ungoverned", () => {
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

  test("color-swatch buttons (local form state only) carry no capability guard", () => {
    assert.ok(source.includes("onClick={() => setForm((p) => ({ ...p, color: c.hex }))}"));
  });

  test("Retry (load-failure) remains a plain, ungoverned button", () => {
    const idx = source.indexOf("setLoading(true); setMessage(null); loadServices();");
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
    assert.equal(declared, "services-panel-restricted-notice");
  });

  test("only one notice block exists, in the header (not duplicated per row)", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
    const noticeIdx = source.indexOf("id={RESTRICTED_NOTICE_ID}");
    const mapIdx = source.indexOf("services.map((s) =>");
    assert.ok(noticeIdx < mapIdx, "the notice must be declared before the per-row map, not inside it");
  });
});

describe("read-only data remains unconditional", () => {
  test("service row display (color, name, description, status badge) is not wrapped in a canMutateOperationalData check", () => {
    const rowStart = source.indexOf("services.map((s) =>");
    const firstButtonIdx = source.indexOf("<CapabilityGatedButton", rowStart);
    const block = source.slice(rowStart, firstButtonIdx);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("the panel header title/description and footer count remain unconditional", () => {
    assert.ok(source.includes("Manage the services your business offers."));
    const idx = source.indexOf("Manage the services your business offers.");
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
      assert.ok(!source.includes(forbidden), `ServicesPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `ServicesPanel.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("Phase 5.7D-R17: optional service default pricing (source-level proof)", () => {
  test("the Price form field is blank by default and parses via the shared lib/money helpers, never a local reimplementation", () => {
    assert.ok(source.includes('import { centsToInputValue, formatCents, parsePriceToCents } from "@/lib/money";'));
    assert.ok(source.includes("price: \"\""));
  });

  test("editing populates the price field from the service's own default_price_cents via centsToInputValue", () => {
    assert.ok(source.includes("price: centsToInputValue(s.default_price_cents)"));
  });

  test("a blank price saves as null; a non-blank, unparseable price blocks submission with a clear error, never silently sent to the server", () => {
    assert.ok(source.includes('const priceTrimmed = form.price.trim();'));
    assert.ok(source.includes('const default_price_cents = priceTrimmed === "" ? null : parsePriceToCents(priceTrimmed);'));
    assert.ok(source.includes("if (priceTrimmed !== \"\" && default_price_cents === null)"));
  });

  test("both POST (create) and PATCH (edit) payloads send default_price_cents explicitly, never the raw form.price string", () => {
    const occurrences = [...source.matchAll(/default_price_cents(?!:\s*number)/g)].length;
    assert.ok(occurrences >= 2, `expected default_price_cents referenced in both payload branches, found ${occurrences}`);
    assert.ok(!source.includes("...form }") && !source.includes("...form)"), "must not spread the raw form object (which contains the unparsed price string) into the request body");
  });

  test("the table displays the price via formatCents, distinguishing 'no price set' from a real $0.00", () => {
    assert.ok(source.includes("{formatCents(s.default_price_cents)}"));
  });

  test("the price input uses a $ prefix and an explicit optional placeholder", () => {
    assert.ok(source.includes("Default Price"));
    assert.ok(source.includes('placeholder="Optional — leave blank for no default price"'));
  });
});
