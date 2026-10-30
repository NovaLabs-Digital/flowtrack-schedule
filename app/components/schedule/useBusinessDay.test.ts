// Real rendered-hook tests for useBusinessDay.ts: the employee screen must
// move to the new business day at midnight and after a sleeping tab wakes,
// without a manual refresh. Timers are mocked; the clock is injected.
import { test, describe, afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

import "../../../lib/testDom.ts";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";

const { useBusinessDay } = await import("./useBusinessDay.ts");

const NY = "America/New_York";
let clock = new Date("2026-11-04T04:59:30Z"); // Tue Nov 3, 11:59:30 PM in New York
const now = () => clock;

function Host({ tz }: { tz: string }) {
  const day = useBusinessDay(tz, now);
  return React.createElement("div", { "data-day": day });
}
const shownDay = (container: HTMLElement) => container.querySelector("[data-day]")!.getAttribute("data-day");

beforeEach(() => {
  clock = new Date("2026-11-04T04:59:30Z");
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});
afterEach(() => {
  cleanup();
  mock.timers.reset();
});

describe("useBusinessDay", () => {
  test("rolls over to the new business day at midnight, with no refresh", () => {
    const { container } = render(React.createElement(Host, { tz: NY }));
    assert.equal(shownDay(container), "2026-11-03");
    act(() => {
      clock = new Date("2026-11-04T05:00:31Z"); // 12:00:31 AM Wed
      mock.timers.tick(31_000); // the midnight timer (30s + 1s margin)
    });
    assert.equal(shownDay(container), "2026-11-04");
  });

  test("a sleeping tab that missed its timers catches up as soon as it becomes visible or regains focus", () => {
    for (const wake of [
      () => document.dispatchEvent(new Event("visibilitychange")),
      () => window.dispatchEvent(new Event("focus")),
      () => window.dispatchEvent(new Event("pageshow")),
    ]) {
      clock = new Date("2026-11-04T04:59:30Z");
      const { container, unmount } = render(React.createElement(Host, { tz: NY }));
      assert.equal(shownDay(container), "2026-11-03");
      clock = new Date("2026-11-05T13:00:00Z"); // asleep for a day and a half; no timer fired
      act(() => wake());
      assert.equal(shownDay(container), "2026-11-05");
      unmount();
    }
  });

  test("the once-a-minute fallback catches a day change the midnight timer has not reached (e.g. a corrected device clock)", () => {
    clock = new Date("2026-11-04T04:00:00Z"); // 11:00 PM: the midnight timer is an hour away
    const { container } = render(React.createElement(Host, { tz: NY }));
    act(() => {
      clock = new Date("2026-11-04T05:00:05Z");
      mock.timers.tick(59_000);
    });
    assert.equal(shownDay(container), "2026-11-03", "nothing has checked yet");
    act(() => mock.timers.tick(1_000));
    assert.equal(shownDay(container), "2026-11-04", "the 60s check moved to the new day");
  });

  test("uses the workspace timezone, not the device's", () => {
    clock = new Date("2026-11-04T08:00:00Z"); // 3 AM Nov 4 in New York, 10 PM Nov 3 in Honolulu
    const ny = render(React.createElement(Host, { tz: NY }));
    assert.equal(shownDay(ny.container), "2026-11-04");
    const hi = render(React.createElement(Host, { tz: "Pacific/Honolulu" }));
    assert.equal(shownDay(hi.container), "2026-11-03");
  });

  test("unmounting removes its listeners and timers (later wake events are harmless)", () => {
    const { unmount } = render(React.createElement(Host, { tz: NY }));
    unmount();
    clock = new Date("2026-11-06T13:00:00Z");
    assert.doesNotThrow(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      mock.timers.tick(120_000);
    });
  });
});
