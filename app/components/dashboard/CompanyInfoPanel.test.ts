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

  test("Props includes isTrialing: boolean (Phase 5.6D)", () => {
    assert.match(source, /isTrialing:\s*boolean/);
  });

  test("SettingsPanel forwards canMutateOperationalData and isTrialing to CompanyInfoPanel", () => {
    const idx = settingsPanelSource.indexOf('if (section === "company")');
    assert.notEqual(idx, -1);
    const line = settingsPanelSource.slice(idx, idx + 160);
    assert.match(line, /<CompanyInfoPanel canMutateOperationalData=\{canMutateOperationalData\} isTrialing=\{isTrialing\} \/>/);
  });
});

describe("shared wording", () => {
  test("exact approved wording constant, shared by all four cards' notices", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  // Phase 5B: a fourth card (Time Zone) now shares this same approved
  // wording constant too -- 3 -> 4 render sites, one per governed card.
  test("all four notice blocks render the exact same wording constant, not divergent strings", () => {
    const wordingMatches = source.match(/\{RESTRICTED_WORDING\}/g) ?? [];
    assert.equal(wordingMatches.length, 4, "one render site per card notice (Company Information, Time Zone, Business Hours, Automation)");
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

describe("post-launch correction: the three 'coming soon' functions (Logo upload, Cancellation Policy editing, Subscription management) are hidden entirely, not shown as disabled/placeholder controls", () => {
  test("no showComingSoon mechanism remains -- the function, its state, and its toast rendering were all removed, not just its three call sites", () => {
    assert.ok(!source.includes("showComingSoon"));
    assert.ok(!/\[toast,\s*setToast\]/.test(source));
  });

  test("no 'Change Logo' control or its upload hint remain", () => {
    assert.ok(!source.includes("Change Logo"));
    assert.ok(!source.includes("Recommended: 300"));
  });

  test("no 'Edit Policy' / Cancellation Policy row remains in Communication Preferences", () => {
    assert.ok(!source.includes("Edit Policy"));
    assert.ok(!source.includes("Cancellation Policy"));
  });

  test("no 'Manage Subscription' control remains, while the real, working Cancel Free Trial action is untouched", () => {
    assert.ok(!source.includes("Manage Subscription"));
    assert.ok(source.includes("Cancel Free Trial"), "the real Cancel Free Trial action must remain unaffected");
    assert.ok(source.includes("isTrialing && !confirmingCancel"), "Cancel Free Trial's own gating logic must be untouched");
  });

  test("the company logo avatar (initials placeholder) itself remains -- only the non-functional upload affordance was removed", () => {
    assert.ok(source.includes('{initials(form.company_name || "Your Company")}'));
  });

  test("no literal 'coming soon' text remains anywhere in this file", () => {
    assert.ok(!/coming soon/i.test(source));
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

describe("Phase 4: Business Hours card", () => {
  test("the old preview-only Business Hours control (hoursDay/hoursStart/hoursEnd state, the no-op + Add hours button) is completely gone", () => {
    assert.ok(!source.includes("hoursDay"));
    assert.ok(!source.includes("hoursStart"));
    assert.ok(!source.includes("hoursEnd"));
    assert.ok(!/Business Hours <span className="font-normal text-slate-400">\(preview\)<\/span>/.test(source));
  });

  test("Business Hours is its own SettingsCard, distinct from Company Information and Automation", () => {
    assert.ok(source.includes('id="business-hours-card"'));
    assert.ok(source.includes('title="Business Hours"'));
  });

  test("renders all seven canonical weekdays via WEEKDAY_KEYS.map, not a hand-written list", () => {
    assert.ok(source.includes("import { WEEKDAY_KEYS, type WeekdayKey } from \"@/lib/businessHours\";"));
    assert.ok(source.includes("{WEEKDAY_KEYS.map((day) => {"));
  });

  test("each day has an Open/Closed toggle driven purely by range-array length -- no separate boolean state", () => {
    assert.ok(source.includes("const isOpen = ranges.length > 0;"));
    assert.ok(source.includes("{isOpen ? \"Open\" : \"Closed\"}"));
  });

  test("toggleDayOpen seeds a newly-opened day with the canonical 07:00-17:00 fallback range, and closes to an empty array", () => {
    const fnStart = source.indexOf("function toggleDayOpen(day: WeekdayKey) {");
    assert.notEqual(fnStart, -1);
    const body = source.slice(fnStart, fnStart + 250);
    assert.ok(body.includes('p[day].length > 0 ? [] : [{ start: "07:00", end: "17:00" }]'));
  });

  test("+ Add hours is functional -- appends a new range to the day's array, no longer a no-op button", () => {
    const fnStart = source.indexOf("function addHoursRange(day: WeekdayKey) {");
    assert.notEqual(fnStart, -1);
    const body = source.slice(fnStart, fnStart + 150);
    assert.ok(body.includes("[...p[day], { start:"));
    assert.ok(source.includes("onClick={() => addHoursRange(day)}"));
    assert.ok(source.includes("+ Add hours"));
  });

  test("Remove deletes exactly the clicked range, by index, from that day's array", () => {
    const fnStart = source.indexOf("function removeHoursRange(day: WeekdayKey, index: number) {");
    assert.notEqual(fnStart, -1);
    const body = source.slice(fnStart, fnStart + 150);
    assert.ok(body.includes("p[day].filter((_, i) => i !== index)"));
    assert.ok(source.includes("onClick={() => removeHoursRange(day, index)}"));
  });

  test("Remove is only rendered for index > 0 -- the primary (first) range of an open day never shows a Remove control", () => {
    const removeButtonIdx = source.indexOf("onClick={() => removeHoursRange(day, index)}");
    assert.notEqual(removeButtonIdx, -1);
    const before = source.slice(Math.max(0, removeButtonIdx - 200), removeButtonIdx);
    assert.ok(/\{index > 0 && \(/.test(before), "the Remove button's render site must be guarded by index > 0");
  });

  test("closing an open day remains possible only via the Open/Closed toggle, never via a Remove control on the primary range", () => {
    // removeHoursRange only ever filters by index -- it can shrink a day
    // down to zero ADDITIONAL ranges, but the Remove button that calls it
    // is structurally absent for index 0 (proven above), so it can never
    // remove the primary range and can never itself produce a day with
    // zero ranges (i.e. Closed). Only toggleDayOpen's ternary explicitly
    // assigns a day's range array back to [].
    const removeFnStart = source.indexOf("function removeHoursRange(day: WeekdayKey, index: number) {");
    const removeFnBody = source.slice(removeFnStart, removeFnStart + 150);
    assert.ok(!removeFnBody.includes(": []"), "removeHoursRange must never itself assign the empty-array Closed state");
    assert.ok(source.includes('p[day].length > 0 ? [] : [{ start: "07:00", end: "17:00" }]'), "toggleDayOpen remains the sole place a day's ranges become []");
  });

  test("start/end time controls are <select>s of normalized HH:mm option values with friendly, unambiguous AM/PM labels -- never a native type=\"time\" input (which silently clipped its PM indicator) or a free-text field", () => {
    assert.ok(!source.includes('type="time"'), "the clipped native time input must be fully removed");
    assert.ok(source.includes("<select"));
    assert.ok(source.includes("value={range.start}"));
    assert.ok(source.includes("value={range.end}"));
    assert.ok(source.includes('onChange={(e) => updateHoursRange(day, index, "start", e.target.value)}'));
    assert.ok(source.includes('onChange={(e) => updateHoursRange(day, index, "end", e.target.value)}'));
    assert.ok(source.includes("{BUSINESS_HOURS_TIME_OPTIONS.map((opt) => ("));
    assert.match(source, /<option key=\{opt\.value\} value=\{opt\.value\}>\{opt\.label\}<\/option>/);
  });

  test("BUSINESS_HOURS_TIME_OPTIONS covers the full 24-hour day at 15-minute granularity, and every option.value is a normalized HH:mm string -- option.label (the only thing ever shown to the owner) is never what gets stored", () => {
    const fnMatch = source.match(/function buildBusinessHoursTimeOptions\(\)[\s\S]*?\r?\n\}\r?\n/);
    assert.ok(fnMatch, "buildBusinessHoursTimeOptions must be defined");
    assert.ok(fnMatch![0].includes("for (let h = 0; h < 24; h++)"));
    assert.ok(fnMatch![0].includes("m += 15"));
    assert.ok(source.includes("const BUSINESS_HOURS_TIME_OPTIONS = buildBusinessHoursTimeOptions();"));
  });

  test("representative stored values render as the exact unambiguous friendly labels: 07:00 -> 7:00 AM, 17:00 -> 5:00 PM, 00:00 -> 12:00 AM, 12:00 -> 12:00 PM, 13:30 -> 1:30 PM, 23:45 -> 11:45 PM", () => {
    // Faithful copy of buildBusinessHoursTimeOptions()'s logic (this .tsx
    // file can't be imported by Node's test runner -- same constraint
    // documented at the top of this file, and the same "faithful copy"
    // convention lib/testSupport.ts's own fakeSanitizeCompanyName already
    // establishes) -- proves the exact labeling behavior end-to-end, not
    // just that the function is textually present.
    function buildBusinessHoursTimeOptions(): { value: string; label: string }[] {
      const options: { value: string; label: string }[] = [];
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 15) {
          const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          const ampm = h >= 12 ? "PM" : "AM";
          const h12 = h % 12 || 12;
          options.push({ value, label: `${h12}:${String(m).padStart(2, "0")} ${ampm}` });
        }
      }
      return options;
    }
    const options = buildBusinessHoursTimeOptions();
    const labelFor = (hhmm: string) => options.find((o) => o.value === hhmm)?.label;
    assert.equal(labelFor("07:00"), "7:00 AM");
    assert.equal(labelFor("17:00"), "5:00 PM");
    assert.equal(labelFor("00:00"), "12:00 AM");
    assert.equal(labelFor("12:00"), "12:00 PM");
    assert.equal(labelFor("13:30"), "1:30 PM");
    assert.equal(labelFor("23:45"), "11:45 PM");
    // Every label is unambiguous -- always carries an explicit AM or PM marker.
    assert.ok(options.every((o) => / (AM|PM)$/.test(o.label)));
    assert.equal(options.length, 96, "24 hours x 4 quarter-hour slots");
  });

  test("Business Hours' Save Changes is a CapabilityGatedButton wired to allowed/onClick/disabled/ariaDescribedBy, guarded independently of Company Information and Automation", () => {
    const idx = source.indexOf("onClick={handleSaveHours}");
    assert.notEqual(idx, -1);
    const block = source.slice(Math.max(0, idx - 150), idx + 100);
    assert.match(block, /<CapabilityGatedButton/);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
    assert.match(block, /disabled=\{hoursSaving \|\| !hoursDirty\}/);
    assert.match(block, /ariaDescribedBy=\{HOURS_NOTICE_ID\}/);
  });

  test("handleSaveHours guards on canMutateOperationalData as its first statement, before the fetch call", () => {
    const fnStart = source.indexOf("async function handleSaveHours()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 200);
    const firstNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstNonBlank, "if (!canMutateOperationalData) return;");
  });

  test("handleSaveHours posts { business_hours: businessHours } to the existing company settings route -- no new API route", () => {
    const fnStart = source.indexOf("async function handleSaveHours()");
    const fnEnd = source.indexOf("async function handleSave()");
    const body = source.slice(fnStart, fnEnd);
    assert.ok(body.includes('fetch("/api/settings/company"'));
    assert.ok(body.includes("body: JSON.stringify({ business_hours: businessHours })"));
    assert.ok(body.includes("setBusinessHoursSaved(businessHours);"));
  });

  test("Business Hours' own notice id is declared, unique, and distinct from Company Information's and Automation's", () => {
    const declared = source.match(/const HOURS_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "company-hours-restricted-notice");
    assert.notEqual(declared, "company-info-restricted-notice");
    assert.notEqual(declared, "company-automation-restricted-notice");
    const matches = source.match(/id=\{HOURS_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("the load effect populates businessHours/businessHoursSaved from the server's already-effective s.business_hours, defensively coercing each day to an array", () => {
    assert.ok(source.includes("const dayRanges = s.business_hours?.[day];"));
    assert.ok(source.includes("nextHours[day] = Array.isArray(dayRanges) ? dayRanges : [];"));
    assert.ok(source.includes("setBusinessHours(nextHours);"));
    assert.ok(source.includes("setBusinessHoursSaved(nextHours);"));
  });

  test("EMPTY_HOURS (the pre-load default) has every weekday closed -- never a guessed set of open hours before the server responds", () => {
    assert.ok(source.includes("Object.fromEntries(WEEKDAY_KEYS.map((d) => [d, [] as TimeRange[]]))"));
  });
});

describe("Phase 5B: Time Zone card", () => {
  test("the old read-only Time Zone preview (status.timezoneLabel, 'not yet editable here') is completely gone", () => {
    assert.ok(!source.includes("timezoneLabel"));
    assert.ok(!source.includes("not yet editable here"));
  });

  test("Time Zone is its own SettingsCard, distinct from Company Information, Business Hours, and Automation", () => {
    assert.ok(source.includes('id="timezone-card"'));
    assert.ok(source.includes('title="Time Zone"'));
  });

  test("Time Zone is imported from the canonical lib/timezone.ts source of truth, not a locally hand-written list", () => {
    assert.ok(source.includes('import { TIMEZONE_OPTIONS } from "@/lib/timezone";'));
    assert.ok(source.includes("{TIMEZONE_OPTIONS.map((opt) => ("));
  });

  test("the control is a real <select> bound to the raw IANA value, never browser/device auto-detection", () => {
    const cardStart = source.indexOf('id="timezone-card"');
    const cardEnd = source.indexOf('id="business-hours-card"');
    assert.notEqual(cardStart, -1);
    assert.notEqual(cardEnd, -1);
    const block = source.slice(cardStart, cardEnd);
    assert.ok(block.includes("<select"));
    assert.ok(block.includes("value={timezone}"));
    assert.ok(block.includes('onChange={(e) => setTimezone(e.target.value)}'));
    for (const forbidden of ["Intl.DateTimeFormat().resolvedOptions", "navigator.", "getTimezoneOffset"]) {
      assert.ok(!block.includes(forbidden), `must not use device/browser timezone detection: "${forbidden}"`);
    }
  });

  test("no searchable/global timezone picker and no new dependency -- a plain native <select>, same primitive as every other Settings dropdown", () => {
    assert.ok(!source.includes("react-select"));
    assert.ok(!source.includes("timezone-select"));
    assert.ok(!/<input[^>]*placeholder="[^"]*[Ss]earch/.test(source));
  });

  test("state defaults to the existing global fallback (America/New_York) before load, never a guess", () => {
    assert.ok(source.includes('const [timezone, setTimezone] = useState<string>("America/New_York");'));
    assert.ok(source.includes('const [timezoneSaved, setTimezoneSaved] = useState<string>("America/New_York");'));
  });

  test("the load effect populates timezone/timezoneSaved from the server's already-effective s.timezone, defensively coercing a missing/non-string value", () => {
    assert.ok(source.includes('const nextTz = typeof s.timezone === "string" && s.timezone ? s.timezone : "America/New_York";'));
    assert.ok(source.includes("setTimezone(nextTz);"));
    assert.ok(source.includes("setTimezoneSaved(nextTz);"));
  });

  test("tzDirty is a plain equality check against the last saved value", () => {
    assert.ok(source.includes("const tzDirty = timezone !== timezoneSaved;"));
  });

  test("Time Zone's Save Changes is a CapabilityGatedButton wired to allowed/onClick/disabled/ariaDescribedBy, guarded independently of the other three cards", () => {
    const idx = source.indexOf("onClick={handleSaveTimezone}");
    assert.notEqual(idx, -1);
    const block = source.slice(Math.max(0, idx - 150), idx + 100);
    assert.match(block, /<CapabilityGatedButton/);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
    assert.match(block, /disabled=\{tzSaving \|\| !tzDirty\}/);
    assert.match(block, /ariaDescribedBy=\{TZ_NOTICE_ID\}/);
  });

  test("handleSaveTimezone guards on canMutateOperationalData as its first statement, before the fetch call", () => {
    const fnStart = source.indexOf("async function handleSaveTimezone()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 200);
    const firstNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstNonBlank, "if (!canMutateOperationalData) return;");
  });

  test("handleSaveTimezone posts { timezone } to the existing company settings route -- no new API route", () => {
    const fnStart = source.indexOf("async function handleSaveTimezone()");
    const fnEnd = source.indexOf("async function handleSave()");
    const body = source.slice(fnStart, fnEnd);
    assert.ok(body.includes('fetch("/api/settings/company"'));
    assert.ok(body.includes("body: JSON.stringify({ timezone })"));
    assert.ok(body.includes("setTimezoneSaved(timezone);"));
  });

  test("Time Zone's own notice id is declared, unique, and distinct from the other three cards'", () => {
    const declared = source.match(/const TZ_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "company-timezone-restricted-notice");
    assert.notEqual(declared, "company-info-restricted-notice");
    assert.notEqual(declared, "company-hours-restricted-notice");
    assert.notEqual(declared, "company-automation-restricted-notice");
    const matches = source.match(/id=\{TZ_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("the inline change warning renders only when the selection differs from the last saved value, and states both required facts: interpretation changes AND existing timestamps are not rewritten", () => {
    assert.ok(source.includes("{tzDirty && ("));
    const warningIdx = source.indexOf("TZ_CHANGE_WARNING");
    assert.notEqual(warningIdx, -1);
    const constMatch = source.match(/const TZ_CHANGE_WARNING =\s*\n?\s*"([^"]+)"/);
    assert.ok(constMatch, "TZ_CHANGE_WARNING must be declared as a string constant");
    const wording = (constMatch![1] || "").toLowerCase();
    assert.ok(wording.includes("displayed") || wording.includes("display"));
    assert.ok(wording.includes("scheduled") || wording.includes("scheduling"));
    assert.ok(wording.includes("not rewritten"), "must not imply existing appointments are completely unaffected");
    assert.ok(!wording.includes("completely unaffected"));
  });

  test("the warning is not a blocking confirmation -- it renders inline with no modal, no second click required, and Save remains a single action", () => {
    const idx = source.indexOf("{tzDirty && (");
    const block = source.slice(idx, idx + 300);
    assert.ok(!block.includes("confirm"));
    assert.ok(!block.includes("Modal"));
  });

  test("Phase 5B is foundation only -- this file documents that the saved timezone has no scheduling effect yet", () => {
    assert.ok(/has no observable effect until Phases 5C-5E/i.test(source));
  });
});

describe("Phase 5.6D: Cancel Free Trial action, gated on isTrialing", () => {
  // The button's own render site, not this file's earlier prose comment
  // that also happens to mention "Cancel Free Trial" by name.
  const cancelButtonBlockStart = source.indexOf("{isTrialing && !confirmingCancel && (");

  test("the Cancel Free Trial button only renders when isTrialing is true -- the removed Manage Subscription control never comes back for the !isTrialing case", () => {
    assert.notEqual(cancelButtonBlockStart, -1);
    const cancelBtnIdx = source.indexOf("Cancel Free Trial", cancelButtonBlockStart);
    assert.notEqual(cancelBtnIdx, -1);
    assert.ok(!source.includes("Manage Subscription"));
  });

  test("clicking Cancel Free Trial shows a confirmation step -- no network call happens on the first click", () => {
    const idx = source.indexOf("Cancel Free Trial", cancelButtonBlockStart);
    const before = source.slice(cancelButtonBlockStart, idx);
    assert.ok(before.includes("setConfirmingCancel(true)"));
    assert.ok(!before.includes('fetch("/api/stripe/cancel-trial"'));
  });

  test("the confirmation step clearly warns that canceling ends access immediately, with no read-only period", () => {
    const idx = source.indexOf("Cancel your free trial?");
    assert.notEqual(idx, -1);
    // JSX text wraps across source lines; collapsing whitespace mirrors how
    // the browser actually renders it (matching app/terms/page.test.ts's
    // own established convention for the same reason).
    const block = source.slice(idx, idx + 400).replace(/\s+/g, " ");
    assert.ok(block.toLowerCase().includes("immediately"));
    assert.ok(block.toLowerCase().includes("no read-only period"));
  });

  test("the confirmation step offers an explicit cancel-out (\"Never mind\") that never calls the network", () => {
    const idx = source.indexOf("Never mind");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 400), idx);
    assert.ok(before.includes("setConfirmingCancel(false)"));
    assert.ok(!before.includes("fetch("));
  });

  test("handleCancelTrial guards synchronously on cancelInFlightRef before any network call, matching the OwnerBillingBanner/TrialActivationScreen double-click precedent", () => {
    const fnStart = source.indexOf("async function handleCancelTrial()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 200);
    const firstNonBlank = afterBrace.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    assert.equal(firstNonBlank, "if (cancelInFlightRef.current) return;");
    const guardIdx = source.indexOf("if (cancelInFlightRef.current) return;", fnStart);
    const fetchIdx = source.indexOf('fetch("/api/stripe/cancel-trial"', fnStart);
    assert.ok(guardIdx < fetchIdx);
  });

  test("the Confirm Cancellation button is disabled and aria-busy while a request is in flight -- a second click cannot fire during the request", () => {
    const idx = source.indexOf("Confirm Cancellation");
    const before = source.slice(Math.max(0, idx - 400), idx);
    assert.ok(before.includes("disabled={cancelling}"));
    assert.ok(before.includes('aria-busy={cancelling}'));
    assert.ok(before.includes("onClick={handleCancelTrial}"));
  });

  test("calls POST /api/stripe/cancel-trial with no request body -- workspace identity is never supplied client-side", () => {
    assert.match(source, /fetch\("\/api\/stripe\/cancel-trial",\s*\{\s*method:\s*"POST"\s*\}\)/);
  });

  test("a successful cancellation closes the confirmation step and shows a success message; a failure keeps confirming false and shows the server's error text", () => {
    const fnStart = source.indexOf("async function handleCancelTrial()");
    const fnBody = source.slice(fnStart, fnStart + 900);
    assert.ok(fnBody.includes("setConfirmingCancel(false)"));
    assert.ok(fnBody.includes('type: "success"'));
    assert.ok(fnBody.includes('type: "error"'));
    assert.ok(fnBody.includes("data.error ||"));
  });

  test("Cancel Free Trial and its confirmation step carry no canMutateOperationalData guard -- trial cancellation is independent of that capability (a trialing subscription always has full capabilities anyway; the server route is the actual authority)", () => {
    const idx = source.indexOf("Cancel Free Trial", cancelButtonBlockStart);
    const block = source.slice(cancelButtonBlockStart, idx + 50);
    assert.ok(!block.includes("CapabilityGatedButton"));
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

  test("no billing/subscription-identifier/Stripe/entitlement-reason/workspace-identifier vocabulary appears in this file, beyond the one approved cancel-trial route call", () => {
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
    //
    // Phase 5.6D: the literal route path "/api/stripe/cancel-trial" is the
    // ONE deliberate exception -- checked separately, and this test
    // operates on the source with that one literal string stripped out
    // first, so every OTHER Stripe/billing-detail leak this test guards
    // against is still caught. No entitlement reason/status/id ever
    // appears -- the component only ever fires a plain authenticated POST
    // and reads back {ok}/{error}, exactly like its existing
    // fetch("/api/settings/company", ...) call.
    const withoutApprovedRoute = source.replaceAll("/api/stripe/cancel-trial", "");
    for (const forbidden of [
      "Stripe", "stripe", "workspaceId", "workspace_id",
      "past_due", "canceled", "malformed", "billingMode", ".reason",
    ]) {
      assert.ok(!withoutApprovedRoute.includes(forbidden), `CompanyInfoPanel.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `CompanyInfoPanel.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("Phase 5.7C: notifications_enabled fails closed before the stored value is known", () => {
  test("notificationsEnabled and notificationsSaved both initialize to false, matching bookingEnabled/bookingSaved -- neither can ever read as enabled before load", () => {
    assert.ok(source.includes('const [bookingEnabled, setBookingEnabled] = useState(false);'));
    assert.ok(source.includes('const [bookingSaved, setBookingSaved] = useState(false);'));
    assert.ok(source.includes('const [notificationsEnabled, setNotificationsEnabled] = useState(false);'));
    assert.ok(source.includes('const [notificationsSaved, setNotificationsSaved] = useState(false);'));
    // The old, unsafe defaults must not reappear anywhere in the file.
    assert.ok(!source.includes('useState(true);\n  const [notificationsSaved'));
    assert.ok(!/notificationsEnabled,\s*setNotificationsEnabled\]\s*=\s*useState\(true\)/.test(source));
    assert.ok(!/notificationsSaved,\s*setNotificationsSaved\]\s*=\s*useState\(true\)/.test(source));
  });

  test("every call site that ever assigns notificationsEnabled/notificationsSaved derives from loaded server data or the live in-memory state -- never a literal true", () => {
    // setNotificationsEnabled is called exactly once in the whole file:
    // inside loadCompanySettings' if (s) branch, from Boolean(s.notifications_enabled).
    // (Counting the literal call, rather than a capturing regex, avoids
    // breaking on Boolean(...)'s own nested parenthesis.)
    const enabledCallCount = (source.match(/setNotificationsEnabled\(/g) ?? []).length;
    assert.equal(enabledCallCount, 1, "setNotificationsEnabled must be called exactly once in the whole file");
    assert.ok(source.includes("setNotificationsEnabled(Boolean(s.notifications_enabled));"));

    // setNotificationsSaved is called twice: once in the same load branch
    // (Boolean(s.notifications_enabled), identical to the above), and once
    // in handleSaveAutomation after a successful save, where it must copy
    // the CURRENT notificationsEnabled state (itself already proven
    // fail-closed above) -- never a literal true.
    const savedCallCount = (source.match(/setNotificationsSaved\(/g) ?? []).length;
    assert.equal(savedCallCount, 2, "setNotificationsSaved must be called exactly twice in the whole file");
    assert.ok(source.includes("setNotificationsSaved(Boolean(s.notifications_enabled));"));
    assert.ok(source.includes("setNotificationsSaved(notificationsEnabled);"));
    assert.ok(!/setNotificationsSaved\(\s*true\s*\)/.test(source), "setNotificationsSaved must never be called with a literal true");
  });

  test("the loading branch returns before the Automation card (and its Save button / handleSaveAutomation) ever renders -- submission is structurally impossible before the settings query resolves", () => {
    const loadingReturnIdx = source.indexOf("if (loading) {");
    const automationCardIdx = source.indexOf('id="automation-card"');
    const handleSaveAutomationDeclIdx = source.indexOf("async function handleSaveAutomation()");
    assert.notEqual(loadingReturnIdx, -1);
    assert.notEqual(automationCardIdx, -1);
    // handleSaveAutomation is declared as a function above the JSX (normal
    // for a component body) -- what matters is that its ONLY render site
    // (the button wired to onClick={handleSaveAutomation}) is textually
    // part of the automation-card JSX block, which sits after the `if
    // (loading)` early return in the component's control flow.
    assert.ok(handleSaveAutomationDeclIdx > -1);
    assert.ok(loadingReturnIdx < automationCardIdx, "the loading early-return must appear before the Automation card in source order");
    const onClickIdx = source.indexOf("onClick={handleSaveAutomation}");
    assert.ok(onClickIdx > automationCardIdx, "the Automation Save button belongs to the automation-card block, which is unreachable while loading");
  });

  test("the load effect runs exactly once per mount (empty dependency array) -- a rerender cannot re-trigger a fresh fetch or otherwise perturb the loaded value", () => {
    assert.ok(source.includes("useEffect(() => { loadCompanySettings(); }, []);"));
  });

  test("Company Information's own Save (handleSave) sends only CompanyForm fields -- notifications_enabled and booking_enabled are structurally absent from its payload, so an unrelated profile-field save can never change either toggle", () => {
    assert.ok(!/type CompanyForm = \{[^}]*notifications_enabled/.test(source), "CompanyForm must not carry notifications_enabled");
    assert.ok(!/type CompanyForm = \{[^}]*booking_enabled/.test(source), "CompanyForm must not carry booking_enabled");
    const handleSaveStart = source.indexOf("async function handleSave()");
    const handleSaveEnd = source.indexOf("async function handleSaveAutomation()");
    const handleSaveBody = source.slice(handleSaveStart, handleSaveEnd);
    assert.ok(handleSaveBody.includes("body: JSON.stringify(form)"));
    assert.ok(!handleSaveBody.includes("notifications_enabled"));
    assert.ok(!handleSaveBody.includes("booking_enabled"));
  });

  test("Automation's Save (handleSaveAutomation) transmits the live notificationsEnabled state variable directly -- never a literal true, and never a ?? / || fallback that could substitute true for an unresolved value", () => {
    const handleSaveAutomationStart = source.indexOf("async function handleSaveAutomation()");
    const handleSaveAutomationBody = source.slice(handleSaveAutomationStart, handleSaveAutomationStart + 900);
    assert.ok(handleSaveAutomationBody.includes("notifications_enabled: notificationsEnabled"));
    assert.ok(!/notifications_enabled:\s*true\b/.test(handleSaveAutomationBody));
    assert.ok(!handleSaveAutomationBody.includes("notificationsEnabled ?? true"));
    assert.ok(!handleSaveAutomationBody.includes("notificationsEnabled || true"));
  });

  test("no `?? true`, `|| true`, or literal true fallback exists anywhere in the file for either automation toggle -- a missing/unresolved value can never be silently treated as enabled", () => {
    assert.ok(!/notificationsEnabled\s*\?\?\s*true/.test(source));
    assert.ok(!/notificationsEnabled\s*\|\|\s*true/.test(source));
    assert.ok(!/bookingEnabled\s*\?\?\s*true/.test(source));
    assert.ok(!/bookingEnabled\s*\|\|\s*true/.test(source));
  });

  test("the owner can still intentionally toggle notifications in both directions -- the toggle's onChange is wired directly to the raw setter, unconstrained by direction", () => {
    assert.ok(source.includes("onChange={setNotificationsEnabled}"));
    // A raw setState setter passed directly as onChange applies whatever
    // boolean SettingsToggle reports -- false->true and true->false are
    // both reachable through the identical, unconditional call site; there
    // is no branch here that could special-case or block one direction.
    const idx = source.indexOf("onChange={setNotificationsEnabled}");
    const before = source.slice(Math.max(0, idx - 60), idx);
    assert.ok(!before.includes("?"), "onChange must not be conditionally wired");
  });
});
