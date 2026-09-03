// Phase 5.7D: source-level proof that the landing page's "Get Started"
// links to /signup and "Login" still links to /login. No test previously
// existed for this file at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/page.tsx -- landing page CTA links (Phase 5.7D)", () => {
  test("the 'Get Started' link points to /signup", () => {
    const idx = source.indexOf("Get Started");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 200), idx);
    assert.ok(before.includes('href="/signup"'), "the nearest preceding href for the Get Started link must be /signup");
    assert.ok(!before.includes('href="/login"'), "Get Started must no longer point to /login");
  });

  test("every 'Login' labeled link still points to /login, unchanged", () => {
    // Search backward from each ">Login<" text occurrence for its nearest
    // preceding href, rather than forward from every href (which can skip
    // past the unrelated "Get Started" link entirely and pair its own href
    // with a much later "Login" text instead).
    const textMatches = [...source.matchAll(/>\s*Login\s*</g)];
    assert.ok(textMatches.length >= 1);
    for (const m of textMatches) {
      const before = source.slice(0, m.index);
      const hrefMatch = before.match(/href="([^"]+)"(?![^]*href=)/);
      assert.ok(hrefMatch, "expected a preceding href for this Login-labeled element");
      assert.equal(hrefMatch![1], "/login");
    }
  });
});

describe("app/page.tsx -- hero trial CTA (Phase 5.7D-R13-V1)", () => {
  function heroBlock() {
    const heroStart = source.indexOf("{/* Hero */}");
    const featuresStart = source.indexOf("{/* Features */}");
    assert.notEqual(heroStart, -1);
    assert.notEqual(featuresStart, -1);
    return source.slice(heroStart, featuresStart);
  }

  test("the hero has a primary 'Start Free Trial' CTA linking to /signup", () => {
    const hero = heroBlock();
    const idx = hero.indexOf("Start Free Trial");
    assert.notEqual(idx, -1, "expected a Start Free Trial CTA in the hero");
    const before = hero.slice(Math.max(0, idx - 200), idx);
    assert.ok(before.includes('href="/signup"'), "the hero's Start Free Trial CTA must link to /signup");
  });

  test("'Try Live Demo' and 'Login' remain available in the hero action group", () => {
    const hero = heroBlock();
    assert.ok(hero.includes("Try Live Demo"));
    assert.ok(/>\s*Login\s*</.test(hero), "expected a Login link in the hero action group");
  });

  test("Login is styled as a lighter, non-competing action relative to the primary trial CTA", () => {
    const hero = heroBlock();
    const loginIdx = hero.search(/>\s*Login\s*</);
    assert.notEqual(loginIdx, -1);
    const before = hero.slice(Math.max(0, loginIdx - 200), loginIdx);
    // The primary CTA uses the solid dark background (bg-[#0f172a]); Login
    // must not share that treatment so it doesn't visually compete.
    assert.ok(!before.includes("bg-[#0f172a]"), "Login must not use the primary CTA's solid background");
  });

  test("the price/trial disclosure sits immediately after the hero action group, still associated with it", () => {
    const hero = heroBlock();
    const actionGroupEnd = hero.indexOf("</div>", hero.indexOf("Start Free Trial"));
    const disclosureIdx = hero.indexOf("days free, then");
    assert.notEqual(actionGroupEnd, -1);
    assert.notEqual(disclosureIdx, -1);
    assert.ok(disclosureIdx > actionGroupEnd, "disclosure must come after the action group closes");
    // Nothing but the disclosure's own opening tag between the action group
    // and the disclosure text -- i.e. it's the very next element.
    const between = hero.slice(actionGroupEnd, disclosureIdx);
    assert.ok(!/href=/.test(between), "no other link must sit between the hero actions and the disclosure");
  });
});

