// Post-launch correction: source-level proof that the mobile bottom nav's
// Contact link is present, uses the canonical support address, and sits
// directly before Settings -- matching the desktop sidebar (LeftBar.tsx).
// MobileBottomNav.tsx is a .tsx file and cannot be rendered by this repo's
// test runner (see every other .tsx production file in this codebase for
// the same documented limitation) -- this file proves what source
// inspection can prove.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileBottomNav.tsx", import.meta.url)), "utf8");

describe("MobileBottomNav.tsx -- Contact link (post-launch correction)", () => {
  test("uses the canonical SUPPORT_MAILTO_URL constant, never a literal address", () => {
    assert.ok(source.includes('import { SUPPORT_MAILTO_URL } from "@/lib/support";'));
    assert.ok(!source.includes("support@scheduleflowtrack.com"), "must not hardcode the address inline");
  });

  test("Contact is a plain mailto: <a>, not one of the state-driven TABS buttons", () => {
    const idx = source.indexOf("href={SUPPORT_MAILTO_URL}");
    assert.notEqual(idx, -1);
    const around = source.slice(Math.max(0, idx - 100), idx + 200);
    assert.ok(around.includes("<a"));
    assert.ok(!around.includes("onChange"), "must not be wired into the tab-switching handler");
  });

  test("Contact renders directly before Settings in the nav's DOM order", () => {
    const contactIdx = source.indexOf("href={SUPPORT_MAILTO_URL}");
    const settingsIdx = source.indexOf('onClick={() => onChange("settings")}');
    assert.notEqual(contactIdx, -1);
    assert.notEqual(settingsIdx, -1);
    assert.ok(contactIdx < settingsIdx, "Contact must render immediately before Settings");
  });

  test("Settings remains reachable and still reflects active state, now rendered outside the TABS array", () => {
    assert.ok(!source.includes('{ key: "settings"'), "Settings was pulled out of the TABS array to make room for Contact directly before it");
    assert.ok(source.includes('active === "settings"'));
  });

  test("the grid still evenly divides all five items (Today, Schedule, Clients, Contact, Settings)", () => {
    assert.ok(source.includes("grid-cols-5"));
    assert.ok(!source.includes("grid-cols-4"));
  });
});
