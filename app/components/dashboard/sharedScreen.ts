// Shared screen for Guided Demo Sessions (lib/demoSession/sharedView.ts):
// the React side. Outside a session there is no provider and every hook
// here behaves exactly like the plain local state it wraps, so the real app
// is unchanged.
//
//   useSharedNav    -- the dashboard's navigation state (same names and
//                      setter signatures it always had), read from and
//                      written to the shared view. Several setter calls in
//                      one click become ONE coherent navigation change.
//   useSharedFlag   -- an in-place edit form's open/closed state.
//   useSharedDraft  -- a form's unsaved input: one active editor, the other
//                      person follows read-only; restore after reconnect or
//                      a parked draft; host takeover keeps the draft and its
//                      original edit version.
import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { closesEditor, defaultNav, offsetsFor, stableJson, type DialogState, type Editor, type Role, type SharedView, type ShellNav, type ViewOp, type ViewOutcome } from "@/lib/demoSession/sharedView";
import type { CenterMode, SettingsSection, ViewMode } from "@/app/components/dashboard/types";

export type SharedScreen = {
  role: Role;
  view: SharedView | null;
  // The host always; the guest while guest control is allowed.
  canAct: boolean;
  // Today's business day ("YYYY-MM-DD"), for calendar positions.
  today: string;
  otherName: string;
  dispatch: (op: ViewOp) => Promise<ViewOutcome | "error">;
  serverNavVersion: () => number;
  currentVersion: () => number | null;
};

const SharedScreenContext = createContext<SharedScreen | null>(null);

export function SharedScreenProvider({ value, children }: { value: SharedScreen; children?: React.ReactNode }) {
  return createElement(SharedScreenContext.Provider, { value }, children);
}

export function useSharedScreen(): SharedScreen | null {
  return useContext(SharedScreenContext);
}

type SetState<T> = (next: T | ((prev: T) => T)) => void;
const resolve = <T,>(next: T | ((prev: T) => T), prev: T): T => (typeof next === "function" ? (next as (p: T) => T)(prev) : next);

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export type NavState<M, P> = {
  viewMode: ViewMode; setViewMode: SetState<ViewMode>;
  weekOffset: number; setWeekOffset: SetState<number>;
  monthOffset: number; setMonthOffset: SetState<number>;
  centerMode: CenterMode; setCenterMode: SetState<CenterMode>;
  settingsSection: SettingsSection; setSettingsSection: SetState<SettingsSection>;
  selectedClientId: string | null; setSelectedClientId: SetState<string | null>;
  selectedApptId: string | null; setSelectedApptId: SetState<string | null>;
  modal: M | null; setModal: SetState<M | null>;
  pendingMove: P | null; setPendingMove: SetState<P | null>;
};

export type DialogMapping<M, P> = {
  toModal: (dialog: DialogState) => M | null;
  fromModal: (modal: M, id: string) => DialogState;
  toMove: (dialog: DialogState) => P | null;
  fromMove: (move: P, id: string) => DialogState;
};

let dialogCounter = 0;
const newDialogId = () => `${Date.now().toString(36)}-${(dialogCounter++).toString(36)}`;

// What a navigation change is, in a few words, for the pending notice.
function describe(from: ShellNav, to: ShellNav): string {
  if (from.dialog && !to.dialog) return "close the open form";
  if (to.dialog && stableJson(to.dialog) !== stableJson(from.dialog)) return to.dialog.kind === "create" ? "open a new appointment" : "open another appointment";
  if (to.center !== from.center) return to.center === "settings" ? "open Settings" : "go back to the schedule";
  if (to.section !== from.section) return "open another Settings section";
  if (to.clientId !== from.clientId) return "select another client";
  if (to.apptId !== from.apptId) return "select another appointment";
  if (stableJson(to.ui) !== stableJson(from.ui)) return "close the open form";
  return "change the calendar view";
}

