// Repo-wide regression guard: no decorative/emoji-style glyph may appear in
// any product source file (app/, lib/) ever again, without someone having
// to remember to extend a per-component check.
//
// The test criterion matches the methodology used for the emoji-removal
// polish pass itself: a character is a "decorative emoji" here when either
// (a) it is followed by U+FE0F (VARIATION SELECTOR-16), which explicitly
// forces emoji-style rendering regardless of the base character's own
// default, or (b) its own Unicode default presentation is EMOJI (phone,
// pin, calendar, people, trash, envelope, etc. -- colorful by default,
// no VS16 needed). A small, explicit allowlist of characters whose Unicode
// default presentation is TEXT (plain, monochrome, typographic) was
// originally permitted on that technical basis alone -- but the owner's
// direction is stricter than "default presentation": NO user-facing
// glyph that LOOKS like an emoji at all, full stop, even one most engines
// render as plain/monochrome by default. U+2699 (the settings gear) was
// removed on exactly this basis -- LeftBar/MobileBottomNav now use
// lucide-react's Settings icon instead -- and is deliberately NOT in the
// allowlist below, specifically so it can never silently reappear.
// What remains allowed is now a narrower, deliberately-curated set of
// genuine typographic/status symbols, not merely "has text presentation":
//   U+21A9 ↩  -- "back/return" arrow (Sign Out)
//   U+2714 ✔  -- status check mark (ServicesPanel enable/disable)
//   U+2718 ✘  -- status X mark (ServicesPanel enable/disable)
//   U+26A0 ⚠  -- bare warning sign, used only in Learning Center prose
//                describing the UI's own (non-emoji) warning icon -- the
//                moment it's followed by U+FE0F it becomes forbidden again,
//                exactly like every other character here.
// A real currency "$", plain arrows (←, →, ↻), and ordinary punctuation are
// never flagged at all -- they are outside the Extended_Pictographic set
// this scan targets, not merely allowlisted.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["app", "lib"];
const SCAN_EXTS = new Set([".tsx", ".ts"]);
const VS16 = "️";
const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}️?/gu;
const ALLOWED_BARE_CODEPOINTS = new Set([0x21a9, 0x2714, 0x2718, 0x26a0]);

type Violation = { file: string; line: number; char: string; context: string };

function scan(): Violation[] {
  const violations: Violation[] = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!SCAN_EXTS.has(path.extname(entry.name))) continue;
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue; // test fixture prose, not rendered product UI
      const content = fs.readFileSync(full, "utf8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(PICTOGRAPHIC_RE)) {
          const text = match[0];
          const hasVS16 = text.endsWith(VS16);
          const base = hasVS16 ? text.slice(0, -1) : text;
          const codePoint = base.codePointAt(0)!;
          const allowed = !hasVS16 && ALLOWED_BARE_CODEPOINTS.has(codePoint);
          if (!allowed) {
            violations.push({
              file: path.relative(ROOT, full).replace(/\\/g, "/"),
              line: i + 1,
              char: text,
              context: line.trim().slice(0, 100),
            });
          }
        }
      });
    }
  }
  for (const root of SCAN_ROOTS) walk(path.join(ROOT, root));
  return violations;
}

test("no decorative/emoji-style glyph appears anywhere in app/ or lib/ product source", () => {
  const violations = scan();
  if (violations.length > 0) {
    const report = violations.map((v) => `  ${v.file}:${v.line} [${v.char}] ${v.context}`).join("\n");
    assert.fail(
      `Found ${violations.length} decorative emoji-style character(s) in product source. ` +
        `Replace with the existing lucide-react icon system (or plain text where no icon adds value), ` +
        `matching the SFT visual-polish pass:\n${report}`
    );
  }
});

test("the allowlist itself stays exactly the four approved typographic/status symbols (the settings gear was deliberately removed) -- documents intent, catches an accidental allowlist edit", () => {
  assert.deepEqual(
    [...ALLOWED_BARE_CODEPOINTS].sort((a, b) => a - b),
    [0x2714, 0x2718, 0x21a9, 0x26a0].sort((a, b) => a - b)
  );
  assert.ok(!ALLOWED_BARE_CODEPOINTS.has(0x2699), "the settings gear (U+2699) must never be re-added to the allowlist");
});
