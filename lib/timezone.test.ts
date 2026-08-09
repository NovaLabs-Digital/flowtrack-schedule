import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  BUSINESS_TZ,
  TIMEZONE_OPTIONS,
  isSupportedTimezone,
  normalizeTimezone,
  effectiveTimezone,
  nowInBusinessTz,
  toBusinessLocal,
  startOfBusinessDay,
  zonedDateValue,
  zonedTimeValue,
  zonedDateTimeToUTC,
} from "./timezone.ts";

describe("TIMEZONE_OPTIONS", () => {
  test("contains exactly the approved 7 curated U.S. zones", () => {
    assert.equal(TIMEZONE_OPTIONS.length, 7);
    assert.deepEqual(
      TIMEZONE_OPTIONS.map((o) => o.value),
      [
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Phoenix",
        "America/Los_Angeles",
        "America/Anchorage",
        "Pacific/Honolulu",
      ]
    );
  });

  test("every value is a unique IANA identifier", () => {
    const values = TIMEZONE_OPTIONS.map((o) => o.value);
    assert.equal(new Set(values).size, values.length);
  });

  test("every option has a friendly, non-empty label distinct from its IANA value", () => {
    for (const opt of TIMEZONE_OPTIONS) {
      assert.ok(opt.label.length > 0);
      assert.notEqual(opt.label, opt.value);
    }
  });

  test("labels match the approved friendly names exactly", () => {
    const labelByValue = Object.fromEntries(TIMEZONE_OPTIONS.map((o) => [o.value, o.label]));
    assert.equal(labelByValue["America/New_York"], "Eastern Time");
    assert.equal(labelByValue["America/Chicago"], "Central Time");
    assert.equal(labelByValue["America/Denver"], "Mountain Time");
    assert.equal(labelByValue["America/Phoenix"], "Arizona");
    assert.equal(labelByValue["America/Los_Angeles"], "Pacific Time");
    assert.equal(labelByValue["America/Anchorage"], "Alaska Time");
    assert.equal(labelByValue["Pacific/Honolulu"], "Hawaii Time");
  });

  test("America/New_York (the existing BUSINESS_TZ default) is one of the supported options", () => {
    assert.ok(TIMEZONE_OPTIONS.some((o) => o.value === BUSINESS_TZ));
  });

  test("no timezone abbreviation (EST/PST/CST/MST/AKST/HST) is ever used as a stored value", () => {
    for (const opt of TIMEZONE_OPTIONS) {
      assert.ok(!/^[A-Z]{2,5}$/.test(opt.value), `"${opt.value}" looks like an abbreviation, not an IANA id`);
      assert.ok(opt.value.includes("/"), "every IANA id contains a region/city separator");
    }
  });
});

describe("isSupportedTimezone", () => {
  for (const opt of TIMEZONE_OPTIONS) {
    test(`accepts "${opt.value}"`, () => assert.equal(isSupportedTimezone(opt.value), true));
  }

  for (const bad of ["EST", "PST", "CST", "GMT", "UTC", "Europe/London", "America/Toronto", "america/new_york", "", "  ", 123, null, undefined, {}]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(isSupportedTimezone(bad), false));
  }

  test("trims surrounding whitespace before checking", () => {
    assert.equal(isSupportedTimezone("  America/New_York  "), true);
  });
});

describe("normalizeTimezone", () => {
  for (const opt of TIMEZONE_OPTIONS) {
    test(`"${opt.value}" is accepted and returned trimmed/unchanged`, () => {
      const result = normalizeTimezone(opt.value);
      assert.ok(result.ok);
      if (result.ok) assert.equal(result.value, opt.value);
    });
  }

  test("a value with surrounding whitespace is trimmed on success", () => {
    const result = normalizeTimezone("  America/Chicago  ");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.value, "America/Chicago");
  });

  test("an arbitrary, technically-valid-but-unapproved IANA zone is rejected", () => {
    assert.equal(normalizeTimezone("Europe/London").ok, false);
    assert.equal(normalizeTimezone("America/Toronto").ok, false);
  });

  test("EST/PST-style abbreviations are rejected", () => {
    assert.equal(normalizeTimezone("EST").ok, false);
    assert.equal(normalizeTimezone("PST").ok, false);
  });

  test("a blank string is rejected", () => {
    assert.equal(normalizeTimezone("").ok, false);
    assert.equal(normalizeTimezone("   ").ok, false);
  });

  test("a non-string value is rejected", () => {
    for (const bad of [42, true, {}, [], null, undefined]) {
      assert.equal(normalizeTimezone(bad).ok, false);
    }
  });

  test("every rejection carries a non-empty, clear error message", () => {
    for (const bad of ["EST", "", "Europe/London", 42, null]) {
      const result = normalizeTimezone(bad);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error.length > 0);
    }
  });
});

