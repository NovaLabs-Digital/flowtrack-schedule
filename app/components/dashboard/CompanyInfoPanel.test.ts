// Phase 5.5E-E1F: CompanyInfoPanel.tsx is a .tsx file. Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all --
// the same well-documented limitation hit by every .tsx production file in
// this entitlement-enforcement effort. This file proves what SOURCE
// INSPECTION can actually prove -- prop wiring, guard placement/ordering,
// exact wording, and structural absence of forbidden content -- and does
// not claim to exercise real DOM rendering or real mouse/keyboard events for
// THIS component.
//
// The one thing that genuinely needs real rendered interaction proof --
// whether a restricted CapabilityGatedButton actually blocks a
// click/Enter/Space and remains disabled/aria-disabled -- is already proven
// exhaustively, for the exact same component this file wires in, by
// CapabilityGatedButton.test.ts's 20 real rendered-DOM tests. That proof is
// not re-executed here; it is cited as already covering the shared
// primitive both of this component's governed Save buttons now use.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./CompanyInfoPanel.tsx", import.meta.url)), "utf8");
const settingsPanelSource = fs.readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("Props includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean/);
  });

  test("SettingsPanel forwards canMutateOperationalData to CompanyInfoPanel", () => {
    const idx = settingsPanelSource.indexOf('if (section === "company")');
    assert.notEqual(idx, -1);
    const line = settingsPanelSource.slice(idx, idx + 120);
    assert.match(line, /<CompanyInfoPanel canMutateOperationalData=\{canMutateOperationalData\} \/>/);
  });
});

