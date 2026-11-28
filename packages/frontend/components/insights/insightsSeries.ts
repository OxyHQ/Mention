import type { AccountInsights } from '@/services/insightsService';

/** The API groups current post counters by publication date (UTC), not event date.
 * Include both boundary dates: a rolling seven-day window can span eight dates.
 * Missing buckets mean no publications, so their contribution is zero.
 */
export function buildInsightsSeries(stats: AccountInsights, locale: string) {
  const start = new Date(stats.period.startDate.slice(0, 10));
  const end = new Date(stats.period.endDate.slice(0, 10));
  const counts = new Map(stats.dailyBreakdown.map((day) => [day.date.slice(0, 10), day.views]));
  const short = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const full = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const points: { label: string; fullLabel: string; value: number }[] = [];
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    points.push({
      label: stats.period.days <= 7 ? String(date.getUTCDate()) : short.format(date),
      fullLabel: full.format(date),
      value: counts.get(date.toISOString().slice(0, 10)) ?? 0,
    });
  }
  return points;
}

/** Totals by UTC publication weekday; these are not event-time activity or
 * recommendations for when to post. Shares are included in interactions by
 * the API but omitted as a separate field from each daily row.
 */
export function buildWeekdayInteractions(stats: AccountInsights, locale: string) {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const columns = Array.from({ length: 7 }, (_, index) =>
    weekday.format(new Date(Date.UTC(2026, 0, 5 + index))),
  );
  const values = {
    likes: Array<number>(7).fill(0),
    replies: Array<number>(7).fill(0),
    boosts: Array<number>(7).fill(0),
    shares: Array<number>(7).fill(0),
  };
  for (const day of stats.dailyBreakdown) {
    const index = (new Date(day.date.slice(0, 10)).getUTCDay() + 6) % 7;
    values.likes[index] += day.likes;
    values.replies[index] += day.replies;
    values.boosts[index] += day.boosts;
    values.shares[index] += day.interactions - day.likes - day.replies - day.boosts;
  }
  return { columns, values };
}

/** Posting presence, not post count: the API emits one bucket for each date
 * with publications, including dates whose posts have no interactions yet.
 */
export function buildPublishingSummary(stats: AccountInsights) {
  const dates = new Set(stats.dailyBreakdown.map((day) => day.date.slice(0, 10)));
  const start = new Date(stats.period.startDate.slice(0, 10));
  const end = new Date(stats.period.endDate.slice(0, 10));
  // Keep Bloom’s complete 37-week grid, including empty cells outside the period.
  const columns = 37;
  const monday = new Date(end);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - (columns - 1) * 7);
  let streak = 0;
  let longestStreak = 0;
  let activeDays = 0;
  const weekdays = { active: 0, total: 0 };
  const weekends = { active: 0, total: 0 };
  const cells = Array.from({ length: columns * 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    if (date < start || date > end) return { count: 0, tier: 0 as const };
    const key = date.toISOString().slice(0, 10);
    const published = dates.has(key);
    const group = date.getUTCDay() === 0 || date.getUTCDay() === 6 ? weekends : weekdays;
    group.total++;
    if (published) group.active++;
    streak = published ? streak + 1 : 0;
    longestStreak = Math.max(longestStreak, streak);
    if (published) activeDays++;
    return { count: published ? 1 : 0, date: key, tier: published ? (5 as const) : (0 as const) };
  });
  return { activeDays, longestStreak, cells, columns, weekdays, weekends };
}
