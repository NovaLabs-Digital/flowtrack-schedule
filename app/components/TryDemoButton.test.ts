// SOURCE INSPECTION, matching this repo's convention for small client
// components whose only interesting behavior is "what it calls": the demo
// entry flow must never make a network request or create a real session.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./TryDemoButton.tsx", import.meta.url)), "utf8");

describe("TryDemoButton: local demo entry gate, no real sign-in", () => {
  test("never calls fetch (no /api/auth/login request, so no session cookie)", () => {
    assert.doesNotMatch(source, /fetch\(/);
    assert.doesNotMatch(source, /\/api\/auth\/login/);
  });

  test("uses the local entry gate and routes to /demo", () => {
    assert.match(source, /from "@\/lib\/demoLocal\/entryGate"/);
    assert.match(source, /isValidDemoEntry\(DEMO_ENTRY_EMAIL, DEMO_ENTRY_PASSWORD\)/);
    assert.match(source, /router\.push\("\/demo"\)/);
    assert.doesNotMatch(source, /\/dashboard/);
  });

  test("the false branch sets an error and returns before navigating", () => {
    const fnStart = source.indexOf("function handleEnterDemo()");
    const gateIdx = source.indexOf("if (!isValidDemoEntry(", fnStart);
    const errIdx = source.indexOf("setError(", gateIdx);
    const returnIdx = source.indexOf("return;", gateIdx);
    const pushIdx = source.indexOf('router.push("/demo")', fnStart);
    assert.ok(fnStart !== -1 && gateIdx !== -1);
    assert.ok(errIdx < returnIdx && returnIdx < pushIdx);
  });

  test("the error display block is kept", () => {
    assert.match(source, /\{error && \(/);
  });

  test("no editable credential inputs and no loading state", () => {
    assert.doesNotMatch(source, /<input/);
    assert.doesNotMatch(source, /setLoading/);
  });

  test("tells the visitor the demo is in-browser with no real sign-in", () => {
    assert.ok(source.includes("The demo runs entirely in your browser. No real account or sign-in is created."));
  });
});
