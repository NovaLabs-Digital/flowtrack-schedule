// Google Analytics 4 integration: source-level proof for
// app/components/GoogleAnalytics.tsx. This is a .tsx file and cannot be
// rendered by this repo's test runner (Node's built-in runner has no
// .tsx/JSX loader) -- the same documented limitation as every other
// production .tsx component in this codebase. What source inspection can
// prove: the env-var gate, the exact official gtag.js snippet shape, the
// non-blocking load strategy, and that the measurement ID is never
// hardcoded.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./GoogleAnalytics.tsx", import.meta.url)), "utf8");
// Scoped to real code, not this file's own explanatory prose -- the header
// comment legitimately names "signup"/"stripe"/etc. by name to document
// what this integration deliberately does NOT send.
const code = source.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

describe("GoogleAnalytics.tsx -- renders only when configured, never hardcoded", () => {
  test("reads the measurement id from NEXT_PUBLIC_GA_MEASUREMENT_ID, the exact required variable name", () => {
    assert.ok(source.includes("process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID"));
  });

  test("returns null (renders nothing) when the measurement id is not set", () => {
    const idx = source.indexOf("const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;");
    assert.notEqual(idx, -1);
    const after = source.slice(idx, idx + 150);
    assert.ok(/if\s*\(!measurementId\)\s*return null;/.test(after));
  });

  test("never hardcodes a literal GA measurement id (G-XXXXXXXXXX) anywhere in this file", () => {
    assert.ok(!/G-[A-Z0-9]{6,}/.test(source), "the real measurement ID must never appear as a literal in source");
  });
});

describe("GoogleAnalytics.tsx -- official gtag.js shape, non-blocking, exactly one tag", () => {
  test("loads the official gtag.js loader script from googletagmanager.com, parameterized by the env-derived id", () => {
    assert.ok(source.includes("https://www.googletagmanager.com/gtag/js?id=${measurementId}"));
  });

  test("both <Script> tags use the non-blocking afterInteractive strategy", () => {
    const matches = [...source.matchAll(/strategy="afterInteractive"/g)];
    assert.equal(matches.length, 2, "expected exactly two Script tags, both afterInteractive");
  });

  test("imports Script from next/script -- the official Next.js App Router mechanism, not a raw <script> tag or next/head", () => {
    assert.ok(source.includes('import Script from "next/script";'));
    assert.ok(!source.includes("<script"), "must not use a raw <script> element");
    assert.ok(!source.includes("next/head"));
  });

  test("exactly one gtag('config', ...) call and one gtag('js', ...) call -- a single Google tag, not duplicated", () => {
    assert.equal((source.match(/gtag\('config',/g) ?? []).length, 1);
    assert.equal((source.match(/gtag\('js',/g) ?? []).length, 1);
  });

  test("only GA4 automatic page/enhanced measurement is configured -- no custom event (signup, trial, Stripe, conversion) is sent", () => {
    for (const forbidden of ["signup", "trial", "stripe", "conversion", "purchase", "checkout"]) {
      assert.ok(!code.toLowerCase().includes(forbidden), `must not send a custom "${forbidden}" event yet`);
    }
    // Only the two stock calls -- js and config -- appear, no gtag('event', ...).
    assert.ok(!code.includes("gtag('event'"));
  });
});

describe("GoogleAnalytics.tsx -- no unrelated system touched", () => {
  test("no Supabase, Stripe, Twilio, Resend, session, or auth import", () => {
    for (const forbidden of ["supabase", "stripe", "twilio", "resend", "session", "@/lib/entitlement"]) {
      assert.ok(!code.toLowerCase().includes(forbidden), `must not reference "${forbidden}"`);
    }
  });
});
