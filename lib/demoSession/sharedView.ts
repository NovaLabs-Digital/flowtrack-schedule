// Shared screen for Guided Demo Sessions: both participants see the same
// calendar mode and date, selection, Settings section, open dialog or edit
// form, the draft inside it, and the calendar's scroll position. Panel sizes,
// the session bar, and chat stay each person's own.
//
// The view is one JSON document stored by the session server. Every change
// is an operation applied by `reduceView` -- the same pure function in the
// browser (to show your own change at once) and on the server (where the
// result is stored by compare-and-swap, so changes are applied one at a time
// in a single order). Rules:
//
//   * Navigation is one block (mode, date, Settings section, selection,
//     dialog, in-place edit flags), always replaced whole, so simultaneous
//     changes can never combine into an impossible view.
//   * Host priority: a guest navigation based on a view the host has since
//     changed is refused ("superseded"); the guest's screen shows the host's.
//   * One active editor. Only the active editor's typing changes the draft;
//     the other person follows read-only. The host can always take over; the
//     draft and its ORIGINAL edit version carry over (never reset to the
//     latest version by synchronization, reconnect, or takeover).
//   * Unsaved input is never discarded silently. Navigation that would close
//     a form holding unsaved changes becomes a visible pending request until
//     it is resolved: keep editing, discard, save, or (host) continue while
//     keeping the draft parked -- it comes back when that form reopens.
//
// Guest permission (allowed + current control generation) is enforced by
// the database before any of this runs (migration 044).
import type { CenterMode, SettingsSection, ViewMode } from "@/app/components/dashboard/types";

export type Role = "host" | "visitor";

export type DialogState =
  | null
  | { id: string; kind: "create"; prefillDate?: string; prefillTime?: string }
  | { id: string; kind: "edit"; appointmentId: string }
  | { id: string; kind: "move"; appointmentId: string; scheduledFor: string; scheduledEnd: string | null };

export type ShellNav = {
  mode: ViewMode;
  // Calendar position: offsets from `asOf` (the business day they were set
  // on), so two people on either side of midnight still see the same week.
  weekOffset: number;
  monthOffset: number;
  asOf: string;
  center: CenterMode;
  section: SettingsSection;
  clientId: string | null;
  apptId: string | null;
  dialog: DialogState;
  // In-place edit forms that are open (e.g. "clientEdit" -> client id).
  ui: Record<string, string | null>;
};

export type Editor = {
  key: string;
  role: Role;
  epoch: number;
  // The dataset version the edit began from: the base for conflict checks.
  base: number | null;
  fields: unknown;
  initial: string;
  dirty: boolean;
  // Navigation values this form depends on; changing any closes it.
  anchor: Record<string, unknown>;
  label: string;
};

export type Pending = { id: string; by: Role; nav: ShellNav; label: string };

// Scrolling inside a panel (an open dialog, Settings, an edit form): the
// element at the top of the visible area (a child-index path from the
// panel) and how far into it, plus a plain ratio as fallback, and the field
// the editor is in. `scope` names what it belongs to (which dialog, section,
// or record), so a position never applies to a different one.
export type PanelScroll = { scope: string; path: number[]; frac: number; ratio: number; focus: number[] | null; by: Role };

export type SharedView = {
  nav: ShellNav;
  navVersion: number;
  navBy: Role;
  editor: Editor | null;
  parked: Record<string, Editor>;
  pending: Pending | null;
  scroll: { minutes: number; by: Role } | null;
  panels?: Record<string, PanelScroll>;
};

export type ViewOp =
  | { type: "init"; nav: ShellNav }
  | { type: "nav"; nav: ShellNav; baseNavVersion: number; label?: string }
  | { type: "resolve"; pendingId: string; decision: "keep" | "discard" | "continue_keep_draft" }
  // Start (or seed a reserved) edit. `initial` is the form before any change,
  // `fields` the form now; `base` the dataset version the edit began from.
  | { type: "claim"; key: string; base: number | null; initial: unknown; fields: unknown; anchor: Record<string, unknown>; label: string }
  | { type: "draft"; key: string; epoch: number; fields: unknown }
  | { type: "takeover"; key: string }
  | { type: "release"; key: string }
  | { type: "rebase"; key: string; epoch: number; base: number }
  | { type: "scroll"; minutes: number }
  | { type: "panel"; key: string; scope: string; path: number[]; frac: number; ratio: number; focus: number[] | null };

