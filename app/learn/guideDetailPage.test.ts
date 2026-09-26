// Tests for app/learn/[slug]/page.tsx -- NOT co-located inside that folder
// (which every other page.test.ts in this codebase otherwise is) because
// Node's built-in test runner resolves CLI file arguments through glob
// matching, and "[slug]" is glob syntax for a single-character class --
// passed directly as a CLI arg (as npm test's explicit file list does),
// "app/learn/[slug]/page.test.ts" silently matches zero files (0 tests, no
// error) rather than the literal bracket-named directory Next.js's App
// Router itself requires for a dynamic route segment. Living one level up
// and reading the page source via a plain relative path sidesteps this
// entirely -- fs.readFileSync never does glob expansion, only the test
// runner's own CLI-level file discovery does.
//
// app/learn/[slug]/page.tsx is a .tsx file. Node's test runner cannot load
// a .tsx file at all -- the same well-documented limitation hit by every
// .tsx production file in this codebase. This proves what SOURCE
// INSPECTION can actually prove: generateStaticParams/generateMetadata
// wiring, the notFound() guard, and the exact conditional structure (video
// only when present, related guides only when present).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { GUIDES } from "@/lib/learningCenter";

const source = fs.readFileSync(fileURLToPath(new URL("./[slug]/page.tsx", import.meta.url)), "utf8");

describe("app/learn/[slug]/page.tsx", () => {
  test("generateStaticParams pre-renders every Phase 1 guide slug from the real GUIDES data (not a hardcoded/duplicated list)", () => {
    assert.match(source, /import \{ GUIDES, getGuideBySlug, getRelatedGuides, categoryName \} from "@\/lib\/learningCenter";/);
    assert.match(source, /export function generateStaticParams\(\) \{/);
    assert.match(source, /return GUIDES\.map\(\(guide\) => \(\{ slug: guide\.slug \}\)\);/);
  });

  test("params is awaited (Next.js 16 async params), not destructured synchronously", () => {
    assert.match(source, /params: Promise<\{ slug: string \}>/);
    assert.match(source, /const \{ slug \} = await params;/);
  });

  test("generateMetadata resolves a per-guide title/description, with a distinct fallback for an unknown slug", () => {
    assert.match(source, /export async function generateMetadata\(/);
    assert.match(source, /if \(!guide\) \{\s*return \{ title: "Guide Not Found — Schedule FlowTrack" \};/);
    assert.match(source, /title: `\$\{guide\.title\} — Schedule FlowTrack Learning Center`/);
    assert.match(source, /description: guide\.description,/);
  });

  test("an unknown slug calls notFound(), never renders a blank/broken page", () => {
    assert.match(source, /import \{ notFound \} from "next\/navigation";/);
    assert.match(source, /if \(!guide\) notFound\(\);/);
  });

  test("video: nothing renders when neither videoId nor videoUrl is set -- no empty video box", () => {
    const idx = source.indexOf("{(guide.videoId || guide.videoUrl) && (");
    assert.notEqual(idx, -1, "the video block must be conditionally rendered on videoId/videoUrl presence");
  });

  test("video: a YouTube videoId embeds via the standard /embed/ URL; a direct videoUrl falls back to a plain <video>", () => {
    assert.match(source, /src=\{`https:\/\/www\.youtube\.com\/embed\/\$\{guide\.videoId\}`\}/);
    assert.match(source, /<video controls className="w-full rounded-2xl border border-slate-200" src=\{guide\.videoUrl\} \/>/);
  });

  test("renders the guide's title, category, description, and steps as an ordered list", () => {
    assert.match(source, /\{categoryName\(guide\.category\)\}/);
    assert.match(source, /<h1[^>]*>\{guide\.title\}<\/h1>/);
    assert.match(source, /<p[^>]*>\{guide\.description\}<\/p>/);
    assert.match(source, /<ol[^>]*>/);
    assert.match(source, /\{guide\.steps\.map\(\(step, i\) => \(/);
  });

  test("related guides section only renders when there are related guides", () => {
    assert.match(source, /const related = getRelatedGuides\(guide\);/);
    assert.match(source, /\{related\.length > 0 && \(/);
  });

  test("has a nav linking back to /learn and Home, and a footer linking to Terms/Privacy", () => {
    const navMatch = source.match(/<nav[\s\S]*?<\/nav>/)![0];
    assert.match(navMatch, /href="\/"/);
    assert.match(navMatch, /href="\/learn"/);

    const footerMatch = source.match(/<footer[\s\S]*?<\/footer>/)![0];
    assert.match(footerMatch, /href="\/learn"/);
    assert.match(footerMatch, /href="\/terms"/);
    assert.match(footerMatch, /href="\/privacy"/);
  });

  test("this is a plain (async) server component -- no \"use client\" directive", () => {
    assert.ok(!source.trimStart().startsWith('"use client"'));
  });
});

describe("every real Phase 1 guide would resolve on this route (sanity cross-check against lib/learningCenter.ts)", () => {
  test("GUIDES is non-empty and every slug is a valid URL segment (no slashes, no whitespace)", () => {
    assert.ok(GUIDES.length > 0);
    for (const g of GUIDES) {
      assert.ok(/^[a-z0-9-]+$/.test(g.slug), `slug "${g.slug}" is not a clean URL segment`);
    }
  });
});
