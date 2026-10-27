// Post-launch correction: source-level proof that the desktop sidebar's
// "Contact / Need Help?" link is present, uses the canonical support
// address, and sits directly above Settings. LeftBar.tsx is a .tsx file
// and cannot be rendered by this repo's test runner (see every other .tsx
// production file in this codebase for the same documented limitation) --
// this file proves what source inspection can prove.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./LeftBar.tsx", import.meta.url)), "utf8");

describe("LeftBar.tsx -- Contact / Need Help? link (post-launch correction)", () => {
  test("uses the canonical SUPPORT_MAILTO_URL constant, never a literal address", () => {
    assert.ok(source.includes('import { SUPPORT_MAILTO_URL } from "@/lib/support";'));
    assert.ok(!source.includes("support@scheduleflowtrack.com"), "must not hardcode the address inline");
  });

  test("the Contact link is a plain mailto: <a>, not a button/form/API call", () => {
    const containerIdx = source.indexOf("{/* Bottom settings shortcut */}");
    assert.notEqual(containerIdx, -1);
    const anchorIdx = source.indexOf("<a", containerIdx);
    const textIdx = source.indexOf("Contact / Need Help?", containerIdx);
    assert.notEqual(anchorIdx, -1);
    assert.notEqual(textIdx, -1);
    const block = source.slice(anchorIdx, textIdx);
    assert.ok(block.includes("href={SUPPORT_MAILTO_URL}"));
    assert.ok(!block.includes("fetch("), "must not trigger any network request");
    assert.ok(!block.includes("<button"), "the Contact element itself must be an <a>, not a <button>");
  });

  test("the Contact link renders directly above the Settings button, both inside the same bottom-shortcut container", () => {
    const containerIdx = source.indexOf("{/* Bottom settings shortcut */}");
    assert.notEqual(containerIdx, -1);
    const contactAnchorIdx = source.indexOf("<a", containerIdx);
    const settingsButtonIdx = source.indexOf("<button", containerIdx);
    assert.notEqual(contactAnchorIdx, -1);
    assert.notEqual(settingsButtonIdx, -1);
    assert.ok(contactAnchorIdx < settingsButtonIdx, "the Contact <a> must render before (above) the Settings <button>");
    // The Settings button is the very next interactive element after Contact.
    const between = source.slice(contactAnchorIdx, settingsButtonIdx);
    assert.equal((between.match(/<a\b/g) ?? []).length, 1, "exactly one <a> (Contact itself) between the container start and Settings");
    assert.equal((between.match(/<button\b/g) ?? []).length, 0, "no other button renders between Contact and Settings");
  });

  test("the Contact link is not gated by canMutateOperationalData or any capability check -- it's a plain external navigation, not a mutation", () => {
    const containerIdx = source.indexOf("{/* Bottom settings shortcut */}");
    const anchorIdx = source.indexOf("<a", containerIdx);
    const textIdx = source.indexOf("Contact / Need Help?", containerIdx);
    const block = source.slice(anchorIdx, textIdx);
    assert.ok(!block.includes("CapabilityGatedButton"));
  });
});

