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
