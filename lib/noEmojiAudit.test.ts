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
//
// A real escape: IncomeProjection.tsx's hide/show toggle wrote its emoji as
// JS Unicode ESCAPE SEQUENCES ("\u{1F648}" the see-no-evil monkey,
// "\u{1F441}️" the eye) rather than literal embedded characters --
// which the ORIGINAL version of this scan missed entirely, since those
// escapes are just ASCII text ("\", "u", "{", digits) in the source file
// until JS evaluates the string at runtime. Every line is now decoded
// first (both \u{H+} and \uHHHH forms) before the pictographic scan runs,
// so an escaped emoji is caught exactly like a literal one.
import { test, describe } from "node:test";
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

// Decodes JS Unicode escape sequences ("\u{1F648}" and "\uD83D"-style
// 4-hex-digit escapes, including adjacent surrogate-pair escapes like
// "🙈") into the real characters they represent at runtime, so
// a decorative emoji written as an escape in source is scanned exactly
// like one embedded as a literal character. A malformed/unmatched escape
// is left as-is rather than thrown on -- this is a best-effort decode for
// an audit, not a JS parser.
function decodeUnicodeEscapes(line: string): string {
  return line
    .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (m, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return m;
      }
    })
    .replace(/\\u([0-9A-Fa-f]{4})(\\u[0-9A-Fa-f]{4})?/g, (m, hex1, hex2) => {
      try {
        const code1 = parseInt(hex1, 16);
        if (hex2) {
          const code2 = parseInt(hex2.slice(2), 16);
          return String.fromCharCode(code1, code2);
        }
        return String.fromCharCode(code1);
      } catch {
        return m;
      }
    });
}

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
        const decoded = decodeUnicodeEscapes(line);
        for (const match of decoded.matchAll(PICTOGRAPHIC_RE)) {
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

// Regression: IncomeProjection.tsx's hide/show toggle wrote its emoji as
// JS Unicode escape sequences ("\u{1F648}" the see-no-evil monkey emoji,
// "\u{1F441}️" the eye) rather than literal embedded characters,
// which the scan missed entirely until decodeUnicodeEscapes was added.
// These tests pin the decoder against the exact real source text that
// slipped through, so this specific blind spot can never silently reopen.
describe("decodeUnicodeEscapes -- catches emoji written as \\u{...} escapes, not just literal characters", () => {
  test("decodes the exact escaped monkey emoji that slipped past the original literal-character-only scan", () => {
    const decoded = decodeUnicodeEscapes('{hidden ? "\\u{1F648}" : "\\u{1F441}\\uFE0F"}');
    assert.ok([...decoded.matchAll(PICTOGRAPHIC_RE)].length >= 2, "both the monkey and the eye must be detected once decoded");
  });

  test("a line with no escapes at all decodes to itself (no false positives introduced)", () => {
    assert.equal(decodeUnicodeEscapes('const x = "plain text, no escapes";'), 'const x = "plain text, no escapes";');
  });

  test("a scan of the decoded (not raw) text is what the real scan() now uses -- the raw escape text itself (backslash-u-digits) is never pictographic on its own", () => {
    const raw = '"\\u{1F648}"';
    assert.equal([...raw.matchAll(PICTOGRAPHIC_RE)].length, 0, "the undecoded escape text has no pictographic characters");
    assert.ok([...decodeUnicodeEscapes(raw).matchAll(PICTOGRAPHIC_RE)].length > 0, "decoding it reveals the real emoji");
  });
});