describe("app/page.tsx -- transparent pricing (Phase 5.7D-R13)", () => {
  test("imports the shared, non-secret price/trial display constants -- not a locally hardcoded literal", () => {
    assert.ok(
      source.includes(
        'import { SUBSCRIPTION_PRICE_DISPLAY, SUBSCRIPTION_TRIAL_DAYS } from "@/lib/billingDisplay";'
      )
    );
    // Rendered price ($24.99) and trial length (30) are proven by
    // lib/billingDisplay.test.ts, which imports and asserts on the real
    // constant values -- this file proves the page actually uses them.
    assert.ok((source.match(/\{SUBSCRIPTION_PRICE_DISPLAY\}/g) || []).length >= 2, "expected the price to appear in both the hero disclosure and the pricing card");
    assert.ok(source.includes("{SUBSCRIPTION_TRIAL_DAYS}"));
  });

  test("the hero shows a trial/cancellation disclosure near the primary CTAs, secondary to them", () => {
    const heroStart = source.indexOf("{/* Hero */}");
    const featuresStart = source.indexOf("{/* Features */}");
    assert.notEqual(heroStart, -1);
    assert.notEqual(featuresStart, -1);
    const heroBlock = source.slice(heroStart, featuresStart);
    assert.ok(heroBlock.includes("days free, then"));
    assert.ok(heroBlock.includes("/month. Cancel anytime."));
    // Smaller/muted text than the primary CTA buttons -- kept secondary.
    assert.ok(heroBlock.includes("text-xs text-slate-500"));
  });

  test("a single ScheduleFlowTrack Pro pricing card appears before the final CTA/footer, with the required feature list", () => {
    const pricingStart = source.indexOf("{/* Pricing */}");
    const ctaStart = source.indexOf("{/* CTA */}");
    const footerStart = source.indexOf("{/* Footer */}");
    assert.notEqual(pricingStart, -1);
    assert.ok(pricingStart < ctaStart && ctaStart < footerStart, "pricing card must sit before the final CTA and footer");

    const pricingBlock = source.slice(pricingStart, ctaStart);
    assert.ok(pricingBlock.includes("ScheduleFlowTrack Pro"));
    assert.ok(pricingBlock.includes("/ month"));
    assert.ok(pricingBlock.includes("-day free trial"));
    assert.ok(pricingBlock.includes("No annual contract. Cancel anytime."));

    for (const feature of [
      "Complete scheduling dashboard",
      "Recurring appointments",
      "Client and service management",
      "Projected revenue",
      "Employee worked hours",
      "Email and SMS notification controls",
      "Desktop and mobile access",
    ]) {
      assert.ok(pricingBlock.includes(feature), `expected feature list to include "${feature}"`);
    }

    // Only one plan/card -- no tiers, no annual pricing, no separate page.
    assert.equal((source.match(/ScheduleFlowTrack Pro/g) || []).length, 1);
    assert.ok(!source.includes("/pricing"));
  });

  test("the pricing card's 'Start Free Trial' CTA leads to the existing signup flow", () => {
    const pricingStart = source.indexOf("{/* Pricing */}");
    const ctaStart = source.indexOf("{/* CTA */}");
    const pricingBlock = source.slice(pricingStart, ctaStart);
    const ctaIdx = pricingBlock.indexOf("Start Free Trial");
    assert.notEqual(ctaIdx, -1);
    const before = pricingBlock.slice(Math.max(0, ctaIdx - 200), ctaIdx);
    assert.ok(before.includes('href="/signup"'), "the Start Free Trial CTA must point to the existing /signup page");
  });
});

describe("app/page.tsx -- footer Contact Us link (replaces the old Support mailto link)", () => {
  test("the footer renders a Contact Us link pointing to /contact", () => {
    const footerStart = source.indexOf("{/* Footer */}");
    assert.notEqual(footerStart, -1);
    const footerBlock = source.slice(footerStart);
    const hrefIdx = footerBlock.indexOf('href="/contact"');
    assert.notEqual(hrefIdx, -1, "expected a footer link to /contact");
    assert.ok(footerBlock.slice(hrefIdx, hrefIdx + 100).includes("Contact Us"));
  });

  test("no SUPPORT_MAILTO_URL import or Support mailto link remains -- every footer click has exactly one purpose", () => {
    assert.ok(!source.includes("SUPPORT_MAILTO_URL"));
    assert.ok(!source.includes("@/lib/support"));
    const footerStart = source.indexOf("{/* Footer */}");
    assert.notEqual(footerStart, -1);
    const footerBlock = source.slice(footerStart);
    assert.ok(!/>\s*Support\s*</.test(footerBlock), "the redundant 'Support' mailto link must be gone from the footer");
  });
});