export type ViewOutcome = "ok" | "pending" | "superseded" | "denied" | "noop";
export type ViewResult = { view: SharedView | null; outcome: ViewOutcome; reason?: string };

const MAX_VIEW_BYTES = 60_000;

// JSON with object keys sorted, so the same value always compares equal --
// the database stores JSON objects with its own key order.
export function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v
  );
}

export function defaultNav(asOf: string): ShellNav {
  return { mode: "weekdays", weekOffset: 0, monthOffset: 0, asOf, center: "schedule", section: "company", clientId: null, apptId: null, dialog: null, ui: {} };
}

// ---------------------------------------------------------------------------
// Calendar position across days
// ---------------------------------------------------------------------------

const dayNumber = (key: string) => Math.floor(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)) / 86_400_000);
const mondayOf = (key: string) => {
  const n = dayNumber(key);
  const weekday = (n + 3) % 7; // 1970-01-01 was a Thursday; 0 = Monday
  return n - weekday;
};
const monthIndex = (key: string) => +key.slice(0, 4) * 12 + (+key.slice(5, 7) - 1);

// The nav's week/month offsets as seen from `today` (same calendar position).
export function offsetsFor(nav: ShellNav, today: string): { weekOffset: number; monthOffset: number } {
  if (nav.asOf === today) return { weekOffset: nav.weekOffset, monthOffset: nav.monthOffset };
  return {
    weekOffset: nav.weekOffset - Math.round((mondayOf(today) - mondayOf(nav.asOf)) / 7),
    monthOffset: nav.monthOffset - (monthIndex(today) - monthIndex(nav.asOf)),
  };
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

const navValue = (nav: ShellNav, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), nav);

// True when moving to `next` would close the form an editor belongs to.
export function closesEditor(editor: Editor, next: ShellNav): boolean {
  return Object.entries(editor.anchor).some(([path, value]) => stableJson(navValue(next, path)) !== stableJson(value));
}

const sameNav = (a: ShellNav, b: ShellNav) => stableJson(a) === stableJson(b);
const without = (parked: Record<string, Editor>, key: string) => {
  const rest = { ...parked };
  delete rest[key];
  return rest;
};
let idCounter = 0;
const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// The editor key and anchor of a form opened by navigation (a dialog, or an
// in-place edit flag in nav.ui): whoever opens it is its editor from the
// start, so the other person follows it read-only and never types over them.
export function openedForms(nav: ShellNav): Array<{ key: string; anchor: Record<string, unknown> }> {
  const forms: Array<{ key: string; anchor: Record<string, unknown> }> = [];
  // Keys name the RECORD being edited, so a parked draft comes back when that
  // record's form is opened again.
  if (nav.dialog?.kind === "edit") forms.push({ key: `appointment:${nav.dialog.appointmentId}`, anchor: { "dialog.id": nav.dialog.id } });
  if (nav.dialog?.kind === "create") forms.push({ key: "appointment:new", anchor: { "dialog.id": nav.dialog.id } });
  for (const [flag, value] of Object.entries(nav.ui)) if (value) forms.push({ key: `ui:${flag}:${value}`, anchor: { [`ui.${flag}`]: value, ...formPlace(flag, value, nav) } });
  return forms;
}

// Where an in-place edit form lives: leaving that place closes it.
function formPlace(flag: string, value: string, nav: ShellNav): Record<string, unknown> {
  if (flag === "clientEdit") return { center: "schedule", clientId: value };
  if (flag === "serviceForm") return { center: "settings", section: "services" };
  if (flag === "staffForm") return { center: "settings", section: "staff" };
  return { center: nav.center, apptId: nav.apptId };
}

// Closing (or parking) an in-place form's editor also closes the form, so
// opening it again starts -- or restores -- an edit.
function closeFormOf(nav: ShellNav, editor: Editor | null): ShellNav {
  const m = editor?.key.match(/^ui:([^:]+):(.+)$/);
  if (!m || nav.ui[m[1]] !== m[2]) return nav;
  return { ...nav, ui: { ...nav.ui, [m[1]]: null } };
}

