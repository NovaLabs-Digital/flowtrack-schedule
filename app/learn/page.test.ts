// app/learn/page.tsx is a .tsx file. Node's built-in test runner (this
// repo's only test runner) cannot load a .tsx file at all -- the same
// well-documented limitation hit by every .tsx production file in this
// codebase. This proves what SOURCE INSPECTION can actually prove --
// imports, metadata, structure, and exact wording. The client-side search
// component it renders (LearningCenterSearch.ts) has its own real
// rendered-interaction tests in LearningCenterSearch.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/learn/page.tsx", () => {
  test("exports page metadata with the required title/description", () => {
    assert.match(source, /export const metadata: Metadata = \{/);
    assert.ok(source.includes("Learning Center"));
    assert.ok(source.includes("Learn how to use ScheduleFlowTrack with step-by-step guides and short videos."));
  });

  test("renders the exact required page heading and intro copy", () => {
    assert.ok(source.includes("ScheduleFlowTrack Learning Center"));
    assert.ok(source.includes("Learn how to use ScheduleFlowTrack with step-by-step guides and short videos."));
  });

  test("renders LearningCenterSearch, passing it the real GUIDES data (not a hardcoded/duplicated list)", () => {
    assert.match(source, /import LearningCenterSearch from "@\/app\/components\/learn\/LearningCenterSearch";/);
    assert.match(source, /import \{ GUIDES \} from "@\/lib\/learningCenter";/);
    assert.match(source, /<LearningCenterSearch guides=\{GUIDES\} \/>/);
  });

  test("has a nav linking back to the public home page, and a footer linking to Terms/Privacy/Contact", () => {
    assert.match(source, /<nav[\s\S]*?<\/nav>/);
    const navMatch = source.match(/<nav[\s\S]*?<\/nav>/)![0];
    assert.match(navMatch, /href="\/"/);

    const footerMatch = source.match(/<footer[\s\S]*?<\/footer>/)![0];
    assert.match(footerMatch, /href="\/terms"/);
    assert.match(footerMatch, /href="\/privacy"/);
    assert.match(footerMatch, /href="\/contact"/);
  });

  test("this is a plain server component -- no \"use client\" directive, no client-only hooks used directly in this file", () => {
    assert.ok(!source.trimStart().startsWith('"use client"'));
    assert.ok(!source.includes("useState") && !source.includes("useEffect"));
  });
});
