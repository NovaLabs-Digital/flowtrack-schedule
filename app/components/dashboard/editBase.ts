// Edit-start tracking for Guided Demo Sessions, where the host and an
// allowed guest can edit the same fictional data at once.
//
// An edit form calls useEditBase() and spreads editBase.headers() into its
// save request. The hook remembers the dataset version on screen when the
// edit BEGAN -- when the form mounted, or when begin() is called (an Edit
// button on an in-place form) -- so the session server can refuse a save
// whose records someone else changed after that point, instead of the old
// form silently undoing their work (lib/demoSession/recordVersions.ts).
//
// Outside a Guided Demo Session there is no provider: headers() is empty and
// nothing about the request changes.
import { createContext, createElement, useCallback, useContext, useMemo, useRef, useState } from "react";
import { EDIT_BASE_HEADER } from "@/lib/demoLocal/fetchInterceptor";

export type EditBaseSource = { currentVersion: () => number | null };

const EditBaseContext = createContext<EditBaseSource | null>(null);

export function EditBaseProvider({ source, children }: { source: EditBaseSource; children?: React.ReactNode }) {
  return createElement(EditBaseContext.Provider, { value: source }, children);
}

type EditStart = { key: string; version: number | null };

const newKey = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function useEditBase(): { begin: () => void; headers: () => Record<string, string> } {
  const source = useContext(EditBaseContext);
  // The form's first render is when its edit begins ...
  const [first] = useState<EditStart>(() => ({ key: newKey(), version: source?.currentVersion() ?? null }));
  // ... unless it starts a new edit later (begin()).
  const restarted = useRef<EditStart | null>(null);

  const begin = useCallback(() => {
    restarted.current = { key: newKey(), version: source?.currentVersion() ?? null };
  }, [source]);

  const headers = useCallback((): Record<string, string> => {
    const s = restarted.current ?? first;
    if (!source || !s || s.version === null) return {};
    return { [EDIT_BASE_HEADER]: `${s.key}:${s.version}` };
  }, [source, first]);

  // Stable across renders, so it can sit in an effect's dependencies.
  return useMemo(() => ({ begin, headers }), [begin, headers]);
}