function applyNav(view: SharedView, target: ShellNav, by: Role, dropped: Editor | null = null): SharedView {
  const closing = view.editor && closesEditor(view.editor, target) ? view.editor : null;
  const nav = closeFormOf(closeFormOf(target, closing), dropped);
  let editor = closing ? null : view.editor;
  if (!editor) {
    const before = new Set(openedForms(view.nav).map((f) => f.key));
    const opened = openedForms(nav).find((f) => !before.has(f.key));
    if (opened) {
      // Reserved for the opener until their form seeds it (claim).
      editor = { key: opened.key, role: by, epoch: (view.editor?.epoch ?? 0) + 1, base: null, fields: null, initial: "null", dirty: false, anchor: opened.anchor, label: "" };
    }
  }
  return { ...view, nav, navVersion: view.navVersion + 1, navBy: by, editor, pending: null };
}

export function reduceView(view: SharedView | null, op: ViewOp, role: Role): ViewResult {
  if (op.type === "init") {
    if (view) return { view, outcome: "noop" };
    if (role !== "host") return { view, outcome: "denied", reason: "only the host starts the shared view" };
    return { view: { nav: op.nav, navVersion: 1, navBy: "host", editor: null, parked: {}, pending: null, scroll: null }, outcome: "ok" };
  }
  if (!view) return { view, outcome: "denied", reason: "no shared view yet" };
  const result = reduce(view, op, role);
  if (result.view && JSON.stringify(result.view).length > MAX_VIEW_BYTES) return { view, outcome: "denied", reason: "too large" };
  return result;
}