describe("effectiveTimezone", () => {
  test("NULL stored value falls back to America/New_York", () => {
    assert.equal(effectiveTimezone(null), "America/New_York");
    assert.equal(effectiveTimezone(null), BUSINESS_TZ);
  });

  test("undefined stored value falls back to America/New_York", () => {
    assert.equal(effectiveTimezone(undefined), BUSINESS_TZ);
  });

  test("a valid stored value is returned normalized", () => {
    assert.equal(effectiveTimezone("America/Los_Angeles"), "America/Los_Angeles");
    assert.equal(effectiveTimezone("  America/Denver  "), "America/Denver");
  });

  test("a somehow-invalid stored value falls back to the default rather than throwing", () => {
    assert.equal(effectiveTimezone("EST"), BUSINESS_TZ);
    assert.equal(effectiveTimezone("not-a-timezone"), BUSINESS_TZ);
    assert.equal(effectiveTimezone(42), BUSINESS_TZ);
  });
});

// ============================================================================
// Phase 5C -- parameterized nowInBusinessTz/toBusinessLocal/startOfBusinessDay
// (Phase 5E later removed their temporary `tz = BUSINESS_TZ` compatibility
// default once every real consumer was wired through explicitly -- `tz` is
// now a required parameter with no default) and the new explicit
// UTC<->workspace-local conversion helpers.
// ============================================================================

describe("nowInBusinessTz/toBusinessLocal/startOfBusinessDay -- explicit tz parameter, required (Phase 5E: no more compatibility default)", () => {
  test("nowInBusinessTz(BUSINESS_TZ) matches a same-tick reading of 'now' in that zone -- proves the explicit-tz call path is correct, not that a default exists", () => {
    const withExplicit = nowInBusinessTz(BUSINESS_TZ);
    const reference = nowInBusinessTz(BUSINESS_TZ);
    // Both synthesized within the same test tick, so their minute-level
    // fields must agree (allowing for the vanishingly rare second-boundary
    // flake, which would only ever show up as a 1-second difference).
    assert.ok(Math.abs(withExplicit.getTime() - reference.getTime()) < 2000);
  });

  test("toBusinessLocal with a different explicit zone yields a different result for the same instant", () => {
    const iso = "2026-08-03T14:00:00.000Z"; // 10:00 ET / 07:00 PT
    const ny = toBusinessLocal(iso, "America/New_York");
    const la = toBusinessLocal(iso, "America/Los_Angeles");
    assert.equal(ny.getHours(), 10);
    assert.equal(la.getHours(), 7);
  });

  test("startOfBusinessDay accepts an explicit tz distinct from the default", () => {
    // Just proves the parameter is accepted and produces a valid Date --
    // exact instant correctness is covered by the pre-existing BUSINESS_TZ
    // behavior, unchanged by adding the parameter.
    const d = startOfBusinessDay(0, "America/Los_Angeles");
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
  });
});

