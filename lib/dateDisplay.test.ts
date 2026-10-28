// Direct unit tests for lib/dateDisplay.ts's shared MM/DD/YY formatters --
// extracted from BillingPanel.tsx's own original formatMMDDYY (same exact
// behavior, now reusable) plus the new timestamp-aware wrapper.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatMMDDYY, formatTimestampMMDDYY } from "./dateDisplay.ts";

describe("formatMMDDYY -- date-only \"YYYY-MM-DD\" strings, never a Date/timezone conversion", () => {
  test("formats a plain calendar date as MM/DD/YY", () => {
    assert.equal(formatMMDDYY("2026-08-20"), "08/20/26");
  });

  test("a single-digit month/day keeps its existing zero-padding (no re-padding applied or assumed)", () => {
    assert.equal(formatMMDDYY("2026-01-05"), "01/05/26");
  });

  test("only the last two digits of the year are kept, never a 4-digit year", () => {
    assert.equal(formatMMDDYY("1999-12-31"), "12/31/99");
    assert.equal(formatMMDDYY("2000-01-01"), "01/01/00");
  });

  test("a date at the very end of the year is not shifted to the next/previous day -- pure string split, no Date arithmetic", () => {
    assert.equal(formatMMDDYY("2025-12-31"), "12/31/25");
    assert.equal(formatMMDDYY("2026-01-01"), "01/01/26");
  });

  test("a malformed input (fewer than 3 hyphen-separated, non-empty parts) is returned unchanged rather than throwing", () => {
    assert.equal(formatMMDDYY(""), "");
    assert.equal(formatMMDDYY("2026-08"), "2026-08");
    assert.equal(formatMMDDYY("2026--20"), "2026--20"); // empty month segment
  });

  test("never constructs a Date object -- confirmed by giving it a string new Date() would mis-parse across a UTC offset boundary and getting back the UNCHANGED digits regardless of the runtime's own ambient timezone", () => {
    // If this were implemented as `new Date(dateOnly).toLocaleDateString()`,
    // the result would depend on the process's own local timezone (UTC
    // midnight can roll back a day west of the Prime Meridian). The pure
    // string-split implementation must return the exact same digits
    // regardless of what TZ the test runner itself happens to be in.
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu"; // UTC-10, the most extreme common case
      assert.equal(formatMMDDYY("2026-03-01"), "03/01/26");
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});

describe("formatTimestampMMDDYY -- real UTC instants, resolved through the business timezone first", () => {
  test("formats a straightforward daytime instant in the given zone", () => {
    // Monday 09:30 ET (EDT, UTC-4) -- same fixture as lib/timezone.test.ts's
    // own zonedDateValue tests.
    assert.equal(formatTimestampMMDDYY("2026-08-03T13:30:00.000Z", "America/New_York"), "08/03/26");
  });

  test("timezone boundary: a UTC instant just after midnight resolves to the PREVIOUS calendar day in a zone behind UTC", () => {
    // 2026-01-01T04:30:00Z is 11:30 PM Dec 31 in New York (EST, UTC-5) --
    // the classic near-UTC-midnight cross-date case (same fixture as
    // lib/timezone.test.ts).
    assert.equal(formatTimestampMMDDYY("2026-01-01T04:30:00.000Z", "America/New_York"), "12/31/25");
  });

  test("the same instant resolves to a DIFFERENT calendar date in a different business timezone -- never the runtime's own ambient timezone", () => {
    const instant = "2026-01-01T04:30:00.000Z";
    assert.equal(formatTimestampMMDDYY(instant, "America/New_York"), "12/31/25");
    assert.equal(formatTimestampMMDDYY(instant, "Pacific/Honolulu"), "12/31/25"); // UTC-10: 6:30 PM Dec 31
    assert.equal(formatTimestampMMDDYY(instant, "Europe/London"), "01/01/26"); // UTC+0: 4:30 AM Jan 1
  });

  test("DST boundary: an instant just before and just after a spring-forward transition resolve to their correct respective calendar dates", () => {
    // 2027-03-14 is the US spring-forward date; 06:30Z is 1:30 AM EST the
    // same calendar day (before the 2 AM jump), still March 14.
    assert.equal(formatTimestampMMDDYY("2027-03-14T06:30:00.000Z", "America/New_York"), "03/14/27");
    // 08:30Z is 4:30 AM EDT (after the jump), still March 14 -- the date
    // itself doesn't change across a DST transition within the same day.
    assert.equal(formatTimestampMMDDYY("2027-03-14T08:30:00.000Z", "America/New_York"), "03/14/27");
  });

  test("reuses lib/timezone.ts's own zonedDateValue rather than re-deriving the business-local date independently -- same result for the same inputs", async () => {
    const { zonedDateValue } = await import("./timezone.ts");
    const iso = "2026-06-15T18:45:00.000Z";
    const tz = "America/Chicago";
    assert.equal(formatTimestampMMDDYY(iso, tz), formatMMDDYY(zonedDateValue(iso, tz)));
  });
});
