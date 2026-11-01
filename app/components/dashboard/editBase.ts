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
// A form whose draft is shared on both screens (sharedScreen.ts) passes its
// shared key: its saves then use the shared draft's ORIGINAL edit version,
// which carries over through synchronization, reconnects, and takeovers.
//
// Outside a Guided Demo Session there is no provider: headers() is empty and
// nothing about the request changes.
import { createContext, createElement, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EDIT_BASE_HEADER } from "@/lib/demoLocal/fetchInterceptor";
import { useSharedScreen } from "@/app/components/dashboard/sharedScreen";
import { editMarkerKey } from "@/lib/demoSession/sharedView";

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

export function useEditBase(sharedKey?: string | null): { begin: () => void; headers: () => Record<string, string> } {
  const source = useContext(EditBaseContext);
  const shared = useSharedScreen();
  const sharedRef = useRef(shared);
  useLayoutEffect(() => {
    sharedRef.current = shared;
  });
  // The form's first render is when its edit begins ...
  const [first] = useState<EditStart>(() => ({ key: newKey(), version: source?.currentVersion() ?? null }));
  // ... unless it starts a new edit later (begin()).
  const restarted = useRef<EditStart | null>(null);

  const begin = useCallback(() => {
    restarted.current = { key: newKey(), version: source?.currentVersion() ?? null };
  }, [source]);

  const headers = useCallback((): Record<string, string> => {
    const editor = sharedRef.current?.view?.editor;
    if (sharedKey && editor && editor.key === sharedKey && editor.base !== null) {
      return { [EDIT_BASE_HEADER]: `${editMarkerKey(sharedKey)}:${editor.base}` };
    }
    const s = restarted.current ?? first;
    if (!source || !s || s.version === null) return {};
    return { [EDIT_BASE_HEADER]: `${s.key}:${s.version}` };
  }, [source, first, sharedKey]);

  // Stable across renders, so it can sit in an effect's dependencies.
  return useMemo(() => ({ begin, headers }), [begin, headers]);
}