export function useSharedNav<M, P>(local: NavState<M, P>, mapping: DialogMapping<M, P>): NavState<M, P> {
  const shared = useSharedScreen();
  // The latest value, for event handlers (updated after each render).
  const latest = useRef<SharedScreen | null>(shared);
  useLayoutEffect(() => {
    latest.current = shared;
  });
  const patch = useRef<{ nav: Partial<ShellNav>; explicitClose: boolean } | null>(null);

  // The host starts the shared view from its own screen.
  const initialised = useRef(false);
  useEffect(() => {
    if (!shared || shared.view || shared.role !== "host" || initialised.current) return;
    initialised.current = true;
    void shared.dispatch({ type: "init", nav: { ...defaultNav(shared.today), mode: local.viewMode, center: local.centerMode, section: local.settingsSection } });
  }, [shared, local.viewMode, local.centerMode, local.settingsSection]);

  const currentNav = useCallback((): ShellNav | null => {
    const s = latest.current;
    if (!s?.view) return null;
    return { ...s.view.nav, ...(patch.current?.nav ?? {}) };
  }, []);

  const flush = useCallback(() => {
    const s = latest.current;
    const p = patch.current;
    patch.current = null;
    if (!s?.view || !p || !s.canAct) return;
    const from = s.view.nav;
    const to: ShellNav = { ...from, ...p.nav };
    const editor = s.view.editor;
    // Closing your own form on purpose (Close, Cancel, Save) releases it;
    // anything else that would close unsaved work becomes a pending request.
    if (p.explicitClose && editor && editor.role === s.role && closesEditor(editor, to)) {
      void s.dispatch({ type: "release", key: editor.key });
    }
    void s.dispatch({ type: "nav", nav: to, baseNavVersion: s.serverNavVersion(), label: describe(from, to) });
  }, []);

  const change = useCallback((nav: Partial<ShellNav>, explicitClose = false) => {
    const first = patch.current === null;
    patch.current = { nav: { ...(patch.current?.nav ?? {}), ...nav }, explicitClose: explicitClose || (patch.current?.explicitClose ?? false) };
    if (first) queueMicrotask(flush);
  }, [flush]);

  const nav = shared?.view?.nav ?? null;
  const today = shared?.today ?? "";
  // Setters read the latest value including changes made earlier in the
  // same click (like React's own batched state updates).
  const offsets = (n: ShellNav) => offsetsFor(n, today);
  const make = <T,>(get: (n: ShellNav) => T, put: (v: T, n: ShellNav) => Partial<ShellNav>, closeWhen?: (v: T) => boolean): SetState<T> =>
    (next) => {
      const n = currentNav();
      if (!n) return;
      const value = resolve(next, get(n));
      change(put(value, n), closeWhen?.(value) ?? false);
    };

  if (!shared || !nav) return local;

  return {
    viewMode: nav.mode,
    setViewMode: make((n) => n.mode, (mode) => ({ mode })),
    weekOffset: offsets(nav).weekOffset,
    setWeekOffset: make((n) => offsets(n).weekOffset, (weekOffset, n) => ({ weekOffset, monthOffset: offsets(n).monthOffset, asOf: today })),
    monthOffset: offsets(nav).monthOffset,
    setMonthOffset: make((n) => offsets(n).monthOffset, (monthOffset, n) => ({ monthOffset, weekOffset: offsets(n).weekOffset, asOf: today })),
    centerMode: nav.center,
    setCenterMode: make((n) => n.center, (center) => ({ center })),
    settingsSection: nav.section,
    setSettingsSection: make((n) => n.section, (section) => ({ section })),
    selectedClientId: nav.clientId,
    setSelectedClientId: make((n) => n.clientId, (clientId) => ({ clientId })),
    selectedApptId: nav.apptId,
    setSelectedApptId: make((n) => n.apptId, (apptId) => ({ apptId })),
    modal: mapping.toModal(nav.dialog),
    setModal: make(
      (n) => mapping.toModal(n.dialog),
      (modal, n) => ({ dialog: modal ? mapping.fromModal(modal, n.dialog && mapping.toModal(n.dialog) ? n.dialog.id : newDialogId()) : n.dialog?.kind === "move" ? n.dialog : null }),
      (modal) => modal === null
    ),
    pendingMove: mapping.toMove(nav.dialog),
    setPendingMove: make(
      (n) => mapping.toMove(n.dialog),
      (move, n) => ({ dialog: move ? mapping.fromMove(move, newDialogId()) : n.dialog?.kind === "move" ? null : n.dialog }),
      (move) => move === null
    ),
  };
}

// ---------------------------------------------------------------------------
// In-place edit forms: open/closed
// ---------------------------------------------------------------------------

