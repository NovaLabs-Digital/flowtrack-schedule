// Record-level edit conflicts for Guided Demo Sessions.
//
// The host and an allowed guest can edit the same fictional dataset at the
// same time. A change is refused only when a record it touches was changed
// by someone after the editor began (the form opened, or Edit was clicked):
// saving an old form must never silently undo another participant's work,
// while changes to other records never get in each other's way.
//
// The session dataset carries, under RECORD_VERSIONS_KEY, the dataset
// version at which each record last changed. A change computed by the demo
// handlers is compared with the dataset it started from to find the records
// it touches ("clients:<id>", "appointments:<id>", "companySettings", ...).
import type { DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";

export const RECORD_VERSIONS_KEY = "recordVersions";
export type RecordVersions = Record<string, number>;
export type SessionDataset = DemoFixtureBundle & { [RECORD_VERSIONS_KEY]?: RecordVersions };

// The dataset the demo handlers work on, and the record versions kept beside it.
export function splitDataset(state: SessionDataset): { bundle: DemoFixtureBundle; versions: RecordVersions } {
  const { [RECORD_VERSIONS_KEY]: versions, ...bundle } = state;
  return { bundle: bundle as DemoFixtureBundle, versions: versions ?? {} };
}

const hasIds = (list: unknown[]) =>
  list.every((item) => item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string");

// Every record that differs between two datasets: added, removed, or changed.
export function changedRecords(before: DemoFixtureBundle, after: DemoFixtureBundle): string[] {
  const changed: string[] = [];
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key === RECORD_VERSIONS_KEY) continue;
    const was = b[key];
    const now = a[key];
    if (Array.isArray(was) && Array.isArray(now) && hasIds(was) && hasIds(now)) {
      const byId = (list: unknown[]) => new Map(list.map((item) => [(item as { id: string }).id, JSON.stringify(item)]));
      const oldRecords = byId(was);
      const newRecords = byId(now);
      for (const id of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
        if (oldRecords.get(id) !== newRecords.get(id)) changed.push(`${key}:${id}`);
      }
    } else if (JSON.stringify(was) !== JSON.stringify(now)) {
      changed.push(key);
    }
  }
  return changed.sort();
}

// The touched records that someone changed after `editBase` (the dataset
// version the editor started from).
export function conflictingRecords(changed: string[], versions: RecordVersions, editBase: number): string[] {
  return changed.filter((key) => (versions[key] ?? 0) > editBase);
}

// The new dataset to store: the handlers' result plus updated record versions.
export function withRecordVersions(bundle: DemoFixtureBundle, versions: RecordVersions, changed: string[], newVersion: number): SessionDataset {
  const next: RecordVersions = { ...versions };
  for (const key of changed) next[key] = newVersion;
  return { ...bundle, [RECORD_VERSIONS_KEY]: next };
}
