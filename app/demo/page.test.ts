// SOURCE INSPECTION, matching app/dashboard/page.test.ts and
// DashboardShell.test.ts: this page renders the full DashboardShell, which no
// test in this codebase renders end to end. Proves the structural guarantees
// the browser-local demo depends on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./DemoPageClient.tsx", import.meta.url)), "utf8");
const pageSource = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const middlewareSource = fs.readFileSync(fileURLToPath(new URL("../../middleware.ts", import.meta.url)), "utf8");

// Every `useEffect(...)` call's text span (from the call to its matching
// closing parenthesis).
function useEffectSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let idx = src.indexOf("useEffect(");
  while (idx !== -1) {
    let depth = 0;
    let end = idx;
    for (let i = idx + "useEffect".length; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    spans.push([idx, end]);
    idx = src.indexOf("useEffect(", end);
  }
  return spans;
}

describe("app/demo/page.tsx: thin server wrapper, no session/Supabase anywhere in this route", () => {
  test("page.tsx itself never imports the Supabase admin client or the session module", () => {
    assert.doesNotMatch(pageSource, /@\/lib\/supabaseAdmin/);
    assert.doesNotMatch(pageSource, /@\/lib\/session/);
    assert.doesNotMatch(pageSource, /getSession/);
  });
});

describe("app/demo/DemoPageClient.tsx: no server session or server data", () => {
  test("is a client component", () => {
    assert.match(source, /^"use client";/);
  });

  test("never imports the Supabase admin client or the session module", () => {
    assert.doesNotMatch(source, /@\/lib\/supabaseAdmin/);
    assert.doesNotMatch(source, /@\/lib\/session/);
    assert.doesNotMatch(source, /getSession/);
  });

  test("/demo is not added to middleware.ts's matcher (needs no cookie)", () => {
    assert.match(middlewareSource, /matcher:\s*\["\/dashboard\/:path\*",\s*"\/schedule"\]/);
    assert.doesNotMatch(middlewareSource, /"\/demo/);
  });
});

describe("app/demo/DemoPageClient.tsx: interceptor + store installed at module scope", () => {
  const componentStart = source.indexOf("export default function DemoPageClient");

  test("installDemoFetchInterceptor() and initStore() are called before the component definition", () => {
    const installIdx = source.indexOf("installDemoFetchInterceptor();");
    const initIdx = source.indexOf("initStore();");
    assert.notEqual(installIdx, -1);
    assert.notEqual(initIdx, -1);
    assert.notEqual(componentStart, -1);
    assert.ok(installIdx < componentStart, "interceptor install is top-level module code, not inside the component");
    assert.ok(initIdx < componentStart, "store init is top-level module code, not inside the component");
  });

  test("installDemoFetchInterceptor() is not inside any useEffect(...) span", () => {
    const installIdx = source.indexOf("installDemoFetchInterceptor();");
    for (const [start, end] of useEffectSpans(source)) {
      assert.ok(installIdx < start || installIdx > end, "install must not be effect-based (child mount fetches would race it)");
    }
  });

  test("reads the store via useSyncExternalStore(subscribe, getSnapshot, ...)", () => {
    assert.match(source, /useSyncExternalStore<DemoFixtureBundle \| null>\(subscribe, getSnapshot, getServerSnapshot\)/);
  });
});

describe("app/demo/DemoPageClient.tsx: DashboardShell receives the full 13-prop shape plus isLocalDemo", () => {
  const block = source.match(/<DashboardShell[\s\S]*?\/>/)?.[0] ?? "";

  test("DashboardShell is rendered", () => {
    assert.ok(block.length > 0);
  });

  for (const [prop, value] of [
    ["clients", "snapshot.clients"],
    ["appointments", "snapshot.appointments"],
    ["services", "snapshot.services"],
    ["employees", "snapshot.employees"],
    ["employeeHours", "snapshot.employeeHours"],
    ["assignments", "snapshot.assignments"],
    ["paidAppointmentIds", "paidAppointmentIds"],
    ["isTester", "true"],
    ["entitlement", "DEMO_ENTITLEMENT"],
    ["timezone", "DEMO_TIMEZONE"],
    ["businessHours", "DEMO_BUSINESS_HOURS"],
    ["workspaceId", "LOCAL_DEMO_WORKSPACE_ID"],
    ["userId", "LOCAL_DEMO_USER_ID"],
    ["isLocalDemo", "true"],
  ] as const) {
    test(`passes ${prop}={${value}}`, () => {
      assert.ok(block.includes(`${prop}={${value}}`), `missing ${prop}={${value}}`);
    });
  }

  test("paidAppointmentIds is derived from paid completedJobBilling rows", () => {
    assert.match(source, /completedJobBilling\.filter\(\(r\) => r\.paid\)\.map\(\(r\) => r\.appointment_id\)/);
  });

  test("defaults match the real page's no-settings fallbacks", () => {
    assert.match(source, /effectiveBusinessHours\(null\)/);
    assert.match(source, /const LOCAL_DEMO_WORKSPACE_ID = "local-demo";/);
    assert.match(source, /const LOCAL_DEMO_USER_ID = "local-demo";/);
  });
});

describe("app/demo/page.tsx: kept out of search indexing", () => {
  test("exports metadata with robots noindex/nofollow", () => {
    assert.match(pageSource, /export const metadata: Metadata = \{/);
    assert.match(pageSource, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
  });
});
