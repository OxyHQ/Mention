import type { Experience } from '@clarity.surf/sdk/experience';

export function monthIndex(month: string): number {
  const [year, value] = month.split('-').map(Number);
  return year * 12 + value - 1;
}

/** Calendar months are inclusive, matching the date range shown to the reader. */
export function experienceMonths(start: string, end: string | null, now = new Date()): number {
  const current = now.toISOString().slice(0, 7);
  const effectiveEnd = end && end < current ? end : current;
  return Math.max(1, monthIndex(effectiveEnd) - monthIndex(start) + 1);
}

export function experienceMonthLabel(month: string, locale: string): string {
  const [year, value] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, value - 1, 1)));
}

export interface ExperienceGroup {
  key: string;
  employerOxyAccountId: string;
  entries: Experience[];
  startDate: string;
  endDate: string | null;
}

/** Adjacent roles form a tenure; returning after another employer starts a new row. */
export function groupExperience(entries: readonly Experience[]): ExperienceGroup[] {
  const ordered = [...entries].sort(
    (a, b) =>
      Number(b.endDate === null) - Number(a.endDate === null) ||
      (b.endDate ?? '').localeCompare(a.endDate ?? '') ||
      b.startDate.localeCompare(a.startDate) ||
      a.id.localeCompare(b.id),
  );
  const groups: ExperienceGroup[] = [];
  for (const entry of ordered) {
    const previous = groups.at(-1);
    const continuous =
      entry.endDate === null ||
      monthIndex(entry.endDate) + 1 >= monthIndex(previous?.startDate ?? entry.startDate);
    if (previous && previous.employerOxyAccountId === entry.employerOxyAccountId && continuous) {
      previous.entries.push(entry);
      previous.startDate =
        previous.startDate < entry.startDate ? previous.startDate : entry.startDate;
      previous.endDate =
        previous.endDate === null || entry.endDate === null
          ? null
          : previous.endDate > entry.endDate
            ? previous.endDate
            : entry.endDate;
    } else {
      groups.push({
        key: entry.id,
        employerOxyAccountId: entry.employerOxyAccountId,
        entries: [entry],
        startDate: entry.startDate,
        endDate: entry.endDate,
      });
    }
  }
  return groups;
}
