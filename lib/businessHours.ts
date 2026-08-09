import { DateTime } from "luxon";

// Canonical, lowercase weekday keys -- the only valid keys in a stored
// business_hours JSONB object (company_settings.business_hours). Order here
// is Monday-first, matching every other calendar surface in this app
// (lib/monthGrid.ts's grid, ScheduleGrid's week view).
export const WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

// A single open period on one day, stored as normalized 24-hour wall-clock
// "HH:mm" strings -- never a locale-formatted "8:00 AM". Interpreted as
// business-local time (BUSINESS_TZ) until the dedicated Time Zone phase.
export type TimeRange = { start: string; end: string };

export type BusinessHours = Record<WeekdayKey, TimeRange[]>;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeString(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

function freshDefault(): BusinessHours {
  const weekday: TimeRange[] = [{ start: "07:00", end: "17:00" }];
  return {
    monday: [...weekday],
    tuesday: [...weekday],
    wednesday: [...weekday],
    thursday: [...weekday],
    friday: [...weekday],
    saturday: [],
    sunday: [],
  };
}

// Existing SFT behavior today (see lib/availability.ts's prior
// BUSINESS_OPEN_HOUR/BUSINESS_CLOSE_HOUR constants) -- the fallback applied
// whenever a workspace has no saved business_hours yet, so adding this
// column never changes an existing workspace's effective availability.
export const DEFAULT_BUSINESS_HOURS: BusinessHours = freshDefault();

export function cloneBusinessHours(hours: BusinessHours): BusinessHours {
  const clone = {} as BusinessHours;
  for (const day of WEEKDAY_KEYS) {
    clone[day] = hours[day].map((r) => ({ ...r }));
  }
  return clone;
}

export type BusinessHoursValidation =
  | { ok: true; value: BusinessHours }
  | { ok: false; error: string };

// Validates and normalizes an arbitrary (untrusted) value into a canonical
// BusinessHours object: exactly the seven lowercase weekday keys, each an
// array of valid, non-zero-length, non-overlapping HH:mm ranges sorted
// chronologically. Touching, adjacent ranges (one's end equals the next's
// start) are merged rather than rejected -- e.g. 08:00-12:00 + 12:00-17:00
// normalizes to a single 08:00-17:00 range. The returned value is always a
// freshly-built object containing only the fields this function itself
// recognizes (start/end strings), so no unexpected/extra property from the
// input can ever reach storage.
export function normalizeBusinessHours(input: unknown): BusinessHoursValidation {
  if (input === null || input === undefined) {
    return { ok: true, value: freshDefault() };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Business hours must be an object keyed by weekday." };
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(WEEKDAY_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `"${key}" is not a valid weekday.` };
    }
  }

  const result = {} as BusinessHours;
  for (const day of WEEKDAY_KEYS) {
    const raw = record[day];
    if (raw === undefined) {
      result[day] = [];
      continue;
    }
    if (!Array.isArray(raw)) {
      return { ok: false, error: `"${day}" must be a list of time ranges.` };
    }

    const parsed: TimeRange[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) {
        return { ok: false, error: `"${day}" contains an invalid time range.` };
      }
      const start = (item as Record<string, unknown>).start;
      const end = (item as Record<string, unknown>).end;
      if (!isValidTimeString(start) || !isValidTimeString(end)) {
        return { ok: false, error: `"${day}" contains a time that is not in HH:mm format.` };
      }
      if (start >= end) {
        return { ok: false, error: `"${day}" has a range where the start time is not before the end time.` };
      }
      parsed.push({ start, end });
    }

    parsed.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    const merged: TimeRange[] = [];
    for (const range of parsed) {
      const last = merged[merged.length - 1];
      if (last && range.start < last.end) {
        return { ok: false, error: `"${day}" has overlapping time ranges.` };
      }
      if (last && range.start === last.end) {
        last.end = range.end;
        continue;
      }
      merged.push({ ...range });
    }

    result[day] = merged;
  }

  return { ok: true, value: result };
}

// The hours actually in effect for a workspace: the saved value if present
// and valid, otherwise the canonical Mon-Fri 07:00-17:00 fallback -- never a
// partially-applied or rejected value. Use this to read business_hours
// (from a company_settings row, GET response, etc.), never
// normalizeBusinessHours directly, since a stored row is already trusted
// (validated at save time) and a NULL/missing column must fall back rather
// than error.
export function effectiveBusinessHours(stored: unknown): BusinessHours {
  if (stored === null || stored === undefined) return cloneBusinessHours(DEFAULT_BUSINESS_HOURS);
  const result = normalizeBusinessHours(stored);
  return result.ok ? result.value : cloneBusinessHours(DEFAULT_BUSINESS_HOURS);
}

// Maps a business-local calendar date (yyyy-MM-dd) to its canonical weekday
// key, using Luxon's IANA-backed weekday resolution (1=Monday..7=Sunday) so
// it agrees with lib/availability.ts's businessDateStringFromInstant/
// businessDayBounds regardless of the runtime's own ambient timezone.
//
// Phase 5D: `tz` is an explicit, required parameter -- the resolved
// workspace timezone -- never a global default. Every caller (Business
// Hours enforcement, public booking availability) must resolve and pass
// its own trusted timezone; there is no compatibility fallback left for
// this module.
export function weekdayKeyForDate(dateStr: string, tz: string): WeekdayKey | null {
  const dt = DateTime.fromISO(dateStr, { zone: tz });
  if (!dt.isValid) return null;
  return WEEKDAY_KEYS[dt.weekday - 1];
}

export function rangesForDate(hours: BusinessHours, dateStr: string, tz: string): TimeRange[] {
  const key = weekdayKeyForDate(dateStr, tz);
  return key ? hours[key] : [];
}
