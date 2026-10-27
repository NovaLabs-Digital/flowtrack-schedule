"use client";

import { useEffect, useRef, useState } from "react";

// The left bar's two fixed widths (it toggles between them, it is never
// drag-resized like the schedule/sidebar split) -- DashboardShell applies
// these directly as the LeftBar <aside>'s inline width, and this file's
// own clamp math below always assumes the EXPANDED width as the
// conservative/safe case (see MIN_MAIN_CONTENT_WIDTH_PX), regardless of
// whether the left bar happens to be collapsed at the moment -- simpler,
// and never unsafe, since collapsing the left bar only ever frees up more
// room than this math assumes.
export const LEFT_BAR_WIDTH_PX = 230;
export const LEFT_BAR_COLLAPSED_WIDTH_PX = 64;

export const DEFAULT_SCHEDULE_HEIGHT_PCT = 68;
export const MIN_SCHEDULE_HEIGHT_PCT = 35;
export const MAX_SCHEDULE_HEIGHT_PCT = 82;

export const DEFAULT_SIDEBAR_WIDTH_PX = 380;
export const MIN_SIDEBAR_WIDTH_PX = 300;
export const MAX_SIDEBAR_WIDTH_PX = 560;

// Below this many pixels of remaining main-content width, the sidebar is
// forced narrower than MAX_SIDEBAR_WIDTH_PX regardless of the saved or
// requested size. Calibrated empirically against TopBar.tsx's own
// unwrapped "Today / Prev / Next" + "Add Appointment" / avatar row, which
// does not shrink or wrap below its own intrinsic content width (a
// pre-existing property of TopBar, not something this feature changes) --
// below roughly 390px of main-content width, that row visually overlaps
// the dispatch sidebar next to it. 400px keeps a safety margin below that
// threshold while still leaving the DEFAULT sidebar width unclamped at
// every viewport width this app already treats as "desktop" (>= 768px,
// see useIsMobile's breakpoint) -- this constraint exists to stop a user
// from dragging the sidebar into that overlap, not to second-guess the
// shipped default layout.
export const MIN_MAIN_CONTENT_WIDTH_PX = 400;

export type DashboardLayoutPrefs = {
  scheduleHeightPct: number;
  sidebarWidthPx: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
};

export function clampScheduleHeightPct(value: number): number {
  // Only NaN needs a fallback -- Math.min/Math.max already resolve
  // +/-Infinity to MAX/MIN correctly.
  if (Number.isNaN(value)) return DEFAULT_SCHEDULE_HEIGHT_PCT;
  return Math.min(MAX_SCHEDULE_HEIGHT_PCT, Math.max(MIN_SCHEDULE_HEIGHT_PCT, value));
}

export function maxSidebarWidthForViewport(viewportWidthPx: number, leftBarWidthPx: number = LEFT_BAR_WIDTH_PX): number {
  return Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(MAX_SIDEBAR_WIDTH_PX, viewportWidthPx - leftBarWidthPx - MIN_MAIN_CONTENT_WIDTH_PX));
}

export function clampSidebarWidthPx(value: number, maxAllowedPx: number = MAX_SIDEBAR_WIDTH_PX): number {
  if (Number.isNaN(value)) return DEFAULT_SIDEBAR_WIDTH_PX;
  const max = Math.max(MIN_SIDEBAR_WIDTH_PX, maxAllowedPx);
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH_PX, value));
}

