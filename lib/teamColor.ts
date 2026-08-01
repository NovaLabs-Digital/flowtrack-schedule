// Phase 5.7D-R19: shared Team Color validation, palette, and resolution
// rules for appointments with two or more assigned employees. A single
// source of truth so the create/update/manage-recurrence API routes, the
// appointment modal's selector, and every schedule-rendering surface
// (desktop ScheduleGrid, mobile cards) can never disagree about what a
// valid color is or which color an appointment should actually show.
import type { AppointmentEmployeeAssignment, Employee } from "@/app/components/dashboard/types";
import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Strict #RRGGBB only -- no shorthand (#RGB), no alpha channel, no CSS
// color names, no CSS functions (rgb(...), var(...)), no arbitrary string.
// Normalizes case to uppercase so a stored value and a freshly-typed one
// always compare equal regardless of how either was cased. Returns null
// for anything that doesn't match, including null/undefined/empty input --
// every caller treats null as "not a valid team color," never throws.
export function normalizeHexColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

export function isValidHexColor(value: string | null | undefined): boolean {
  return normalizeHexColor(value) !== null;
}

export type TeamColorValidationResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

// Validates a client-submitted team_color value for a write. Callers must
// handle `undefined` (field not part of the request -- leave the stored
// value unchanged) before ever calling this; this function only ever sees
// a value the caller actually intends to write. `null` always succeeds
// (explicitly clears the selection, per the preserve-vs-clear rule: this
// is the ONLY way team_color is ever cleared -- dropping to one or zero
// employees never implicitly clears it, see resolveTeamAccentColor below).
// A string must be a strict #RRGGBB hex value, matching the same rule the
// database CHECK constraint enforces (migrations/022), so client and
// server can never disagree about what's valid.
export function validateTeamColorInput(value: unknown): TeamColorValidationResult {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "team_color must be a string or null." };
  const normalized = normalizeHexColor(value);
  if (!normalized) return { ok: false, error: "team_color must be a valid #RRGGBB hex color." };
  return { ok: true, value: normalized };
}

export type TeamColorOption = { hex: string; label: string };

// The fixed set of neutral/team color choices offered alongside assigned
// employees' own colors. Deliberately small and visually distinct -- not
// user-extensible (see normalizeHexColor: the UI never accepts free-text
// color entry, only a value drawn from an employee's own color or this
// list).
export const TEAM_COLOR_PALETTE: TeamColorOption[] = [
  { hex: "#2563EB", label: "Blue" },
  { hex: "#7C3AED", label: "Purple" },
  { hex: "#DB2777", label: "Pink" },
  { hex: "#DC2626", label: "Red" },
  { hex: "#EA580C", label: "Orange" },
  { hex: "#D97706", label: "Amber" },
  { hex: "#16A34A", label: "Green" },
  { hex: "#0D9488", label: "Teal" },
  { hex: "#475569", label: "Slate" },
];

export type TeamColorChoice = TeamColorOption & { kind: "employee" | "palette" };

// Builds the full list of selectable Team Color choices for the modal:
// each currently assigned employee's own color first (labeled with their
// name), followed by the fixed palette -- with any palette color that
// exactly matches an already-listed color (an employee's own color, or an
// earlier employee sharing the same color) silently dropped, so the picker
// never shows two visually identical swatches.
export function buildTeamColorChoices(assignedEmployees: Pick<Employee, "name" | "color">[]): TeamColorChoice[] {
  const seen = new Set<string>();
  const choices: TeamColorChoice[] = [];

  for (const emp of assignedEmployees) {
    const normalized = normalizeHexColor(emp.color);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    choices.push({ hex: normalized, label: emp.name, kind: "employee" });
  }

  for (const option of TEAM_COLOR_PALETTE) {
    const normalized = normalizeHexColor(option.hex)!;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    choices.push({ hex: normalized, label: option.label, kind: "palette" });
  }

  return choices;
}

// The single shared rule for "what color should this appointment's card
// actually show," given its current assignments, the workspace's employee
// records, and its stored team_color (which may be null, or -- since
// stored data always outlives the code that wrote it -- theoretically
// invalid; this never trusts it blindly):
//
//   0 assignments        -> null (caller uses its own unassigned/default appearance)
//   1 assignment          -> that employee's own color, team_color ignored entirely
//   2+ assignments, team_color valid   -> team_color
//   2+ assignments, team_color null/invalid -> the first assignment's employee
//                                               color, by stable assignment order
//
// "First assignment" uses sortAssignmentsStable (lib/sortAssignmentsStable.ts)
// so the fallback is deterministic and agrees with the order employee
// names and Worked Hours rows are listed in -- never the incidental order
// a query happened to return.
export function resolveTeamAccentColor(
  assignments: Pick<AppointmentEmployeeAssignment, "id" | "employee_id" | "created_at">[],
  employeeById: Record<string, Pick<Employee, "color"> | undefined>,
  teamColor: string | null | undefined
): string | null {
  if (assignments.length === 0) return null;

  const ordered = sortAssignmentsStable(assignments);

  if (ordered.length === 1) {
    return employeeById[ordered[0].employee_id]?.color ?? null;
  }

  const normalizedTeamColor = normalizeHexColor(teamColor);
  if (normalizedTeamColor) return normalizedTeamColor;

  return employeeById[ordered[0].employee_id]?.color ?? null;
}