// `flag` names the form ("clientEdit"); the value is the record id (or a
// mode) while open, null while closed. Closing it yourself releases the draft.
export function useSharedFlag(flag: string, local: string | null, setLocal: (v: string | null) => void): [string | null, (v: string | null) => void] {
  const shared = useSharedScreen();
  const latest = useRef(shared);
  useLayoutEffect(() => {
    latest.current = shared;
  });
  const set = useCallback((value: string | null) => {
    const s = latest.current;
    if (!s?.view) return setLocal(value);
    if (!s.canAct) return;
    const from = s.view.nav;
    const to: ShellNav = { ...from, ui: { ...from.ui, [flag]: value } };
    const editor = s.view.editor;
    if (value === null && editor && editor.role === s.role && closesEditor(editor, to)) void s.dispatch({ type: "release", key: editor.key });
    void s.dispatch({ type: "nav", nav: to, baseNavVersion: s.serverNavVersion(), label: value === null ? "close the open form" : "open a form" });
  }, [flag, setLocal]);
  if (!shared?.view) return [local, set];
  return [shared.view.nav.ui[flag] ?? null, set];
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export type SharedDraft = {
  // True while the other person is the active editor (follow along) or this
  // person may not act: inputs should be disabled.
  readOnly: boolean;
  editor: Editor | null;
  mine: boolean;
  // This person's own change could not be shared because someone else
  // started editing first; it is kept in the form until they choose.
  heldBack: boolean;
  takeOver: () => void;
  useTheirs: () => void;
};

const NOT_SHARED: SharedDraft = { readOnly: false, editor: null, mine: true, heldBack: false, takeOver: () => {}, useTheirs: () => {} };
const json = (v: unknown) => stableJson(v);
const DRAFT_DEBOUNCE_MS = 300;

// `key`: the record's form ("appointment:<id>", "ui:clientEdit:<id>",
// "company") or null when the form isn't open. `clean`: the saved values
// for an always-open form -- matching them again releases the editor.
export function useSharedDraft<T>(opts: {
  key: string | null;
  label: string;
  anchor: Record<string, unknown>;
  fields: T;
  apply: (fields: T) => void;
  clean?: T;
}): SharedDraft {
  const shared = useSharedScreen();
  const { key, label, anchor, fields, apply, clean } = opts;
  const editor = shared?.view?.editor && shared.view.editor.key === key ? shared.view.editor : null;
  const mine = !!editor && editor.role === shared?.role;
  const [heldBack, setHeldBack] = useState(false);
  const start = useRef<{ key: string | null; base: number | null; initial: string } | null>(null);
  const lastShared = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ shared, fields, apply, editor });
  useLayoutEffect(() => {
    latest.current = { shared, fields, apply, editor };
  });

  // When the form opens (key appears): remember where the edit began. A
  // layout effect, so it runs before the effects below that use it.
  useLayoutEffect(() => {
    if (shared && key && start.current?.key !== key) {
      start.current = { key, base: shared.currentVersion(), initial: json(latest.current.fields) };
      lastShared.current = null;
    }
  }, [shared, key]);

  // Seed a reserved editor, restore a draft (reconnect / parked / takeover),
  // or follow the other person's typing.
  useEffect(() => {
    const s = latest.current.shared;
    if (!s || !key || !editor || !start.current) return;
    if (editor.role === s.role && editor.fields === null) {
      void s.dispatch({ type: "claim", key, base: start.current.base, initial: JSON.parse(start.current.initial), fields: latest.current.fields, anchor: editor.anchor, label });
      // Not "shared" yet: if the claim restores a parked draft, the next pass
      // applies it to this form instead of keeping the empty one.
      lastShared.current = null;
      return;
    }
    if (editor.fields === null) return;
    const remote = json(editor.fields);
    if (editor.role !== s.role || lastShared.current === null) {
      const local = json(latest.current.fields);
      if (editor.role !== s.role && lastShared.current !== null && local !== lastShared.current && local !== remote) {
        // I typed something of my own while following: never write over it.
        // It stays in the form until I choose (Use their version / take over).
        // Reacting to the other person's incoming draft is this effect's job.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setHeldBack(true);
        return;
      }
      // Following -- or first sight of my own draft after a reload.
      if (remote !== local) latest.current.apply(editor.fields as T);
      lastShared.current = remote;
      setHeldBack(false);
    }
  }, [editor, key, label]);

  // Publish my typing (debounced), or claim an always-open form on my first change.
  const fieldsJson = json(fields);
  useEffect(() => {
    const s = latest.current.shared;
    if (!s || !key || !s.view || !s.canAct) return;
    const e = latest.current.editor;
    if (e && e.role === s.role && e.fields !== null) {
      if (fieldsJson === lastShared.current) return;
      if (clean !== undefined && fieldsJson === json(clean)) {
        // Back to the saved values (e.g. just saved): nothing unsaved remains.
        lastShared.current = fieldsJson;
        void s.dispatch({ type: "release", key });
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        // Re-check at send time: a restored draft may have replaced the form since.
        const cur = latest.current;
        const ed = cur.editor;
        const now = json(cur.fields);
        if (!ed || ed.role !== cur.shared?.role || ed.fields === null || now === lastShared.current) return;
        lastShared.current = now;
        void s.dispatch({ type: "draft", key, epoch: ed.epoch, fields: JSON.parse(now) });
      }, DRAFT_DEBOUNCE_MS);
      return;
    }
    if (!e && clean !== undefined && fieldsJson !== json(clean) && start.current) {
      lastShared.current = fieldsJson;
      void s.dispatch({ type: "claim", key, base: s.currentVersion(), initial: clean, fields: JSON.parse(fieldsJson), anchor, label }).then((outcome) => {
        if (outcome === "denied") setHeldBack(true);
      });
    }
  }, [fieldsJson, key, clean, anchor, label]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  if (!shared || !key) return NOT_SHARED;
  const otherEditing = !!editor && editor.role !== shared.role;
  return {
    readOnly: otherEditing || !shared.canAct,
    editor,
    mine,
    heldBack,
    takeOver: () => { if (key) void shared.dispatch({ type: "takeover", key }); },
    useTheirs: () => {
      const e = latest.current.editor;
      if (e?.fields != null) latest.current.apply(e.fields as T);
      setHeldBack(false);
    },
  };
}