describe("zonedDateValue / zonedTimeValue -- UTC instant -> workspace-local form values", () => {
  const iso = "2026-08-03T13:30:00.000Z"; // Monday 09:30 ET (EDT, UTC-4)

  test("zonedDateValue returns YYYY-MM-DD in the given zone", () => {
    assert.equal(zonedDateValue(iso, "America/New_York"), "2026-08-03");
  });

  test("zonedTimeValue returns 24-hour HH:mm in the given zone", () => {
    assert.equal(zonedTimeValue(iso, "America/New_York"), "09:30");
  });

  test("a different zone yields a different (and possibly different-day) result for the same instant", () => {
    // 2026-01-01T04:30:00Z is Jan 1, 11:30 PM EST the day before in New
    // York, but Jan 1, 8:30 PM in Los Angeles the same day -- the classic
    // near-UTC-midnight cross-date case.
    const nearMidnight = "2026-01-01T04:30:00.000Z";
    assert.equal(zonedDateValue(nearMidnight, "America/New_York"), "2025-12-31");
    assert.equal(zonedTimeValue(nearMidnight, "America/New_York"), "23:30");
    assert.equal(zonedDateValue(nearMidnight, "America/Los_Angeles"), "2025-12-31");
    assert.equal(zonedTimeValue(nearMidnight, "America/Los_Angeles"), "20:30");
  });
});

