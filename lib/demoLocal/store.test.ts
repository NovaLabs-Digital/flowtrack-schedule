// lib/demoLocal/store.ts has no dedicated test file yet. This suite proves
// its defensive persistence logic: a corrupted sessionStorage blob, storage
// being entirely unavailable (private mode / blocked site data), and an
// outdated/partially-shaped blob (e.g. saved before a schema field existed)
// must all fall back to a freshly generated fixture, running purely
// in-memory, and never throw to the caller -- exactly as store.ts's own
// top-of-file comment documents.
//
// Mocking style: this project's tsconfig has no "dom" lib, so there is no
// ambient `sessionStorage`/`Storage` type to extend -- a plain object
// assigned onto `globalThis` and accessed through `any` is the same style
// lib/demoLocal/fetchInterceptor.test.ts uses for its fake `window`/`fetch`.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_STORAGE_KEY,
  initStore,
  getSnapshot,
  setSnapshot,
  updateStore,
  type DemoFixtureBundle,
} from "@/lib/demoLocal/store";
import { generateDemoFixture } from "@/lib/demoLocal/fixtures/generate";

// Mirrors store.ts's own (unexported) TABLE_KEYS / the table keys of
// DemoFixtureBundle (lib/demoLocal/fixtures/generate.ts) -- re-listed here
// deliberately since neither is exported.
const TABLE_KEYS = [
  "clients",
  "appointments",
  "employees",
  "services",
  "employeeHours",
  "assignments",
  "completedJobBilling",
  "messagesSent",
] as const satisfies readonly (keyof DemoFixtureBundle)[];

function checkBundleShape(bundle: DemoFixtureBundle): void {
  assert.equal(typeof bundle.sessionInitIso, "string");
  assert.ok(bundle.companySettings && typeof bundle.companySettings === "object", "companySettings must be an object");
  for (const key of TABLE_KEYS) {
    assert.ok(Array.isArray(bundle[key]), `${key} must be an array`);
  }
}

// A minimal, working in-memory sessionStorage -- the default for every test
// unless a test deliberately replaces it (the "storage unavailable" case).
function makeWorkingFakeSessionStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    get length() {
      return data.size;
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
  };
}

beforeEach(() => {
  (globalThis as any).sessionStorage = makeWorkingFakeSessionStorage();
});

describe("demoLocal store (lib/demoLocal/store.ts)", () => {
  test("corrupted storage (invalid JSON): initStore() never throws and falls back to a fresh fixture", () => {
    (globalThis as any).sessionStorage.setItem(DEMO_STORAGE_KEY, "not valid json {{{");
    const now = new Date();
    const bundle = initStore(now);
    checkBundleShape(bundle);
    // Proves this is a freshly generateDemoFixture-produced bundle (relative
    // to the `now` passed to initStore), not some partially-recovered blob.
    assert.equal(bundle.sessionInitIso, now.toISOString());
  });

  test("a validly-shaped but outdated blob (missing companySettings) is rejected and regenerated fresh, never partially trusted", () => {
    // Same shape isValidBundle's own comment calls out: a blob saved before
    // companySettings existed on DemoFixtureBundle. All TABLE_KEYS are
    // present as arrays (so a naive "has the right tables" check would
    // wrongly accept it) but companySettings is missing entirely.
    const outdated = {
      sessionInitIso: new Date().toISOString(),
      clients: [],
      appointments: [],
      employees: [],
      services: [],
      employeeHours: [],
      assignments: [],
      completedJobBilling: [],
      messagesSent: [],
    };
    (globalThis as any).sessionStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(outdated));
    const now = new Date();
    const bundle = initStore(now);
    checkBundleShape(bundle);
    // Proves it was regenerated fresh rather than the stored (empty-tables)
    // blob being partially trusted: the real fixture always seeds 20 clients.
    assert.equal(bundle.clients.length, 20);
    assert.equal(bundle.sessionInitIso, now.toISOString());
  });

  test("storage entirely unavailable (getItem/setItem/removeItem all throw synchronously): initStore/getSnapshot/setSnapshot/updateStore all still work purely in-memory, no exception escapes", () => {
    (globalThis as any).sessionStorage = {
      getItem() {
        throw new Error("storage blocked");
      },
      setItem() {
        throw new Error("storage blocked");
      },
      removeItem() {
        throw new Error("storage blocked");
      },
      clear() {
        throw new Error("storage blocked");
      },
      length: 0,
      key() {
        throw new Error("storage blocked");
      },
    };

    const now = new Date();
    const bundle = initStore(now);
    checkBundleShape(bundle);
    assert.equal(getSnapshot(), bundle);

    const fresh = generateDemoFixture(new Date(now.getTime() + 60_000));
    setSnapshot(fresh);
    assert.equal(getSnapshot(), fresh);

    const updated = updateStore((current) => ({ ...current, clients: [] }));
    assert.equal(updated.clients.length, 0);
    assert.equal(getSnapshot().clients.length, 0);
  });
});
