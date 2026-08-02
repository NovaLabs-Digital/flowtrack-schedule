// app/layout.tsx: source-level proof that GoogleAnalytics is wired in
// exactly once at the root, so every route (landing, login, signup, legal,
// dashboard, mobile) inherits it from this single layout -- there is no
// other layout.tsx in this app (app/layout.tsx is the only one), so
// mounting it here covers the entire application by construction.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./layout.tsx", import.meta.url)), "utf8");

describe("app/layout.tsx -- Google Analytics mounted exactly once at the root", () => {
  test("imports GoogleAnalytics from the dedicated component, not defined inline", () => {
    assert.ok(source.includes('import GoogleAnalytics from "@/app/components/GoogleAnalytics";'));
  });

  test("<GoogleAnalytics /> is rendered exactly once, inside <body>", () => {
    const matches = [...source.matchAll(/<GoogleAnalytics\s*\/>/g)];
    assert.equal(matches.length, 1, "GoogleAnalytics must be mounted exactly once, never duplicated per-route");
    const bodyIdx = source.indexOf("<body");
    const gaIdx = source.indexOf("<GoogleAnalytics");
    assert.ok(bodyIdx > -1 && gaIdx > bodyIdx, "GoogleAnalytics must render inside <body>");
  });

  test("this is the only layout.tsx anywhere under app/ -- confirms root-level mounting covers every route with no override", () => {
    const appDir = fileURLToPath(new URL(".", import.meta.url));
    const found: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "layout.tsx") found.push(full);
      }
    }
    walk(appDir);
    assert.equal(found.length, 1, `expected exactly one layout.tsx, found: ${found.join(", ")}`);
  });
});