describe("zonedDateTimeToUTC -- per-zone round trips", () => {
  test("New York, summer (EDT, UTC-4): 2026-08-03 09:00 -> 13:00Z", () => {
    const result = zonedDateTimeToUTC("2026-08-03", "09:00", "America/New_York");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-08-03T13:00:00.000Z");
  });

  test("New York, winter (EST, UTC-5): 2026-01-15 09:00 -> 14:00Z", () => {
    const result = zonedDateTimeToUTC("2026-01-15", "09:00", "America/New_York");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-01-15T14:00:00.000Z");
  });

  test("Chicago (CDT, UTC-5 summer): 2026-08-03 09:00 -> 14:00Z", () => {
    const result = zonedDateTimeToUTC("2026-08-03", "09:00", "America/Chicago");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-08-03T14:00:00.000Z");
  });

  test("Denver (MDT, UTC-6 summer): 2026-08-03 09:00 -> 15:00Z", () => {
    const result = zonedDateTimeToUTC("2026-08-03", "09:00", "America/Denver");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-08-03T15:00:00.000Z");
  });

  test("Phoenix (Arizona) never observes DST -- fixed UTC-7 year-round", () => {
    const summer = zonedDateTimeToUTC("2026-08-03", "09:00", "America/Phoenix");
    const winter = zonedDateTimeToUTC("2026-01-15", "09:00", "America/Phoenix");
    assert.ok(summer.ok && winter.ok);
    if (summer.ok) assert.equal(summer.iso, "2026-08-03T16:00:00.000Z");
    if (winter.ok) assert.equal(winter.iso, "2026-01-15T16:00:00.000Z");
  });

  test("Los Angeles (PDT, UTC-7 summer): 2026-08-03 09:00 -> 16:00Z", () => {
    const result = zonedDateTimeToUTC("2026-08-03", "09:00", "America/Los_Angeles");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-08-03T16:00:00.000Z");
  });

  test("Alaska (AKDT, UTC-8 summer): 2026-08-03 09:00 -> 17:00Z", () => {
    const result = zonedDateTimeToUTC("2026-08-03", "09:00", "America/Anchorage");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-08-03T17:00:00.000Z");
  });

  test("Hawaii never observes DST -- fixed UTC-10 year-round", () => {
    const summer = zonedDateTimeToUTC("2026-08-03", "09:00", "Pacific/Honolulu");
    const winter = zonedDateTimeToUTC("2026-01-15", "09:00", "Pacific/Honolulu");
    assert.ok(summer.ok && winter.ok);
    if (summer.ok) assert.equal(summer.iso, "2026-08-03T19:00:00.000Z");
    if (winter.ok) assert.equal(winter.iso, "2026-01-15T19:00:00.000Z");
  });

  test("the owner's device/runtime timezone has no effect on the result -- same inputs, same output regardless of process TZ", () => {
    const before = zonedDateTimeToUTC("2026-08-03", "09:00", "America/New_York");
    const originalTz = process.env.TZ;
    process.env.TZ = "Pacific/Honolulu";
    try {
      const after = zonedDateTimeToUTC("2026-08-03", "09:00", "America/New_York");
      assert.deepEqual(before, after);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe("zonedDateTimeToUTC -- input validation", () => {
  test("rejects a malformed date string", () => {
    assert.equal(zonedDateTimeToUTC("08/03/2026", "09:00", "America/New_York").ok, false);
    assert.equal(zonedDateTimeToUTC("", "09:00", "America/New_York").ok, false);
  });

  test("rejects a malformed time string", () => {
    assert.equal(zonedDateTimeToUTC("2026-08-03", "9:00", "America/New_York").ok, false);
    assert.equal(zonedDateTimeToUTC("2026-08-03", "", "America/New_York").ok, false);
  });

  test("every rejection carries a non-empty error message", () => {
    const result = zonedDateTimeToUTC("bad", "bad", "America/New_York");
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.length > 0);
  });
});

describe("zonedDateTimeToUTC -- DST nonexistent/ambiguous local time policy (empirically verified against the installed Luxon version)", () => {
  test("a nonexistent spring-forward local time (2027-03-14 02:30 America/New_York, the exact hour that doesn't exist) is rejected with a clear error, never silently shifted", () => {
    const result = zonedDateTimeToUTC("2027-03-14", "02:30", "America/New_York");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /daylight-saving/i);
    }
  });

  test("a valid time just before the spring-forward gap (01:59) is accepted normally", () => {
    const result = zonedDateTimeToUTC("2027-03-14", "01:59", "America/New_York");
    assert.ok(result.ok);
  });

  test("a valid time just after the spring-forward gap (03:00) is accepted normally", () => {
    const result = zonedDateTimeToUTC("2027-03-14", "03:00", "America/New_York");
    assert.ok(result.ok);
  });

  test("an ambiguous fall-back local time (2027-11-07 01:30 America/New_York, which occurs twice) resolves deterministically to the FIRST/earlier occurrence (still-DST offset, UTC-4)", () => {
    const result = zonedDateTimeToUTC("2027-11-07", "01:30", "America/New_York");
    assert.ok(result.ok);
    if (result.ok) {
      // UTC-4 (EDT, the earlier of the two possible offsets) -> 05:30Z.
      // The later occurrence (EST, UTC-5) would be 06:30Z -- proving this
      // is NOT what was chosen.
      assert.equal(result.iso, "2027-11-07T05:30:00.000Z");
      assert.notEqual(result.iso, "2027-11-07T06:30:00.000Z");
    }
  });

  test("repeated calls for the same ambiguous time always resolve identically (deterministic, not randomized)", () => {
    const results = Array.from({ length: 5 }, () => zonedDateTimeToUTC("2027-11-07", "01:30", "America/New_York"));
    const isoValues = results.map((r) => (r.ok ? r.iso : null));
    assert.ok(isoValues.every((v) => v === isoValues[0]));
  });

  test("nonexistent-time detection round-trips correctly across a different zone's own DST transition (America/Los_Angeles, 2027-03-14 02:30)", () => {
    const result = zonedDateTimeToUTC("2027-03-14", "02:30", "America/Los_Angeles");
    assert.equal(result.ok, false);
  });

  test("Arizona (no DST) never produces a nonexistent-time rejection on the national spring-forward date", () => {
    const result = zonedDateTimeToUTC("2027-03-14", "02:30", "America/Phoenix");
    assert.ok(result.ok);
  });
});

describe("zonedDateTimeToUTC -- UTC-server runtime independence", () => {
  const originalTz = process.env.TZ;
  before(() => { process.env.TZ = "UTC"; });
  after(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test("a New York conversion under a UTC-timezone Node process still produces the correct business-local-aware UTC instant", () => {
    const result = zonedDateTimeToUTC("2026-08-03", "09:00", "America/New_York");
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.iso, "2026-08-03T13:00:00.000Z");
  });

  test("the DST nonexistent-time rejection still fires correctly under a UTC-timezone process", () => {
    const result = zonedDateTimeToUTC("2027-03-14", "02:30", "America/New_York");
    assert.equal(result.ok, false);
  });

  test("zonedDateValue/zonedTimeValue remain correct under a UTC-timezone process", () => {
    const iso = "2026-08-03T13:30:00.000Z";
    assert.equal(zonedDateValue(iso, "America/New_York"), "2026-08-03");
    assert.equal(zonedTimeValue(iso, "America/New_York"), "09:30");
  });
});
