import { DateTime } from "luxon";

const BUSINESS_TZ = "America/New_York";

// A JS Date representing "right now," but with its local getters/setters
// (getDate, getDay, getHours, setHours, toDateString, etc.) always reflecting
// the business's own timezone — regardless of the runtime's ambient system
// timezone. Use this anywhere "today"/"this week" is computed during render,
// instead of bare `new Date()`.
//
// Why this matters: dashboard/page.tsx is force-dynamic, so every load runs a
// fresh SSR pass (likely on a UTC server) followed by client hydration
// (in the browser's local timezone). If "today" is computed via ambient
// `new Date()` on both sides, they disagree for several hours every evening
// Eastern Time (the server's calendar date has already advanced past
// midnight UTC while the client's hasn't) — producing different rendered
// output (which day is highlighted as "today", which week is shown, which
// date range defaults) and triggering a React hydration-mismatch error
// (minified error #418). Anchoring both sides to the same explicit business
// timezone makes the computation identical no matter which system timezone
// actually ran it.
export function nowInBusinessTz(): Date {
  const dt = DateTime.now().setZone(BUSINESS_TZ);
  return new Date(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond);
}
