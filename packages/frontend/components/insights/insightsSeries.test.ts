import {
  buildInsightsSeries,
  buildWeekdayInteractions,
  buildPublishingSummary,
} from './insightsSeries';
import type { AccountInsights } from '@/services/insightsService';

function stats(
  start: string,
  end: string,
  days: number,
  rows: [string, number][],
): AccountInsights {
  return {
    period: { startDate: start, endDate: end, days },
    overview: {
      totalPosts: 0,
      totalViews: 0,
      totalInteractions: 0,
      engagementRate: 0,
      averageEngagementPerPost: 0,
    },
    interactions: { likes: 0, replies: 0, boosts: 0, shares: 0 },
    dailyBreakdown: rows.map(([date, views]) => ({
      date,
      views,
      likes: 0,
      replies: 0,
      boosts: 0,
      interactions: 0,
    })),
    topPosts: [],
    postsByType: {},
  };
}

describe('publication-date chart series', () => {
  it('keeps both partial UTC boundary dates and fills dates without posts', () => {
    const points = buildInsightsSeries(
      stats('2026-10-11T23:30:00Z', '2026-10-18T23:30:00Z', 7, [
        ['2026-10-18', 20],
        ['2026-10-11', 3],
      ]),
      'en',
    );
    expect(points).toHaveLength(8);
    expect(points.map((p) => p.value)).toEqual([3, 0, 0, 0, 0, 0, 0, 20]);
    expect(points[0].fullLabel).toContain('October 11');
    expect(points[7].fullLabel).toContain('October 18');
  });
  it('does not truncate 90 days to a week, including month and year boundaries', () => {
    const points = buildInsightsSeries(
      stats('2025-12-01T12:00:00Z', '2026-03-01T12:00:00Z', 90, [
        ['2025-12-01', 40],
        ['2026-03-01', 12],
      ]),
      'es',
    );
    expect(points).toHaveLength(91);
    expect(points.reduce((sum, point) => sum + point.value, 0)).toBe(52);
    expect(points[0].fullLabel).toContain('2025');
    expect(points[90].fullLabel).toContain('2026');
  });
  it('shows an empty cohort as zero, not invented activity', () => {
    expect(
      buildInsightsSeries(stats('2026-02-28', '2026-03-02', 2, []), 'en').map((p) => p.value),
    ).toEqual([0, 0, 0]);
  });
});

describe('interactions by publication weekday', () => {
  it('aggregates repeated weekdays and recovers shares without counting views', () => {
    const input = stats('2026-10-01', '2026-10-31', 30, []);
    input.dailyBreakdown = [
      { date: '2026-10-05', views: 1000, likes: 4, replies: 2, boosts: 1, interactions: 10 },
      { date: '2026-10-12', views: 9000, likes: 5, replies: 1, boosts: 2, interactions: 12 },
      { date: '2026-10-18', views: 2000, likes: 2, replies: 0, boosts: 0, interactions: 3 },
    ];
    const { columns, values } = buildWeekdayInteractions(input, 'en');
    expect(columns).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(values.likes).toEqual([9, 0, 0, 0, 0, 0, 2]);
    expect(values.shares).toEqual([7, 0, 0, 0, 0, 0, 1]);
    expect(
      Object.values(values)
        .flat()
        .reduce((total, value) => total + value, 0),
    ).toBe(25);
  });
});

describe('publishing frequency', () => {
  it.each([7, 30, 90])('retains the full grid and every date in a %i-day period', (days) => {
    const end = new Date('2026-10-18T12:00:00Z');
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);
    const summary = buildPublishingSummary(stats(start.toISOString(), end.toISOString(), days, []));
    expect(summary.cells).toHaveLength(259);
    expect(summary.cells.filter((cell) => cell.date)).toHaveLength(days + 1);
    expect(summary.cells.every((cell) => cell.count === 0)).toBe(true);
  });

  it('counts zero-view publishing days, preserves gaps and pads outside the window', () => {
    const input = stats('2026-10-01T23:00:00Z', '2026-10-08T23:00:00Z', 7, [
      ['2026-10-01', 0],
      ['2026-10-02', 10],
      ['2026-10-04', 0],
      ['2026-10-05', 0],
      ['2026-10-06', 20],
    ]);
    const summary = buildPublishingSummary(input);
    expect(summary.activeDays).toBe(5);
    expect(summary.weekdays).toEqual({ active: 4, total: 6 });
    expect(summary.weekends).toEqual({ active: 1, total: 2 });
    expect(summary.longestStreak).toBe(3);
    expect(summary.columns).toBe(37);
    expect(summary.cells).toHaveLength(259);
    expect(summary.cells[0].date).toBeUndefined();
    expect(summary.cells.find((cell) => cell.date === '2026-10-01')).toMatchObject({
      date: '2026-10-01',
      count: 1,
    });
    expect(summary.cells.find((cell) => cell.date === '2026-10-03')).toMatchObject({
      date: '2026-10-03',
      count: 0,
    });
    expect(summary.cells.at(-1)?.date).toBeUndefined();
  });
});
