"use client";

import { useEffect, useRef, useState } from "react";
import type { CenterMode, SettingsSection } from "@/app/components/dashboard/types";

// Remembers which top-level area (schedule vs. Settings) and, if Settings,
// which section the owner was last looking at -- same sft_... prefix and
// per-person+per-tenant scoping convention, and the same hydration-safe
// lazy-default/mount-effect-read/write-effect pattern, as
// useDashboardLayoutPrefs.ts. Without this, a hard refresh always lands back
// on the dashboard calendar, even if the owner was deep in Settings ->
// Billing; with it, a refresh reopens exactly where they left off.
//
// Logout and switching workspaces need no special handling here, for the
// same reason useDashboardLayoutPrefs.ts needs none: the storage key is
// scoped by BOTH userId and workspaceId, so a different person or a
// different workspace on the same browser simply never reads this one.

const SETTINGS_SECTIONS: readonly string[] = ["company", "services", "staff", "archived", "recurring", "billing"];

function isValidSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && SETTINGS_SECTIONS.includes(value);
}

function isValidCenterMode(value: unknown): value is CenterMode {
  return value === "schedule" || value === "settings";
}

type DashboardNavigationPrefs = {
  centerMode: CenterMode;
  settingsSection: SettingsSection;
};

const DEFAULT_NAVIGATION_PREFS: DashboardNavigationPrefs = {
  centerMode: "schedule",
  settingsSection: "company",
};

function storageKey(userId: string, workspaceId: string): string {
  return `sft_dashboard_nav_v1_${userId}_${workspaceId}`;
}

function readStoredPrefs(userId: string, workspaceId: string): DashboardNavigationPrefs {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, workspaceId));
    if (!raw) return DEFAULT_NAVIGATION_PREFS;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_NAVIGATION_PREFS;
    const p = parsed as Record<string, unknown>;
    return {
      centerMode: isValidCenterMode(p.centerMode) ? p.centerMode : DEFAULT_NAVIGATION_PREFS.centerMode,
      settingsSection: isValidSettingsSection(p.settingsSection) ? p.settingsSection : DEFAULT_NAVIGATION_PREFS.settingsSection,
    };
  } catch {
    // Unavailable storage (e.g. Safari private mode throws on access) or
    // corrupted JSON -- fall back to defaults exactly as if nothing had
    // ever been saved.
    return DEFAULT_NAVIGATION_PREFS;
  }
}

function writeStoredPrefs(userId: string, workspaceId: string, prefs: DashboardNavigationPrefs) {
  try {
    window.localStorage.setItem(storageKey(userId, workspaceId), JSON.stringify(prefs));
  } catch {
    // Quota exceeded or storage disabled -- the in-memory navigation still
    // works for the rest of this session, it just won't be remembered.
  }
}

export function useDashboardNavigationPrefs(workspaceId: string, userId: string) {
  // Defaults to exactly today's permanent, pre-this-feature behavior
  // ("schedule"/"company") on first render -- identical whether or not a
  // stored preference exists, since the read only happens in the mount
  // effect below, matching useDashboardLayoutPrefs.ts's own hydration-safe
  // pattern. No new SSR/hydration-mismatch risk: first paint is unchanged.
  const [centerMode, setCenterMode] = useState<CenterMode>(DEFAULT_NAVIGATION_PREFS.centerMode);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(DEFAULT_NAVIGATION_PREFS.settingsSection);
  const [hydrated, setHydrated] = useState(false);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  useEffect(() => {
    const stored = readStoredPrefs(userId, workspaceId);
    setCenterMode(stored.centerMode);
    setSettingsSection(stored.settingsSection);
    setHydrated(true);
    // Deliberately re-runs if workspaceId or userId changes -- each (user,
    // workspace) pair gets its own independently-remembered navigation
    // state, never a cross-user or cross-workspace leak.
  }, [workspaceId, userId]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredPrefs(userIdRef.current, workspaceIdRef.current, { centerMode, settingsSection });
  }, [hydrated, centerMode, settingsSection]);

  return { centerMode, setCenterMode, settingsSection, setSettingsSection, hydrated };
}