// ---------------------------------------------------------------------------
// Scrolling inside panels (open dialogs, Settings, edit forms)
// ---------------------------------------------------------------------------

const clampUnit = (n: number) => Math.min(1, Math.max(0, n));

// Landmarks both screens have in the same order: a form's labels, headings,
// and fields -- never the per-person notices (who is editing, restrictions),
// which differ between the two screens.
const LANDMARKS = "label, h1, h2, h3, h4, input, select, textarea";
const FIELDS = "input, select, textarea";
const onBothScreens = (el: Element) => !el.closest("[data-shared-edit-notice], [role='note']");
const landmarks = (panel: Element) => Array.from(panel.querySelectorAll(LANDMARKS)).filter(onBothScreens);
const fields = (panel: Element) => Array.from(panel.querySelectorAll(FIELDS)).filter(onBothScreens);

// The first landmark reaching the top edge of the visible area, and how far
// the edge is into it.
function topLandmark(panel: HTMLElement): { index: number; frac: number } | null {
  const top = panel.getBoundingClientRect().top + 1;
  const all = landmarks(panel);
  const index = all.findIndex((el) => el.getBoundingClientRect().bottom > top);
  if (index < 0) return null;
  const r = all[index].getBoundingClientRect();
  return { index, frac: r.height > 0 ? clampUnit((top - 1 - r.top) / r.height) : 0 };
}

