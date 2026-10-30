// SOURCE INSPECTION, matching this codebase's established convention for
// .tsx files not loaded by this repo's test runner.
//
// Bug found live (Stage 2 verification): this component's iframe was
// hardcoded to src="/dashboard", which requires a real session cookie --
// but the browser-local demo (/demo) never creates one by design, so the
// "Mobile Admin" tour step showed the real /login sign-in form inside the
// phone frame instead of the mobile dashboard, for every isLocalDemo
// session. Fixed by making the iframe source conditional.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileExperiencePreview.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(fileURLToPath(new URL("../dashboard/DashboardShell.tsx", import.meta.url)), "utf8");

describe("MobileExperiencePreview: the iframe source depends on isLocalDemo", () => {
  test("isLocalDemo is an optional prop defaulting to false -- the real shared-backend tester path (which never passes it) is unchanged", () => {
    assert.match(source, /isLocalDemo\?:\s*boolean/);
    assert.match(source, /isLocalDemo = false/);
  });

  test("the iframe src is /demo for isLocalDemo, /dashboard otherwise -- /dashboard needs a real session cookie that /demo never has", () => {
    assert.match(source, /src=\{isLocalDemo \? "\/demo" : "\/dashboard"\}/);
  });

  test("DashboardShell forwards isLocalDemo to MobileExperiencePreview", () => {
    assert.match(shellSource, /<MobileExperiencePreview isLocalDemo=\{isLocalDemo\} \/>/);
  });
});