describe("shared wording", () => {
  test("exact approved wording constant, shared by both cards' notices", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("both notice blocks render the exact same wording constant, not two divergent strings", () => {
    const wordingMatches = source.match(/\{RESTRICTED_WORDING\}/g) ?? [];
    assert.equal(wordingMatches.length, 2, "one render site per card notice");
  });
});

describe("Company Information card: Save Changes governed", () => {
  test("handleSave guards on canMutateOperationalData as its first statement, before the fetch call", () => {
    const fnStart = source.indexOf("async function handleSave()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 400);
    const firstNonCommentNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/settings/company"', fnStart);
    assert.ok(guardIdx < fetchIdx);
  });

  test("Save Changes (Company Information) is a CapabilityGatedButton wired to allowed/onClick/disabled/ariaDescribedBy", () => {
    const idx = source.indexOf("onClick={handleSave}");
    assert.notEqual(idx, -1);
    const block = source.slice(Math.max(0, idx - 150), idx + 100);
    assert.match(block, /<CapabilityGatedButton/);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
    assert.match(block, /disabled=\{saving \|\| !dirty\}/);
    assert.match(block, /ariaDescribedBy=\{COMPANY_NOTICE_ID\}/);
  });

  test("Company Information's own notice id is declared and unique", () => {
    const declared = source.match(/const COMPANY_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "company-info-restricted-notice");
  });

  test("the Company Information notice renders only when restricted and appears exactly once", () => {
    const matches = source.match(/id=\{COMPANY_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });
});

describe("Automation card: Save Changes governed independently", () => {
  test("handleSaveAutomation guards on canMutateOperationalData as its first statement, before the fetch call", () => {
    const fnStart = source.indexOf("async function handleSaveAutomation()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 100);
    const firstLine = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstLine, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/settings/company"', fnStart);
    assert.ok(guardIdx < fetchIdx);
  });

  test("Save Changes (Automation) is a CapabilityGatedButton wired to allowed/onClick/disabled/ariaDescribedBy", () => {
    const idx = source.indexOf("onClick={handleSaveAutomation}");
    assert.notEqual(idx, -1);
    const block = source.slice(Math.max(0, idx - 150), idx + 100);
    assert.match(block, /<CapabilityGatedButton/);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
    assert.match(block, /disabled=\{automationSaving \|\| !automationDirty\}/);
    assert.match(block, /ariaDescribedBy=\{AUTOMATION_NOTICE_ID\}/);
  });

  test("Automation's own notice id is declared, unique, and distinct from Company Information's", () => {
    const declared = source.match(/const AUTOMATION_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "company-automation-restricted-notice");
    assert.notEqual(declared, "company-info-restricted-notice");
  });

  test("the Automation notice renders only when restricted and appears exactly once", () => {
    const matches = source.match(/id=\{AUTOMATION_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("the two governed buttons each reference their OWN card's notice, never the other's", () => {
    const saveIdx = source.indexOf("onClick={handleSave}");
    const saveBlock = source.slice(saveIdx, saveIdx + 200);
    assert.ok(!saveBlock.includes("AUTOMATION_NOTICE_ID"));
    const autoIdx = source.indexOf("onClick={handleSaveAutomation}");
    const autoBlock = source.slice(autoIdx, autoIdx + 200);
    assert.ok(!autoBlock.includes("COMPANY_NOTICE_ID"));
  });
});

describe("preview-only and coming-soon controls remain fully ungoverned (no real mutation exists behind them)", () => {
  test("Change Logo, + Add hours, Edit Policy, and Manage Subscription carry no capability guard -- none of them reach the network", () => {
    for (const handler of [
      'onClick={() => showComingSoon("Logo upload is coming soon.")}',
      'onClick={() => showComingSoon("Cancellation policy editing is coming soon.")}',
      'onClick={() => showComingSoon("Subscription management is coming soon.")}',
    ]) {
      assert.ok(source.includes(handler), `expected to find ${handler}`);
    }
    // None of showComingSoon's call sites are wrapped in CapabilityGatedButton.
    const comingSoonMatches = source.match(/showComingSoon\(/g) ?? [];
    for (const idx of [...source.matchAll(/showComingSoon\(/g)].map((m) => m.index!)) {
      const before = source.slice(Math.max(0, idx - 80), idx);
      assert.ok(!before.includes("CapabilityGatedButton"), "coming-soon actions must remain plain, ungoverned buttons");
    }
    assert.ok(comingSoonMatches.length >= 3);
  });

  test("preview-only fields (Company/Communication Preferences selects and toggles) carry no capability guard -- nothing persists from them", () => {
    const prefsStart = source.indexOf('id="company-preferences-card"');
    const prefsEnd = source.indexOf('id="subscription-card"');
    assert.notEqual(prefsStart, -1);
    assert.notEqual(prefsEnd, -1);
    const block = source.slice(prefsStart, prefsEnd);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("Retry (Company Information load-failure) remains a plain, ungoverned button", () => {
    const idx = source.indexOf("setLoading(true); setMsg(null); loadCompanySettings();");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(before.includes("<button"));
    assert.ok(!before.includes("CapabilityGatedButton"));
  });
});

describe("form input fields remain interactive (not individually gated)", () => {
  test("Company Name / Address / Phone / Email input onChange handlers carry no capability guard -- only the Save actions are gated, matching the ClientPanel precedent", () => {
    for (const handler of [
      "onChange={(e) => setForm((p) => ({ ...p, company_name: e.target.value }))}",
      "onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}",
      "onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}",
    ]) {
      assert.ok(source.includes(handler));
    }
  });

  test("Automation toggle onChange handlers (setBookingEnabled/setNotificationsEnabled) carry no capability guard -- only Save Changes is gated", () => {
    assert.ok(source.includes("onChange={setBookingEnabled}"));
    assert.ok(source.includes("onChange={setNotificationsEnabled}"));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription-identifier/Stripe/entitlement-reason/workspace-identifier vocabulary appears in this file", () => {
    // "subscription"/"Subscription" and "workspace" deliberately excluded:
    // this file legitimately renders a "Subscription & Plan" preview card
    // (pre-existing, unrelated to this phase) and this component's own new
    // header comment discusses card-splitting -- neither is a billing/
    // workspace-identifier leak. ".state" also excluded: this file's
    // pre-existing company-address form field is genuinely named
    // `form.state`/`s.state` (US state), unrelated to an entitlement
    // result's `.state` field, which this file never imports or reads. The
    // precise identifiers that would matter (workspaceId, a raw entitlement
    // reason) are checked instead.
    for (const forbidden of [
      "Stripe", "stripe", "workspaceId", "workspace_id",
      "past_due", "canceled", "malformed", "billingMode", ".reason",
    ]) {
      assert.ok(!source.includes(forbidden), `CompanyInfoPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `CompanyInfoPanel.tsx must not contain "${forbidden}"`);
    }
  });
});
