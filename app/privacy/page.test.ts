// Phase 5.6D: source-level proof tests for app/privacy/page.tsx. Same
// .tsx-unloadable-by-node:test limitation as app/terms/page.test.ts -- this
// proves identity, accurate data-handling disclosures, and the absence of
// unsupported claims via source inspection.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
// See app/terms/page.test.ts for why phrase checks use whitespace-collapsed
// text rather than the raw, line-wrapped JSX source.
const normalized = source.replace(/\s+/g, " ");

describe("app/privacy/page.tsx", () => {
  test("renders the ScheduleFlowTrack product/company identity", () => {
    assert.ok(source.includes("ScheduleFlowTrack Privacy Policy"));
    assert.ok(source.includes("Nova Labs Digital LLC"));
  });

  test("effective date is exactly July 26, 2026 (Phase 5.6D: updated for the material Section 14 correction resolving a direct contradiction with the corrected Terms)", () => {
    assert.ok(source.includes("Effective Date: July 26, 2026"));
    assert.ok(!source.includes("Effective Date: July 25, 2026"));
  });

  test("does not claim ScheduleFlowTrack stores raw payment-card details -- states Stripe processes them instead", () => {
    assert.ok(source.includes("Stripe"));
    assert.ok(source.includes("are not stored on ScheduleFlowTrack"));
  });

  test("does not claim any compliance certification that was not verified in this phase", () => {
    for (const forbidden of ["SOC 2", "HIPAA", "PCI DSS compliant", "ISO 27001", "GDPR compliant", "CCPA compliant"]) {
      assert.ok(!source.includes(forbidden), `must not claim unverified compliance: "${forbidden}"`);
    }
  });

  test("does not invent a fixed retention period or promise immediate deletion", () => {
    assert.ok(!normalized.toLowerCase().includes("delete your data immediately"));
    assert.ok(normalized.includes("do not currently apply a single fixed retention period"));
  });

  test("Phase 5.6D: states data is retained after cancellation to support reactivation -- the 30-day read-only window applies ONLY to paid access ending; a canceled trial locks immediately with no read-only period", () => {
    assert.ok(normalized.includes("Your business data is retained after your trial or paid access ends so that you can return and reactivate"));
    assert.ok(normalized.includes("If you cancel during your free trial, operational access is locked immediately, with no read-only period"));
    assert.ok(normalized.includes("if a paid subscription&apos;s access ends, the account owner instead has 30 days of read-only access to existing data before operational access is locked"));
    assert.ok(normalized.includes("the underlying business data remains stored once operational access is locked"));
    assert.ok(normalized.includes("reactivating restores full access to it"));
    // The old, superseded universal-30-days wording (which contradicted the
    // Phase 5.6D Terms correction) must not reappear.
    assert.ok(!normalized.includes("For 30 days after access ends, the account owner has read-only access to existing data"));
  });

  test("Phase 5.6E: states the annual-review / 12-month / 30-day-notice future deletion policy accurately, without promising an automated system", () => {
    assert.ok(normalized.includes("does not become eligible for deletion earlier than 12 months after trial or paid access ended"));
    assert.ok(normalized.includes("at least 30 days"));
    assert.ok(normalized.includes("notice and an opportunity to reactivate or request your data"));
    assert.ok(normalized.includes("Active, paying accounts are never included in this kind of review"));
    assert.ok(normalized.includes("No automated deletion system exists today"));
  });

  test("Phase 5.6E: states billing/security/fraud-prevention/legal records may be retained longer than other data", () => {
    assert.ok(normalized.includes("Some billing, security, fraud-prevention, or legally required records may be retained longer"));
  });

  test("states deletion requests go through the verified support contact, not a self-service flow", () => {
    assert.ok(normalized.includes("does not currently offer fully automated, self-service account or data deletion"));
  });

  test("states no third-party analytics/advertising/tracking is used", () => {
    assert.ok(normalized.includes("does not use third-party analytics, advertising, or cross-site tracking"));
  });

  test("states personal information is not sold", () => {
    assert.ok(normalized.includes("do not sell personal information"));
  });

  test("uses the canonical SUPPORT_EMAIL/SUPPORT_MAILTO_URL constants, never a literal address", () => {
    assert.ok(source.includes('from "@/lib/support"'));
    assert.ok(!source.includes("support@scheduleflowtrack.com"));
  });

  test("no placeholder text remains and no FlowTrack $5.49 price appears", () => {
    for (const placeholder of ["TODO", "TBD", "Lorem ipsum", "[COMPANY]", "PLACEHOLDER"]) {
      assert.ok(!source.includes(placeholder), `must not contain placeholder "${placeholder}"`);
    }
    assert.ok(!source.includes("$5.49"));
  });

  test("links back to the Terms of Service and to Login", () => {
    assert.ok(source.includes('href="/terms"'));
    assert.ok(source.includes('href="/login"'));
  });
});
