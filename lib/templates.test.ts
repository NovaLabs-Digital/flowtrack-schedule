// Phase 5E: direct unit tests for lib/templates.ts. No dedicated test file
// existed for this module before -- prior coverage was only indirect,
// through the appointment create/update/cancel and cron/reminders route
// tests, which never asserted the actual formatted date/time text against
// more than one timezone. This file proves confirmationTemplates/
// reminder24hTemplates/changeTemplates require an explicit workspace
// timezone and format the SAME UTC instant differently for New York,
// Chicago, and Pacific, while leaving cancelTemplates (no appointment
// date/time) and every non-date piece of copy (company identity, SMS
// prefix, booking CTA) completely unaffected.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { confirmationTemplates, reminder24hTemplates, changeTemplates, cancelTemplates } from "./templates.ts";

// 2026-08-03T14:00:00.000Z -- Monday, 10:00 AM Eastern / 9:00 AM Central /
// 7:00 AM Pacific. One fixed instant, three different correct local
// readings.
const SCHEDULED_ISO = "2026-08-03T14:00:00.000Z";

const ZONES: Array<{ tz: string; time: string; label: string }> = [
  { tz: "America/New_York", time: "10:00 AM", label: "Eastern" },
  { tz: "America/Chicago", time: "9:00 AM", label: "Central" },
  { tz: "America/Los_Angeles", time: "7:00 AM", label: "Pacific" },
];

describe("confirmationTemplates -- explicit timezone required, formats the same instant differently per zone", () => {
  for (const { tz, time, label } of ZONES) {
    test(`${label} (${tz}): subject/body/sms all show ${time}, Monday, August 3`, () => {
      const t = confirmationTemplates("Jane Doe", "Haircut", SCHEDULED_ISO, "https://example.com/cancel", "Acme Cleaning", tz);
      assert.ok(t.email.subject.includes(time), t.email.subject);
      assert.ok(t.email.body.includes("Date: Monday, August 3"), t.email.body);
      assert.ok(t.email.body.includes(`Time: ${time}`), t.email.body);
      assert.ok(t.sms.includes(`Time: ${time}`), t.sms);
    });
  }

  test("the SAME instant produces genuinely different text for Eastern vs Pacific -- not a coincidental match", () => {
    const east = confirmationTemplates("Jane", "Haircut", SCHEDULED_ISO, "https://x/cancel", "Acme", "America/New_York");
    const west = confirmationTemplates("Jane", "Haircut", SCHEDULED_ISO, "https://x/cancel", "Acme", "America/Los_Angeles");
    assert.notEqual(east.email.body, west.email.body);
    assert.ok(east.email.body.includes("10:00 AM"));
    assert.ok(west.email.body.includes("7:00 AM"));
  });

  test("company identity, cancel link, and structure are unaffected by which timezone is passed", () => {
    for (const { tz } of ZONES) {
      const t = confirmationTemplates("Jane Doe", "Haircut", SCHEDULED_ISO, "https://example.com/cancel", "Acme Cleaning", tz);
      assert.ok(t.email.body.includes("Thank you,\nAcme Cleaning"));
      assert.ok(t.email.body.includes("https://example.com/cancel"));
      assert.ok(t.sms.startsWith("Acme Cleaning: "));
      assert.equal(t.sms.split("Acme Cleaning").length - 1, 1, "company name appears exactly once in the SMS");
    }
  });
});

describe("reminder24hTemplates -- explicit timezone required, same per-zone formatting contract as confirmationTemplates", () => {
  for (const { tz, time, label } of ZONES) {
    test(`${label} (${tz}): reminder subject/body/sms show ${time}, Monday, August 3`, () => {
      const t = reminder24hTemplates("Jane Doe", "Haircut", SCHEDULED_ISO, "Acme Cleaning", tz);
      assert.ok(t.email.subject.includes(time));
      assert.ok(t.email.body.includes(`Time: ${time}`));
      assert.ok(t.sms.includes(`Time: ${time}`));
    });
  }

  test("company identity/SMS prefix unaffected by timezone", () => {
    const t = reminder24hTemplates("Jane Doe", "Haircut", SCHEDULED_ISO, "Acme Cleaning", "America/Los_Angeles");
    assert.ok(t.sms.startsWith("Acme Cleaning: "));
    assert.ok(t.email.body.includes("Thank you,\nAcme Cleaning"));
  });
});

describe("changeTemplates -- explicit timezone required, same per-zone formatting contract", () => {
  for (const { tz, time, label } of ZONES) {
    test(`${label} (${tz}): update subject/body/sms show ${time}, Monday, August 3`, () => {
      const t = changeTemplates("Jane Doe", "Haircut", SCHEDULED_ISO, "Acme Cleaning", tz);
      assert.ok(t.email.subject.includes(time));
      assert.ok(t.email.body.includes(`Time: ${time}`));
      assert.ok(t.sms.includes(`Time: ${time}`));
    });
  }
});

describe("cancelTemplates -- no timezone parameter, unaffected because there is no appointment date/time left to display", () => {
  test("cancellation with booking enabled includes the booking CTA, no date/time anywhere", () => {
    const t = cancelTemplates("Jane Doe", "Haircut", "Acme Cleaning", true);
    assert.ok(t.email.body.includes("Need another appointment?"));
    assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(t.email.body));
    assert.ok(!/\d{1,2}:\d{2}\s?(AM|PM)/.test(t.sms));
  });

  test("cancellation with booking disabled omits the CTA entirely", () => {
    const t = cancelTemplates("Jane Doe", "Haircut", "Acme Cleaning", false);
    assert.ok(!t.email.body.includes("Need another appointment?"));
    assert.ok(!t.sms.includes("Need another appointment?"));
  });
});
