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
