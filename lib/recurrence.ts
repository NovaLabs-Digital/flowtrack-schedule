export const MAX_HORIZON_DAYS = 182;

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isWeekday(d: Date): boolean {
  const day = d.getDay();
  return day !== 0 && day !== 6;
}

export function generateFutureDates(
  startDate: Date,
  frequencyType: string,
  repeatWeeks: number,
): Date[] {
  const dates: Date[] = [];

  if (frequencyType === "daily") {
    for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
      dates.push(addDays(startDate, d));
    }
  } else if (frequencyType === "weekdays") {
    for (let d = 1; d <= MAX_HORIZON_DAYS; d++) {
      const candidate = addDays(startDate, d);
      if (isWeekday(candidate)) {
        dates.push(candidate);
      }
    }
  } else if (frequencyType === "weekly" && repeatWeeks >= 1) {
    const intervalDays = repeatWeeks * 7;
    for (let d = intervalDays; d <= MAX_HORIZON_DAYS; d += intervalDays) {
      dates.push(addDays(startDate, d));
    }
  }

  return dates;
}

export function countFutureOccurrences(frequencyType: string, repeatWeeks: number, startDate?: Date): number {
  if (frequencyType === "one_time" || !frequencyType) return 0;
  return generateFutureDates(startDate ?? new Date(), frequencyType, repeatWeeks).length;
}
