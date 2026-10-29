// Browser-local public demo: the canonical in-memory data store.
//
// One module-level snapshot holding every demo table. React reads it via
// useSyncExternalStore(subscribe, getSnapshot); the demo fetch interceptor
// (fetchInterceptor.ts) reads and writes it in place of the real API routes.
// Every write replaces the snapshot object (never mutates it in place), so
// useSyncExternalStore sees a new reference exactly when something changed.
//
// Persistence is sessionStorage, deliberately NOT localStorage: localStorage
// is shared by every tab of the same origin, so two demo tabs would silently
// read and overwrite each other's data. sessionStorage is per-tab, which is
// the isolation this demo requires (each tab is its own private sandbox,
// and closing the tab discards it). Every storage access is wrapped in
// try/catch: if storage is unavailable (private mode, blocked site data,
// quota, SSR), the store simply runs in memory for that session and never
// throws.
import { generateDemoFixture, type DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";

export type { DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";

export const DEMO_STORAGE_KEY = "sft-demo-local:v1";

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

let state: DemoFixtureBundle | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function isValidBundle(value: unknown): value is DemoFixtureBundle {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionInitIso !== "string") return false;
  return TABLE_KEYS.every((k) => Array.isArray(v[k]));
}

// ---- useSyncExternalStore contract -------------------------------------

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): DemoFixtureBundle {
  return state ?? initStore();
}

export function notify(): void {
  for (const listener of [...listeners]) listener();
}

// ---- persistence --------------------------------------------------------

export function persist(): void {
  const s = storage();
  if (!s || !state) return;
  try {
    s.setItem(DEMO_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // quota/blocked -- keep running in memory only
  }
}

export function restore(): DemoFixtureBundle | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(DEMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidBundle(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---- lifecycle ----------------------------------------------------------

// Restores this tab's saved demo session if present and valid, otherwise
// generates a fresh fixture relative to `now`.
export function initStore(now: Date = new Date()): DemoFixtureBundle {
  const restored = restore();
  state = restored ?? generateDemoFixture(now);
  if (!restored) persist();
  return state;
}

// "Start over": fresh fixtures relative to a new `now`, and this tab's saved
// session key cleared (the next write persists the new data).
export function resetStore(now: Date = new Date()): DemoFixtureBundle {
  const s = storage();
  if (s) {
    try {
      s.removeItem(DEMO_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  state = generateDemoFixture(now);
  notify();
  return state;
}

// ---- writes -------------------------------------------------------------

// Replaces the whole snapshot and persists it. Callers call notify() once
// their (possibly multi-table) write is complete.
export function setSnapshot(next: DemoFixtureBundle): void {
  state = next;
  persist();
}

// Convenience: derive the next snapshot from the current one.
export function updateStore(fn: (current: DemoFixtureBundle) => DemoFixtureBundle): DemoFixtureBundle {
  const next = fn(getSnapshot());
  setSnapshot(next);
  return next;
}
