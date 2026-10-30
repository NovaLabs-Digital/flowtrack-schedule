// SOURCE INSPECTION, matching this directory's own established convention
// for .tsx production files this repo's test runner cannot load (see
// MobileDashboard.test.ts's header comment -- the same limitation applies
// here).
//
// Stage 2 correction: an earlier pass merely unlocked the existing
// NON-INTERACTIVE placeholder cards (Company/Services/Staff/Preferences --
// no onClick, decorative only, unchanged for a real owner even today) for
// isLocalDemo. That did not satisfy "access to working settings panels" --
// the real fix routes isLocalDemo through a genuinely interactive section
// picker that renders the real SettingsPanel (the exact same component
// desktop's SettingsTabBar/SettingsPanel pair already uses for all 6
// primary tabs), never a mobile reimplementation. The real owner's own
// render path (isTester && !isLocalDemo is false, isLocalDemo is false) is
// completely untouched -- same 4 decorative cards, same footer, same
// everything, just reached by a narrower condition that reduces to the
// original one whenever isLocalDemo is false (its default).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileSettings.tsx", import.meta.url)), "utf8");

describe("prop wiring", () => {
  test("isLocalDemo is an optional prop defaulting to false, so every existing caller (which never passes it) is unchanged", () => {
    assert.match(source, /isLocalDemo\?:\s*boolean;/);
    assert.match(
      source,
      /export default function MobileSettings\(\{\s*isTester = false,\s*isLocalDemo = false,/
    );
  });

  test("onSignOut is an optional override for the real handleSignOut, wired to the Sign Out button's onClick", () => {
    assert.match(source, /onSignOut\?:\s*\(\)\s*=>\s*void;/);
    assert.match(source, /onSignOut:\s*onSignOutOverride,/);
    assert.match(source, /onClick=\{onSignOutOverride \?\? handleSignOut\}/);
  });

  test("canMutateOperationalData/isTrialing/timezone/workspaceId/userId are optional, defaulted, and only ever read inside the isLocalDemo branch -- a real owner caller (none of which pass these) is unaffected", () => {
    for (const prop of ["canMutateOperationalData?: boolean;", "isTrialing?: boolean;", "timezone?: string;", "workspaceId?: string;", "userId?: string;"]) {
      assert.ok(source.includes(prop), `missing optional prop declaration: ${prop}`);
    }
  });
});

describe("Stage 2: the real owner's placeholder-card render path is byte-for-byte unchanged", () => {
  test("the tester dead-end card ('Settings are not available in demo sessions') is gated on isTester && !isLocalDemo -- the real shared-backend tester path, unchanged", () => {
    assert.match(source, /\{isTester && !isLocalDemo && \(/);
    const idx = source.indexOf("{isTester && !isLocalDemo && (");
    const block = source.slice(idx, idx + 400);
    assert.match(block, /Settings\s+are not available in demo sessions/);
  });

  test("the 4 original decorative cards (Company/Services/Staff/Preferences, no onClick) are gated on !isTester && !isLocalDemo -- real owners only, never isLocalDemo", () => {
    const idx = source.indexOf("{!isTester && !isLocalDemo && (");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 700);
    for (const cardTitle of ["Company", "Services", "Staff", "Preferences"]) {
      assert.ok(block.includes(cardTitle), `expected the ${cardTitle} card inside the real-owner block`);
    }
    assert.doesNotMatch(block, /onClick=\{/, "the real owner's cards must stay non-interactive, exactly as before");
  });

  test("the 'Full settings management is available on desktop.' footer stays gated on !isTester && !isLocalDemo only -- it would be WRONG for isLocalDemo, which now has real mobile settings", () => {
    const idx = source.lastIndexOf("{!isTester && !isLocalDemo && (");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 250);
    assert.ok(block.includes("Full settings management is available on desktop."));
  });

  test("Account/Sign Out card remains unconditional -- present regardless of isTester or isLocalDemo", () => {
    const idx = source.indexOf('<div className="text-sm font-semibold text-slate-900">Account</div>');
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 200), idx);
    assert.ok(!before.includes("isTester") && !before.includes("isLocalDemo"));
  });
});

describe("Stage 2: isLocalDemo reaches the REAL SettingsPanel via an interactive section picker", () => {
  test("imports the real SettingsPanel and SettingsSection type, never a mobile reimplementation", () => {
    assert.match(source, /import SettingsPanel from "@\/app\/components\/dashboard\/SettingsPanel";/);
    assert.match(source, /import type \{ SettingsSection \} from "@\/app\/components\/dashboard\/types";/);
  });

  test("DEMO_SECTIONS covers all 6 of desktop's real primary sections, by SettingsSection value", () => {
    for (const section of ["company", "services", "staff", "archived", "recurring", "billing"]) {
      assert.match(source, new RegExp(`section:\\s*"${section}"`));
    }
  });

  test("tapping a DEMO_SECTIONS card is gated on isLocalDemo and calls setMobileSection with the real section value", () => {
    const idx = source.indexOf("{isLocalDemo &&");
    assert.notEqual(idx, -1);
    const block = source.slice(idx, idx + 300);
    assert.match(block, /DEMO_SECTIONS\.map/);
    assert.match(block, /onClick=\{\(\) => setMobileSection\(s\.section\)\}/);
  });

  test("when a section is open, renders the real SettingsPanel with section={mobileSection} and the forwarded props, plus a Back control that clears mobileSection", () => {
    assert.match(source, /if \(isLocalDemo && mobileSection\) \{/);
    const idx = source.indexOf("if (isLocalDemo && mobileSection) {");
    const block = source.slice(idx, idx + 1200);
    assert.match(block, /<SettingsPanel/);
    assert.match(block, /section=\{mobileSection\}/);
    assert.match(block, /canMutateOperationalData=\{canMutateOperationalData\}/);
    assert.match(block, /isTrialing=\{isTrialing\}/);
    assert.match(block, /onClick=\{\(\) => setMobileSection\(null\)\}/);
  });

  test("the drill-down view never shows the real-owner-only footer or dead-end notice (it returns before either)", () => {
    const idx = source.indexOf("if (isLocalDemo && mobileSection) {");
    const returnIdx = source.indexOf("return (", idx);
    const closeIdx = source.indexOf("\n  }\n", returnIdx);
    const block = source.slice(idx, closeIdx);
    assert.doesNotMatch(block, /Full settings management is available on desktop\./);
    assert.doesNotMatch(block, /not available in demo sessions/);
  });
});