function reduce(view: SharedView, op: Exclude<ViewOp, { type: "init" }>, role: Role): ViewResult {
  switch (op.type) {
    case "nav": {
      // Host priority: the guest can't override a host move it hadn't seen.
      if (role === "visitor" && view.navBy === "host" && view.navVersion > op.baseNavVersion) {
        return { view, outcome: "superseded", reason: "the host moved first" };
      }
      if (view.pending && view.pending.by !== role && role === "visitor") {
        return { view, outcome: "superseded", reason: "waiting on the host's request" };
      }
      if (sameNav(view.nav, op.nav)) return { view: view.pending?.by === role ? { ...view, pending: null } : view, outcome: "noop" };
      const editor = view.editor;
      if (editor && editor.dirty && closesEditor(editor, op.nav)) {
        // Never close unsaved work: ask, visibly, on both screens.
        return { view: { ...view, pending: { id: newId(), by: role, nav: op.nav, label: op.label ?? "" } }, outcome: "pending" };
      }
      return { view: applyNav(view, op.nav, role), outcome: "ok" };
    }

    case "resolve": {
      const p = view.pending;
      if (!p || p.id !== op.pendingId) return { view, outcome: "noop" };
      const owner = view.editor?.role ?? null;
      if (op.decision === "keep") {
        if (role !== owner && role !== p.by && role !== "host") return { view, outcome: "denied" };
        return { view: { ...view, pending: null }, outcome: "ok" };
      }
      if (op.decision === "discard") {
        // Only the draft's owner discards it (the host may discard its own).
        if (owner !== null && role !== owner) return { view, outcome: "denied", reason: "only the person editing can discard" };
        return { view: applyNav({ ...view, editor: null }, p.nav, p.by, view.editor), outcome: "ok" };
      }
      // continue_keep_draft: the host moves on; the draft is parked, intact.
      if (role !== "host") return { view, outcome: "denied", reason: "only the host can continue" };
      const parked = view.editor ? { ...view.parked, [view.editor.key]: view.editor } : view.parked;
      return { view: applyNav({ ...view, editor: null, parked }, p.nav, p.by, view.editor), outcome: "ok" };
    }

    case "claim": {
      const current = view.editor;
      if (current && current.key === op.key) {
        if (current.role !== role) return { view, outcome: "denied", reason: `${current.label || "This form"} is being edited by the other person` };
        if (current.fields !== null) return { view, outcome: "noop" };
        const parked = view.parked[op.key];
        if (parked) {
          // Reopening a parked draft restores it -- fields and ORIGINAL edit version.
          return { view: { ...view, editor: { ...parked, role, epoch: current.epoch, anchor: current.anchor }, parked: without(view.parked, op.key) }, outcome: "ok" };
        }
        // Seeding the editor reserved for this person when they opened the form.
        const initial = stableJson(op.initial);
        return { view: { ...view, editor: { ...current, base: op.base, initial, fields: op.fields, dirty: stableJson(op.fields) !== initial, label: op.label } }, outcome: "ok" };
      }
      if (current && (current.dirty || current.fields === null)) return { view, outcome: "denied", reason: `${current.label || "Another form"} is open for editing` };
      const parked = view.parked[op.key];
      if (parked) {
        // Reopening a parked draft restores it, original edit version included.
        return { view: { ...view, editor: { ...parked, role, epoch: parked.epoch + 1, anchor: op.anchor }, parked: without(view.parked, op.key) }, outcome: "ok" };
      }
      const initial = stableJson(op.initial);
      const editor: Editor = { key: op.key, role, epoch: (current?.epoch ?? 0) + 1, base: op.base, fields: op.fields, initial, dirty: stableJson(op.fields) !== initial, anchor: op.anchor, label: op.label };
      return { view: { ...view, editor }, outcome: "ok" };
    }

    case "draft": {
      const e = view.editor;
      if (!e || e.key !== op.key || e.role !== role || e.epoch !== op.epoch || e.fields === null) return { view, outcome: "denied", reason: "not the active editor" };
      const fields = op.fields;
      return { view: { ...view, editor: { ...e, fields, dirty: stableJson(fields) !== e.initial } }, outcome: "ok" };
    }

    case "takeover": {
      const e = view.editor;
      if (!e || e.key !== op.key) return { view, outcome: "noop" };
      if (e.role === role) return { view, outcome: "noop" };
      // The host can always take over; the guest only from an idle editor.
      if (role === "visitor" && e.dirty) return { view, outcome: "denied", reason: "the host is editing" };
      return { view: { ...view, editor: { ...e, role, epoch: e.epoch + 1 } }, outcome: "ok" };
    }

    case "release": {
      const e = view.editor;
      if (!e || e.key !== op.key) {
        return { view: { ...view, parked: without(view.parked, op.key) }, outcome: "noop" };
      }
      if (e.role !== role && role !== "host") return { view, outcome: "denied" };
      // Saved or deliberately cancelled: a waiting navigation goes ahead.
      const released = { ...view, editor: null };
      return { view: view.pending ? applyNav(released, view.pending.nav, view.pending.by) : released, outcome: "ok" };
    }

    case "rebase": {
      const e = view.editor;
      if (!e || e.key !== op.key || e.role !== role || e.epoch !== op.epoch) return { view, outcome: "denied" };
      return { view: { ...view, editor: { ...e, base: op.base } }, outcome: "ok" };
    }

    case "scroll":
      if (!Number.isFinite(op.minutes) || op.minutes < 0 || op.minutes > 24 * 60) return { view, outcome: "denied" };
      return { view: { ...view, scroll: { minutes: Math.round(op.minutes), by: role } }, outcome: "ok" };

    case "panel": {
      const fraction = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
      const path = (v: unknown) => Array.isArray(v) && v.length <= 30 && v.every((i) => Number.isInteger(i) && i >= 0 && i < 1000);
      if (!/^[a-z-]{1,24}$/.test(op.key) || typeof op.scope !== "string" || op.scope.length > 80
          || !path(op.path) || !fraction(op.frac) || !fraction(op.ratio) || !(op.focus === null || path(op.focus))) {
        return { view, outcome: "denied" };
      }
      // While someone is editing, only the editor moves the panel for both.
      if (view.editor && view.editor.fields !== null && view.editor.role !== role) return { view, outcome: "denied", reason: "the other person is editing" };
      const entry: PanelScroll = { scope: op.scope, path: op.path, frac: Math.round(op.frac * 1000) / 1000, ratio: Math.round(op.ratio * 1000) / 1000, focus: op.focus, by: role };
      return { view: { ...view, panels: { ...(view.panels ?? {}), [op.key]: entry } }, outcome: "ok" };
    }
  }
}

// A shared draft's key in the form a save request can carry (EDIT_BASE_HEADER).
export const editMarkerKey = (key: string) => key.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64);

// Validates a view operation received from a browser before it is reduced.
export function isViewOp(value: unknown): value is ViewOp {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && ["init", "nav", "resolve", "claim", "draft", "takeover", "release", "rebase", "scroll", "panel"].includes(t);
}
