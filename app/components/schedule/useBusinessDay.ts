"use client";

import { useEffect, useState } from "react";
import { businessDayKey, msUntilNextBusinessDay } from "@/lib/timezone";

const systemNow = () => new Date();

// The workspace's current business day ("YYYY-MM-DD"), kept current so the
// calling screen re-renders the moment the day changes: at the next
// business midnight, whenever the tab becomes visible or regains focus (a
// sleeping laptop or backgrounded phone can delay or skip timers), and on a
// light once-a-minute check as a fallback. EmployeeSchedule uses it so the
// Start button and its explanation always reflect today without a refresh.
// `now` exists only so tests can control the clock.
export function useBusinessDay(timezone: string, now: () => Date = systemNow): string {
  const [day, setDay] = useState(() => businessDayKey(timezone, now()));

  // Syncs React state with an external system (the clock), the use case
  // the effect rule itself allows.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let midnight: ReturnType<typeof setTimeout> | undefined;
    const check = () => setDay(businessDayKey(timezone, now()));
    const scheduleMidnight = () => {
      clearTimeout(midnight);
      // +1s so the timer lands safely after midnight, not a hair before it.
      midnight = setTimeout(() => {
        check();
        scheduleMidnight();
      }, msUntilNextBusinessDay(timezone, now()) + 1000);
    };
    const onWake = () => {
      if (document.visibilityState === "hidden") return;
      check();
      scheduleMidnight();
    };

    check();
    scheduleMidnight();
    const fallback = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      clearTimeout(midnight);
      clearInterval(fallback);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [timezone, now]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return day;
}