function storageKey(userId: string, workspaceId: string): string {
  // Same sft_... prefix convention as IncomeProjection.tsx's
  // VISIBILITY_STORAGE_KEY -- UI-only preference, never read or written by
  // any server route. Scoped by BOTH userId and workspaceId: workspaceId
  // alone (the v1 key shape) would let two different people signed into
  // the same workspace on the same shared browser silently overwrite each
  // other's panel layout; userId alone would let the same person's saved
  // layout leak across unrelated workspaces. Tester sessions have no
  // individual identity (see app/dashboard/page.tsx's userId derivation),
  // so every tester session on a given browser shares one layout, same as
  // before -- only real owner sessions get a truly per-person key. v2
  // because the stored shape also gained leftCollapsed/rightCollapsed; old
  // v1 entries are simply orphaned, never read again, not migrated.
  return `sft_dashboard_layout_v2_${userId}_${workspaceId}`;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readStoredPrefs(userId: string, workspaceId: string): DashboardLayoutPrefs | null {
  try {
    const raw = window.localStorage.getItem(storageKey(userId, workspaceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    return {
      scheduleHeightPct: clampScheduleHeightPct(Number(p.scheduleHeightPct)),
      sidebarWidthPx: clampSidebarWidthPx(Number(p.sidebarWidthPx)),
      leftCollapsed: readBoolean(p.leftCollapsed, false),
      rightCollapsed: readBoolean(p.rightCollapsed, false),
    };
  } catch {
    // Unavailable storage (e.g. Safari private mode throws on access) or
    // corrupted JSON -- fall back to defaults exactly as if nothing had
    // ever been saved.
    return null;
  }
}

function writeStoredPrefs(userId: string, workspaceId: string, prefs: DashboardLayoutPrefs) {
  try {
    window.localStorage.setItem(storageKey(userId, workspaceId), JSON.stringify(prefs));
  } catch {
    // Quota exceeded or storage disabled -- the in-memory layout still
    // works for the rest of this session, it just won't be remembered.
  }
}

function clearStoredPrefs(userId: string, workspaceId: string) {
  try {
    window.localStorage.removeItem(storageKey(userId, workspaceId));
  } catch {
    // Nothing to do -- see writeStoredPrefs.
  }
}

export function useDashboardLayoutPrefs(workspaceId: string, userId: string) {
  const [scheduleHeightPct, setScheduleHeightPctState] = useState(DEFAULT_SCHEDULE_HEIGHT_PCT);
  const [sidebarWidthPx, setSidebarWidthPxState] = useState(DEFAULT_SIDEBAR_WIDTH_PX);
  // Collapse state for each sidebar independently. Both start expanded,
  // matching the pre-collapse shipped layout exactly, so a first-ever
  // visit (or any visit before hydration reads a saved preference) looks
  // identical to before this feature existed.
  const [leftCollapsed, setLeftCollapsedState] = useState(false);
  const [rightCollapsed, setRightCollapsedState] = useState(false);
  // Never read localStorage during the initial render (SSR has no window,
  // and a lazy useState initializer would run during hydration too) --
  // read once in an effect after mount, matching IncomeProjection.tsx's
  // established hydration-safe pattern. Writes are gated behind this same
  // flag so the initial read is never immediately overwritten by its own
  // write effect running first.
  const [hydrated, setHydrated] = useState(false);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  useEffect(() => {
    const stored = readStoredPrefs(userId, workspaceId);
    const viewportMax = typeof window !== "undefined" ? maxSidebarWidthForViewport(window.innerWidth) : MAX_SIDEBAR_WIDTH_PX;
    if (stored) {
      setScheduleHeightPctState(stored.scheduleHeightPct);
      setSidebarWidthPxState(clampSidebarWidthPx(stored.sidebarWidthPx, viewportMax));
      setLeftCollapsedState(stored.leftCollapsed);
      setRightCollapsedState(stored.rightCollapsed);
    } else {
      setSidebarWidthPxState(clampSidebarWidthPx(DEFAULT_SIDEBAR_WIDTH_PX, viewportMax));
      setLeftCollapsedState(false);
      setRightCollapsedState(false);
    }
    setHydrated(true);
    // Deliberately re-runs if workspaceId or userId changes (e.g. the
    // fixed demo workspace/tester identity vs. a specific owner's real
    // workspace) -- each (user, workspace) pair gets its own
    // independently-remembered layout, never a cross-user or
    // cross-workspace leak.
  }, [workspaceId, userId]);

  useEffect(() => {
    if (!hydrated) return;
    writeStoredPrefs(userIdRef.current, workspaceIdRef.current, { scheduleHeightPct, sidebarWidthPx, leftCollapsed, rightCollapsed });
  }, [hydrated, scheduleHeightPct, sidebarWidthPx, leftCollapsed, rightCollapsed]);

  // Keeps the sidebar usable if the browser window is resized narrower
  // after load -- scheduleHeightPct is percentage-based and already
  // responsive via CSS flex-basis, so only the pixel-based sidebar width
  // needs an explicit reclamp here.
  useEffect(() => {
    function reclamp() {
      setSidebarWidthPxState((prev) => clampSidebarWidthPx(prev, maxSidebarWidthForViewport(window.innerWidth)));
    }
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  function setScheduleHeightPct(updater: number | ((prev: number) => number)) {
    setScheduleHeightPctState((prev) => clampScheduleHeightPct(typeof updater === "function" ? updater(prev) : updater));
  }

  function setSidebarWidthPx(updater: number | ((prev: number) => number)) {
    setSidebarWidthPxState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      return clampSidebarWidthPx(next, maxSidebarWidthForViewport(window.innerWidth));
    });
  }

  function toggleLeftCollapsed() {
    setLeftCollapsedState((prev) => !prev);
  }

  function toggleRightCollapsed() {
    // sidebarWidthPx itself is never touched here -- collapsing only
    // changes whether the sidebar renders, not its remembered width, so
    // expanding again always restores exactly the width it had before,
    // including any drag-resized value.
    setRightCollapsedState((prev) => !prev);
  }

  function resetLayout() {
    setScheduleHeightPctState(DEFAULT_SCHEDULE_HEIGHT_PCT);
    setSidebarWidthPxState(clampSidebarWidthPx(DEFAULT_SIDEBAR_WIDTH_PX, maxSidebarWidthForViewport(window.innerWidth)));
    setLeftCollapsedState(false);
    setRightCollapsedState(false);
    clearStoredPrefs(userIdRef.current, workspaceIdRef.current);
  }

  return {
    scheduleHeightPct,
    setScheduleHeightPct,
    sidebarWidthPx,
    setSidebarWidthPx,
    leftCollapsed,
    toggleLeftCollapsed,
    rightCollapsed,
    toggleRightCollapsed,
    resetLayout,
    hydrated,
  };
}