// Attach the returned ref to a panel's scrolling element. `key` names the
// panel ("dialog", "settings", ...), `scope` what it currently shows (null =
// not shared). While someone is editing, only the editor's scrolling and
// current field are shared; the follower sees that field outlined. The
// position is a landmark (label / heading / field, counted in order) plus
// how far into it, so it lines up on differently sized windows. Positions
// being applied are never reported back (no feedback loop); a reload
// restores the panel's position, re-applied while the panel's content is
// still loading (until the person scrolls themselves).
export function useSharedPanelScroll(key: string, scope: string | null): (el: HTMLElement | null) => void {
  const shared = useSharedScreen();
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const latest = useRef(shared);
  useLayoutEffect(() => {
    latest.current = shared;
  });
  const applying = useRef(false);
  const restoredScope = useRef<string | null>(null);
  const outlined = useRef<HTMLElement | null>(null);
  const settleUntil = useRef(0);
  const lastReport = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entry = shared?.view?.panels?.[key] ?? null;
  const me = shared?.role ?? null;

  // Follow the other person's position (and restore my own once after a reload).
  useEffect(() => {
    if (!panel || !entry || !scope || entry.scope !== scope) return;
    const firstSight = restoredScope.current !== scope;
    if (!firstSight && entry.by === me) return;
    restoredScope.current = scope;
    const place = () => {
      const target = entry.path.length === 1 ? (landmarks(panel)[entry.path[0]] as HTMLElement | undefined) : undefined;
      let top = entry.ratio * Math.max(0, panel.scrollHeight - panel.clientHeight);
      if (target) {
        const pr = panel.getBoundingClientRect();
        const tr = target.getBoundingClientRect();
        top = panel.scrollTop + (tr.top - pr.top) + entry.frac * tr.height;
      }
      applying.current = true;
      if (Math.abs(panel.scrollTop - top) >= 4) panel.scrollTo({ top });
      requestAnimationFrame(() => {
        applying.current = false;
      });
    };
    place();
    // Content still loading (e.g. right after a reload): place again as it
    // grows, for a few seconds, unless the person scrolls in the meantime.
    settleUntil.current = Date.now() + 4000;
    const content = panel.firstElementChild;
    const resize = typeof ResizeObserver !== "undefined" && content
      ? new ResizeObserver(() => { if (Date.now() < settleUntil.current) place(); })
      : null;
    if (resize && content) resize.observe(content);
    // The editor's current field: keep it in view and outline it.
    // (Styled by the [data-shared-focus] rule in app/globals.css.)
    if (outlined.current) {
      outlined.current.removeAttribute("data-shared-focus");
      outlined.current = null;
    }
    const field = entry.focus && entry.focus.length === 1 && entry.by !== me ? (fields(panel)[entry.focus[0]] as HTMLElement | undefined) ?? null : null;
    if (field) {
      field.setAttribute("data-shared-focus", "");
      outlined.current = field;
      const pr = panel.getBoundingClientRect();
      const fr = field.getBoundingClientRect();
      if (fr.top < pr.top || fr.bottom > pr.bottom) field.scrollIntoView({ block: "nearest" });
    }
    return () => resize?.disconnect();
  }, [panel, entry, scope, me]);

  // Report my own scrolling (at most every 250ms, plus where it comes to rest)
  // and the field I move into.
  useEffect(() => {
    if (!panel || !scope) return;
    const report = (focusTarget?: Element | null) => {
      const s = latest.current;
      if (!s?.view || !s.canAct || applying.current) return;
      const editor = s.view.editor;
      if (editor && editor.fields !== null && editor.role !== s.role) return; // following someone's edit
      const at = topLandmark(panel);
      const active = focusTarget ?? (panel.contains(document.activeElement) ? document.activeElement : null);
      const focusIndex = active ? fields(panel).indexOf(active) : -1;
      void s.dispatch({
        type: "panel",
        key,
        scope,
        path: at ? [at.index] : [],
        frac: at?.frac ?? 0,
        ratio: panel.scrollHeight > panel.clientHeight ? clampUnit(panel.scrollTop / (panel.scrollHeight - panel.clientHeight)) : 0,
        focus: focusIndex >= 0 ? [focusIndex] : null,
      });
    };
    const onScroll = () => {
      if (applying.current) return;
      settleUntil.current = 0; // the person is scrolling: stop re-placing
      if (trailing.current) clearTimeout(trailing.current);
      trailing.current = setTimeout(() => report(), 260);
      const now = Date.now();
      if (now - lastReport.current < 250) return;
      lastReport.current = now;
      report();
    };
    const onFocus = (e: FocusEvent) => report(e.target as Element);
    panel.addEventListener("scroll", onScroll, { passive: true });
    panel.addEventListener("focusin", onFocus);
    return () => {
      panel.removeEventListener("scroll", onScroll);
      panel.removeEventListener("focusin", onFocus);
      if (trailing.current) clearTimeout(trailing.current);
    };
  }, [panel, scope, key]);

  return setPanel;
}
