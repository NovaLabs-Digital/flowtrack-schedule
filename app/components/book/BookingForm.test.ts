// Phase 5D: source-level proof tests for BookingForm.tsx. BookingForm.tsx
// is a .tsx file and cannot be loaded by Node's built-in test runner (this
// repo's only test runner) -- the same limitation documented throughout
// this repo's other .tsx production files. No test file previously existed
// for this component; one is added here because this phase removed a real
// hardcoded-timezone bug (formatSlotTime used a module-level `const
// BUSINESS_TZ = "America/New_York"` regardless of which workspace's slots
// were actually being displayed) and added the "Times shown in ..." label.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./BookingForm.tsx", import.meta.url)), "utf8");
const pageSource = fs.readFileSync(fileURLToPath(new URL("../../book/page.tsx", import.meta.url)), "utf8");

describe("Phase 5D: BookingForm receives the trusted, server-resolved workspace timezone as an explicit prop -- no hardcoded constant remains", () => {
  test("the module-level hardcoded BUSINESS_TZ constant is completely gone", () => {
    assert.ok(!source.includes('const BUSINESS_TZ = "America/New_York";'));
    assert.ok(!source.includes("BUSINESS_TZ"));
  });

  test("Props declares timezone: string, and the component destructures it", () => {
    assert.ok(source.includes("timezone: string;"));
    assert.ok(source.includes("  timezone,"));
    assert.ok(source.includes("export default function BookingForm({"));
  });

  test("formatSlotTime takes an explicit tz parameter and passes it as Intl.DateTimeFormat's timeZone, never a bare/default zone", () => {
    assert.ok(source.includes("function formatSlotTime(iso: string, tz: string): string {"));
    assert.ok(source.includes("timeZone: tz,"));
  });

  test("the one formatSlotTime call site passes the explicit timezone prop", () => {
    assert.ok(source.includes("{formatSlotTime(slot, timezone)}"));
    assert.ok(!source.includes("formatSlotTime(slot)}"), "must never call formatSlotTime with a single argument");
  });

  test("slots are never re-converted into the customer's own device timezone -- no Intl.DateTimeFormat call omits an explicit timeZone, and no navigator/Intl.DateTimeFormat().resolvedOptions() device-zone lookup exists in this file", () => {
    assert.ok(!source.includes("resolvedOptions()"));
    assert.ok(!source.includes("navigator."));
  });
});

describe("Phase 5D: 'Times shown in ...' explanatory label", () => {
  test("imports timezoneLabel from lib/timezone and renders it near the available times, only once slots are actually shown", () => {
    assert.ok(source.includes('import { timezoneLabel } from "@/lib/timezone";'));
    assert.ok(source.includes("Times shown in {timezoneLabel(timezone)}"));
  });

  test("the label is gated on slots.length > 0 (not shown while loading, erroring, or before a service/date is chosen)", () => {
    const idx = source.indexOf("Times shown in {timezoneLabel(timezone)}");
    assert.ok(idx > -1);
    const before = source.slice(Math.max(0, idx - 200), idx);
    assert.match(before, /!slotsLoading && !slotsError && slots\.length > 0/);
  });

  test("the customer is never asked to choose a timezone -- no <select>/dropdown mentions timezone, zone, or UTC offset anywhere in this file", () => {
    assert.ok(!/timezone[\s\S]{0,40}<select/i.test(source));
    assert.ok(!source.includes("Choose your timezone"));
  });
});

describe("Phase 5D: app/book/page.tsx resolves and passes the trusted timezone", () => {
  test("resolves timezone via effectiveTimezone(settingsRes.data?.timezone), scoped to REAL_WORKSPACE_ID's company_settings row", () => {
    assert.ok(pageSource.includes('import { effectiveTimezone } from "@/lib/timezone";'));
    assert.ok(pageSource.includes("const timezone = effectiveTimezone(settingsRes.data?.timezone);"));
    assert.ok(pageSource.includes('.select("booking_enabled, company_name, timezone")'));
  });

  test("passes timezone={timezone} to BookingForm", () => {
    const idx = pageSource.indexOf("<BookingForm");
    const closeIdx = pageSource.indexOf(">", idx);
    const jsx = pageSource.slice(idx, closeIdx);
    assert.match(jsx, /timezone=\{timezone\}/);
  });
});