describe("LeftBar.tsx -- collapsible icon strip", () => {
  test("accepts collapsed and onToggleCollapsed props", () => {
    assert.match(source, /collapsed: boolean;/);
    assert.match(source, /onToggleCollapsed: \(\) => void;/);
  });

  test("imports PanelLeftClose/PanelLeftOpen from lucide-react and swaps between them based on collapsed", () => {
    assert.match(source, /PanelLeftClose, PanelLeftOpen/);
    assert.match(source, /collapsed \? \(\s*<PanelLeftOpen/);
    assert.match(source, /\) : \(\s*<PanelLeftClose/);
  });

  test("the toggle button has an accessible name and aria-expanded reflecting the CURRENT (not toggled-to) state", () => {
    const btnIdx = source.indexOf("onClick={onToggleCollapsed}");
    assert.notEqual(btnIdx, -1);
    const block = source.slice(btnIdx, btnIdx + 300);
    assert.match(block, /aria-label=\{collapsed \? "Expand sidebar" : "Collapse sidebar"\}/);
    assert.match(block, /aria-expanded=\{!collapsed\}/);
  });

  test("every NavButton (Day/Weekdays/Week/Month) receives a label and forwards collapsed, so each stays operable and accessibly named when icon-only", () => {
    const viewSectionIdx = source.indexOf('<div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-1 mb-2">');
    const clientsSectionIdx = source.indexOf("{/* Clients */}");
    const viewSection = source.slice(viewSectionIdx, clientsSectionIdx);
    const labelMatches = [...viewSection.matchAll(/label="(Day|Weekdays|Week|Month)"/g)].map((m) => m[1]);
    assert.deepEqual(labelMatches, ["Day", "Weekdays", "Week", "Month"]);
    const collapsedMatches = (viewSection.match(/collapsed=\{collapsed\}/g) ?? []).length;
    assert.equal(collapsedMatches, 4, "all four NavButtons forward the collapsed prop");
  });

  test("NavButton itself always sets aria-label/title from its label prop, and visually hides its text label (not removes it) when collapsed", () => {
    const navButtonDef = source.slice(source.indexOf("function NavButton("), source.indexOf("export default function LeftBar("));
    assert.match(navButtonDef, /aria-label=\{label\}/);
    assert.match(navButtonDef, /title=\{label\}/);
    assert.match(navButtonDef, /className=\{collapsed \? "sr-only" : ""\}/, "text stays in the DOM (sr-only), not removed -- screen readers can still reach it via the label/aria-label too, but this keeps the button's accessible name computation robust either way");
  });

  test("the Clients section (header + list) is hidden entirely when collapsed, replaced by a flex-1 spacer so Contact/Settings/Sign Out stay pinned to the bottom", () => {
    const clientsSectionIdx = source.indexOf("{/* Clients */}");
    const bottomSectionIdx = source.indexOf("{/* Bottom settings shortcut */}");
    assert.notEqual(clientsSectionIdx, -1);
    assert.notEqual(bottomSectionIdx, -1);
    const block = source.slice(clientsSectionIdx, bottomSectionIdx);
    assert.match(block, /\{collapsed \? \(/);
    assert.match(block, /<div className="flex-1" \/>/);
    assert.match(block, /data-tour="clients-list"/, "the client list itself still exists in source, just conditionally unrendered");
  });

  test("clientsHidden (an existing, unrelated per-session preference) is untouched by the collapsed feature -- still its own toggle, still controls only the list's own content", () => {
    assert.match(source, /clientsHidden \? "Show" : "Hide"/);
    assert.match(source, /onClick=\{onToggleClientsHidden\}/);
  });

  test("Contact / Settings / Sign Out each get title+aria-label and visually hide (not remove) their text label when collapsed, while remaining real <a>/<button> elements", () => {
    const bottomIdx = source.indexOf("{/* Bottom settings shortcut */}");
    const bottomBlock = source.slice(bottomIdx);
    assert.match(bottomBlock, /title="Contact \/ Need Help\?"/);
    assert.match(bottomBlock, /aria-label="Contact \/ Need Help\?"/);
    assert.match(bottomBlock, /title="Settings"/);
    assert.match(bottomBlock, /aria-label="Settings"/);
    assert.match(bottomBlock, /title="Sign Out"/);
    assert.match(bottomBlock, /aria-label="Sign Out"/);
    const srOnlyCount = (bottomBlock.match(/className=\{collapsed \? "sr-only" : ""\}/g) ?? []).length;
    assert.equal(srOnlyCount, 3, "Contact, Settings, and Sign Out each wrap their visible text the same way");
  });
});

describe("Phase 3: Month appears as a fourth View option, after Day/Weekdays/Week", () => {
  test("the View section renders exactly four NavButtons: Day, Weekdays, Week, Month, in that order", () => {
    const viewSectionIdx = source.indexOf('<div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 px-1 mb-2">');
    const clientsSectionIdx = source.indexOf("{/* Clients */}");
    assert.notEqual(viewSectionIdx, -1);
    assert.notEqual(clientsSectionIdx, -1);
    const viewSection = source.slice(viewSectionIdx, clientsSectionIdx);
    const labels = [...viewSection.matchAll(/>\s*(Day|Weekdays|Week|Month)\s*<\/NavButton>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["Day", "Weekdays", "Week", "Month"]);
  });

  test("the Month button calls onChangeView(\"month\") and is active only when viewMode is \"month\" and centerMode is \"schedule\"", () => {
    const idx = source.indexOf('onClick={() => onChangeView("month")}');
    assert.notEqual(idx, -1);
    const block = source.slice(Math.max(0, idx - 200), idx);
    assert.match(block, /active=\{viewMode === "month" && centerMode === "schedule"\}/);
  });

  test("Month does not silently reuse the Week icon/behavior -- it is its own NavButton entry, not a relabeled duplicate", () => {
    const weekIdx = source.indexOf('onClick={() => onChangeView("week")}');
    const monthIdx = source.indexOf('onClick={() => onChangeView("month")}');
    assert.notEqual(weekIdx, -1);
    assert.notEqual(monthIdx, -1);
    assert.ok(weekIdx < monthIdx, "Month must render after Week, not replace it");
  });
});
