// Pure calendar-navigation math for pointing the desktop dashboard's
// calendar at a specific appointment's date -- e.g. selecting an
// appointment from Needs Attention whose date isn't inside the currently
// displayed week/month. Before this existed, selecting an appointment only
// updated selectedApptId/selectedClientId (DashboardShell.tsx's
// selectAppointment); the detail panels below the grid always resolve from
// the full, un-filtered appointments array so they showed correctly, but
// the grid itself kept showing whatever week/month it already happened to
// be on, silently hiding the very appointment just selected if it fell
// outside that window.
//
// Reuses the EXACT week-boundary arithmetic app/components/dashboard/
// ScheduleGrid.tsx's own (private) startOfWeek/viewDays already use for
// Prev/Next/Today -- duplicated here rather than imported from that .tsx
// file (which can't be loaded by this repo's plain-Node test runner, see
// ScheduleGrid.test.ts's own header) so this module stays executable and
// directly unit-testable, matching lib/monthGrid.ts's identical rationale
// for not living inside ScheduleMonthGrid.tsx. If ScheduleGrid.tsx's own
// startOfWeek/viewDays ever change their week-start convention, this must
// change identically or the two will disagree about which week a date
// belongs to.
import type { ViewMode } from "@/app/components/dashboard/types";
import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

// Monday-start week boundary -- identical formula to ScheduleGrid.tsx's
// startOfWeek.
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6; // Sunday, Saturday
}

export type CalendarNavigationTarget = {
  viewMode: ViewMode;
  weekOffset: number;
  monthOffset: number;
};

// Resolves where the calendar must point (view + offset) to show
// `targetIso`'s date in the workspace's own business timezone, preferring
// to KEEP the caller's current view whenever that view is actually capable
// of showing the date:
//
//   - "month": can show any date -- only monthOffset changes, view kept.
//   - "week" (full Mon-Sun): can show any date -- only weekOffset changes,
//     view kept.
//   - "weekdays" (Mon-Fri only): kept for a weekday target. A WEEKEND
//     target cannot be shown in this view at all (ScheduleGrid.tsx's
//     viewDays only ever returns Mon-Fri for "weekdays"), so it is
//     upgraded to "week" -- the narrowest view that can still show it.
//   - "day": ScheduleGrid.tsx's viewDays steps "day" view by WHOLE WEEKS
//     (weekOffset * 7 days from today), so it only ever shows the same
//     weekday-of-week as "today" -- it cannot target an arbitrary date in
//     the general case, so it always switches away: "weekdays" for a
//     weekday target, "week" for a weekend target (the same rule as
//     above).
//
// weekOffset/monthOffset are both always computed, regardless of which one
// the resolved view actually uses -- matching DashboardShell.tsx's own
// handleGoToday, which resets both unconditionally rather than branching on
// viewMode ("harmless no-op outside Month view").
export function resolveCalendarNavigation(targetIso: string, currentViewMode: ViewMode, timezone: string): CalendarNavigationTarget {
  const now = nowInBusinessTz(timezone);
  const target = toBusinessLocal(targetIso, timezone);

  const weekOffset = Math.round((startOfWeek(target).getTime() - startOfWeek(now).getTime()) / MS_PER_WEEK);
  const monthOffset = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());

  let viewMode: ViewMode = currentViewMode;
  if (currentViewMode === "day") {
    viewMode = isWeekend(target) ? "week" : "weekdays";
  } else if (currentViewMode === "weekdays" && isWeekend(target)) {
    viewMode = "week";
  }

  return { viewMode, weekOffset, monthOffset };
}
