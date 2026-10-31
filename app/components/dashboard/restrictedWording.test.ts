// Guided Demo Session watch mode replaces the account/billing restriction
// wording next to disabled change controls with "You're watching. The host
// can give you control." -- and ONLY there: without the provider every
// component keeps its own approved wording (rendered and source checks).
import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, cleanup } from "@testing-library/react";

mock.module("next/navigation", { namedExports: { useRouter: () => ({ push() {}, refresh() {}, replace() {} }) } });
register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: TopBar } = await import("./TopBar.tsx");
const { RestrictedWordingProvider, useRestrictedWording } = await import("./restrictedWording.ts");
const { WATCHING_MESSAGE } = await import("../../../lib/demoSession/client.ts");

const APPROVED = "Changes are temporarily unavailable. See the account notice for details.";

afterEach(() => cleanup());

function topBar(canMutateOperationalData: boolean, wording?: string | null) {
  const bar = React.createElement(TopBar, {
    onGoToday: () => {}, onAdd: () => {}, weekOffset: 0, onWeekChange: () => {}, canMutateOperationalData,
  });
  return render(wording === undefined ? bar : React.createElement(RestrictedWordingProvider, { wording }, bar));
}
const notice = (container: HTMLElement) => container.querySelector("#topbar-restricted-notice")?.textContent ?? null;

describe("restricted wording -- rendered", () => {
  test("the normal app keeps the approved account wording", () => {
    assert.equal(notice(topBar(false).container), APPROVED);
  });

  test("Guided Demo Session watch mode shows the session wording instead", () => {
    assert.equal(WATCHING_MESSAGE, "You're watching. The host can give you control.");
    assert.equal(notice(topBar(false, WATCHING_MESSAGE).container), WATCHING_MESSAGE);
  });

  test("a provider with no wording (the controller) falls back to the approved wording", () => {
    assert.equal(notice(topBar(false, null).container), APPROVED);
  });

  test("no notice at all when changes are allowed", () => {
    assert.equal(notice(topBar(true, WATCHING_MESSAGE).container), null);
  });

  test("useRestrictedWording returns each component's own default without a provider", () => {
    let seen = "";
    function Probe() {
      seen = useRestrictedWording("component default");
      return null;
    }
    render(React.createElement(Probe));
    assert.equal(seen, "component default");
  });
});

describe("restricted wording -- every component, and only the session provides an override", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const components = [
    "app/components/dashboard/AdjustWorkedTimeControl.ts",
    "app/components/dashboard/AppointmentDetailPanel.tsx",
    "app/components/dashboard/AppointmentModal.tsx",
    "app/components/dashboard/ArchivedClientsPanel.tsx",
    "app/components/dashboard/ClientPanel.tsx",
    "app/components/dashboard/CompanyInfoPanel.tsx",
    "app/components/dashboard/MoveConfirmDialog.tsx",
    "app/components/dashboard/RecurringSeriesPanel.tsx",
    "app/components/dashboard/ServicesPanel.tsx",
    "app/components/dashboard/StaffPanel.tsx",
    "app/components/dashboard/TopBar.tsx",
    "app/components/mobile/MobileAppointmentDetail.tsx",
    "app/components/mobile/MobileDashboard.tsx",
  ];

  test("each keeps its approved default and renders it only through useRestrictedWording", () => {
    for (const rel of components) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(src.includes(`const RESTRICTED_WORDING = "${APPROVED}";`), `${rel} keeps the approved default`);
      assert.ok(src.includes("const restrictedWording = useRestrictedWording(RESTRICTED_WORDING);"), `${rel} reads it through the hook`);
      assert.ok(!src.includes("{RESTRICTED_WORDING}") && !/[ ,(]RESTRICTED_WORDING\)/.test(src.replace("useRestrictedWording(RESTRICTED_WORDING)", "")), `${rel} never renders the constant directly`);
    }
  });

  test("no component still defines the wording without the hook", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
          const src = fs.readFileSync(full, "utf8");
          if (src.includes(`"${APPROVED}"`) && !src.includes("useRestrictedWording(RESTRICTED_WORDING)")) offenders.push(full);
        }
      }
    };
    walk(path.join(root, "app"));
    assert.deepEqual(offenders, []);
  });

  test("only the Guided Demo Session page provides an override", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.") && entry.name !== "restrictedWording.ts") {
          if (fs.readFileSync(full, "utf8").includes("<RestrictedWordingProvider")) users.push(path.relative(root, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(path.join(root, "app"));
    assert.deepEqual(users, ["app/demo/session/[id]/SessionClient.tsx"]);
    const session = fs.readFileSync(path.join(root, "app/demo/session/[id]/SessionClient.tsx"), "utf8");
    assert.ok(session.includes("<RestrictedWordingProvider wording={iControl ? null : WATCHING_MESSAGE}>"));
  });
});
