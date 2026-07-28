// Phase 5.6D: source-level proof tests for app/terms/page.tsx. Node's test
// runner cannot load .tsx files (the same well-documented limitation hit by
// every .tsx production file in this project), so this proves file
// existence, ScheduleFlowTrack-specific identity, and the exact approved
// billing terms via source inspection rather than rendered DOM.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
// JSX text content wraps across source lines; a raw substring search would
// miss a multi-word phrase split by a line break. Collapsing whitespace
// mirrors how the browser actually renders the text (consecutive whitespace
// collapses to a single space), so this is a more accurate check, not a
// weaker one.
const normalized = source.replace(/\s+/g, " ");

describe("app/terms/page.tsx", () => {
  test("renders the ScheduleFlowTrack product/company identity", () => {
    assert.ok(source.includes("ScheduleFlowTrack Terms of Service"));
    assert.ok(source.includes("Nova Labs Digital LLC"));
  });

  test("effective date is exactly July 26, 2026 (Phase 5.6D: updated for the material cancellation-policy correction below)", () => {
    assert.ok(source.includes("Effective Date: July 26, 2026"));
    assert.ok(!source.includes("Effective Date: July 25, 2026"));
  });

  test("states the approved $24.99 USD monthly price and does not state the FlowTrack $5.49 price", () => {
    assert.ok(source.includes("$24.99 USD per month"));
    assert.ok(!source.includes("$5.49"));
  });

  test("Phase 5.6D: states the exact 30-day free trial terms -- payment method collected, full access, no charge if cancelled, cancellation is IMMEDIATE with no read-only period", () => {
    assert.ok(normalized.includes("ScheduleFlowTrack Pro includes a 30-day free trial"));
    assert.ok(normalized.includes("A payment method is collected when you sign up"));
    assert.ok(normalized.includes("you receive full Pro access during the trial"));
    assert.ok(normalized.includes("If you cancel during the trial, no subscription charge will occur, and your access ends immediately"));
    assert.ok(normalized.includes("trial cancellation does not include the 30-day read-only period described in Section 16"));
    assert.ok(normalized.includes("billing begins automatically at $24.99 USD per month once the trial ends"));
    // The old, superseded wording must not reappear anywhere.
    assert.ok(!normalized.includes("Cancellation during the trial takes effect when the 30-day trial expires, not immediately"));
    assert.ok(!normalized.includes("you retain full access through the exact end of the trial period"));
  });

  test("Phase 5.6F: states the trial is available once per business, not per email/browser/person, and never reset by cancellation/reactivation", () => {
    assert.ok(normalized.includes("The 30-day free trial is available once per customer business"));
    assert.ok(normalized.includes("It belongs to your business account, not to any individual person, email address, or browser"));
    assert.ok(normalized.includes("that business is not eligible for another free trial"));
  });

  test("Phase 5.6F: states a returning/reactivating customer is billed immediately, with no second trial", () => {
    assert.ok(normalized.includes("A returning or reactivating customer may resubscribe at any time, but billing begins immediately at $24.99 USD per month"));
    assert.ok(normalized.includes("no additional trial period is applied"));
  });

  test("Phase 5.6D: states 30 days of owner read-only access applies ONLY after eligible paid access ends, with the approved restrictions", () => {
    assert.ok(normalized.includes("After access under an eligible paid subscription ends (Section 15), you (the business owner) receive 30 calendar days of read-only access"));
    assert.ok(normalized.includes("you cannot create, edit, delete, schedule, reschedule, or send messages"));
    assert.ok(normalized.includes("scheduled reminder notifications are turned off"));
  });

  test("Phase 5.6D: states a trial cancellation does NOT receive the read-only period -- access and notifications end immediately instead", () => {
    assert.ok(normalized.includes("If you cancel during your free trial instead (Section 12), you do not receive this read-only period"));
    assert.ok(normalized.includes("your access, and scheduled reminder notifications, end immediately"));
  });

  test("Phase 5.6E: states employees lose access immediately, without the owner's read-only grace, regardless of how access ended", () => {
    assert.ok(normalized.includes("Employees lose access as soon as your trial or paid access ends"));
    assert.ok(normalized.includes("employees do not receive this read-only period, regardless of how your access ended"));
  });

  test("Phase 5.6D: states operational access locks after the read-only period OR immediately for a canceled trial, with a path to reactivate, no data loss, and no second trial on reactivation", () => {
    assert.ok(normalized.includes("After the 30-day read-only period — or immediately, if your free trial was canceled — operational access to the Service is locked"));
    assert.ok(normalized.includes("still be able to log in and reach billing so you can reactivate"));
    assert.ok(normalized.includes("Reactivating your subscription restores full access with your existing business data intact"));
    assert.ok(normalized.includes("nothing is deleted, altered, or lost during the read-only or locked periods"));
    assert.ok(normalized.includes("does not grant another free trial (Section 12)"));
  });

  test("Phase 5.6E: does not promise permanent/indefinite data retention", () => {
    assert.ok(normalized.includes("We do not promise that your data will be retained indefinitely"));
  });

  test("describes cancellation taking effect at the end of the paid billing period, with access continuing through it", () => {
    assert.ok(normalized.includes("cancellation takes effect at the end of your current paid billing period"));
    assert.ok(normalized.includes("you will continue to have access to the Service through the end of that period"));
  });

  test("Phase 5.6D: describes trial cancellation taking effect immediately, distinct from paid cancellation, with no read-only period", () => {
    assert.ok(normalized.includes("cancellation takes effect immediately, and you do not receive the read-only period described in Section 16"));
    assert.ok(!normalized.includes("cancellation takes effect at the end of the trial, not immediately"));
  });

  test("states the approved non-refund policy, including both approved exceptions", () => {
    assert.ok(normalized.includes("non-refundable"));
    assert.ok(normalized.includes("required by applicable law"));
    assert.ok(normalized.includes("Nova Labs Digital LLC, in its discretion, approves an exception"));
  });

  test("does not promise uninterrupted operation, guaranteed message delivery, or guaranteed business results", () => {
    for (const forbidden of ["100% uptime", "guaranteed delivery", "guarantee delivery", "guaranteed results", "always available"]) {
      assert.ok(!normalized.toLowerCase().includes(forbidden.toLowerCase()), `must not promise "${forbidden}"`);
    }
    assert.ok(normalized.includes("do not guarantee uninterrupted"));
  });

  test("states governing law is Florida, United States, with no arbitration/class-action-waiver/venue clause", () => {
    assert.ok(source.includes("State of Florida, United States"));
    for (const forbidden of ["arbitration", "class action", "class-action", "venue"]) {
      assert.ok(!source.toLowerCase().includes(forbidden), `must not include unapproved clause: "${forbidden}"`);
    }
  });

  test("uses the canonical SUPPORT_EMAIL/SUPPORT_MAILTO_URL constants, never a literal address", () => {
    assert.ok(source.includes('from "@/lib/support"'));
    assert.ok(!source.includes("support@scheduleflowtrack.com"));
  });

  test("Phase 5.6F: never promises a second/repeat free trial", () => {
    for (const forbidden of ["another 30-day free trial", "each time you subscribe", "every subscription includes a trial", "renewed trial"]) {
      assert.ok(!normalized.toLowerCase().includes(forbidden.toLowerCase()), `must not promise "${forbidden}"`);
    }
  });

  test("no placeholder text remains", () => {
    for (const placeholder of ["TODO", "TBD", "Lorem ipsum", "[COMPANY]", "[PRICE]", "PLACEHOLDER"]) {
      assert.ok(!source.includes(placeholder), `must not contain placeholder "${placeholder}"`);
    }
  });

  test("links back to the Privacy Policy and to Login", () => {
    assert.ok(source.includes('href="/privacy"'));
    assert.ok(source.includes('href="/login"'));
  });
});
