/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest
 * (workspace runner). Both provide the same describe/it/expect globals.
 *
 * Every relative case pins its own `later` (or fakes the clock), so which
 * branch runs never depends on the day the suite runs. Coverage of this file
 * used to come only from other suites' fixtures, and drifted as those
 * fixtures aged into different units.
 */

import { dateDiff, formatDateDiff, formatFullTimestamp, formatRelativeTimeLocalized, formatTimeAgo } from '../dateUtils';

const LATER = new Date('2026-06-11T21:20:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function before(ms: number): Date {
  return new Date(LATER.getTime() - ms);
}

describe('dateDiff', () => {
  it.each([
    [2 * SECOND, 'now', 0],
    [30 * SECOND, 'second', 30],
    [90 * SECOND, 'minute', 1],
    [5 * HOUR + 10 * MINUTE, 'hour', 5],
    [3 * DAY + HOUR, 'day', 3],
    [65 * DAY, 'month', 2],
  ])('%dms back is %s %d', (ms, unit, value) => {
    expect(dateDiff(before(ms), LATER)).toMatchObject({ unit, value });
  });

  it('rounds up when asked', () => {
    expect(dateDiff(before(90 * SECOND), LATER, 'up')).toMatchObject({ unit: 'minute', value: 2 });
    expect(dateDiff(before(5 * HOUR + MINUTE), LATER, 'up')).toMatchObject({ unit: 'hour', value: 6 });
    expect(dateDiff(before(3 * DAY + HOUR), LATER, 'up')).toMatchObject({ unit: 'day', value: 4 });
    expect(dateDiff(before(65 * DAY), LATER, 'up')).toMatchObject({ unit: 'month', value: 3 });
  });

  it('treats a later "earlier" as now', () => {
    expect(dateDiff(LATER.getTime() + HOUR, LATER).unit).toBe('now');
  });
});

describe('formatDateDiff', () => {
  const format = (ms: number, style: 'short' | 'long' = 'short') =>
    formatDateDiff({ diff: dateDiff(before(ms), LATER), format: style });

  it('formats each unit short', () => {
    expect(format(SECOND)).toBe('now');
    expect(format(12 * SECOND)).toBe('12s');
    expect(format(5 * MINUTE)).toBe('5m');
    expect(format(2 * HOUR)).toBe('2h');
    expect(format(20 * DAY)).toBe('20d');
    expect(format(90 * DAY)).toBe('3mo');
  });

  it('formats each unit long, singular and plural', () => {
    expect(format(SECOND * 12, 'long')).toBe('12 seconds');
    expect(format(MINUTE, 'long')).toBe('1 minute');
    expect(format(5 * MINUTE, 'long')).toBe('5 minutes');
    expect(format(HOUR, 'long')).toBe('1 hour');
    expect(format(2 * HOUR, 'long')).toBe('2 hours');
    expect(format(DAY, 'long')).toBe('1 day');
    expect(format(20 * DAY, 'long')).toBe('20 days');
    expect(format(30 * DAY, 'long')).toBe('1 month');
    expect(format(90 * DAY, 'long')).toBe('3 months');
  });

  it('falls back to an absolute date at 12 months', () => {
    const earlier = before(400 * DAY);
    expect(format(400 * DAY)).toBe(earlier.toLocaleDateString());
  });
});

describe('formatTimeAgo', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(LATER);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('measures against the current time', () => {
    expect(formatTimeAgo(before(2 * HOUR).toISOString())).toBe('2h');
    expect(formatTimeAgo(before(2 * HOUR).getTime(), { format: 'long' })).toBe('2 hours');
  });

  it('reads an unparseable input as now', () => {
    expect(formatTimeAgo('not a date')).toBe('now');
  });
});

describe('formatFullTimestamp', () => {
  it('formats an afternoon time with the date', () => {
    const date = new Date(2026, 5, 11, 21, 5);
    expect(formatFullTimestamp(date.getTime())).toBe('9:05 PM · Jun 11, 2026');
  });

  it('writes midnight as 12 AM', () => {
    expect(formatFullTimestamp(new Date(2026, 0, 2, 0, 30).getTime())).toBe('12:30 AM · Jan 2, 2026');
  });

  it('returns an empty string for an unparseable date', () => {
    expect(formatFullTimestamp('not a date')).toBe('');
  });
});

describe('formatRelativeTimeLocalized', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${String(options.count)}` : key;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(LATER);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    [10 * SECOND, 'notification.now'],
    [5 * MINUTE, 'notification.minutes_ago:5'],
    [3 * HOUR, 'notification.hours_ago:3'],
    [2 * DAY, 'notification.days_ago:2'],
  ])('%dms back reads %s', (ms, expected) => {
    expect(formatRelativeTimeLocalized(before(ms).toISOString(), t)).toBe(expected);
  });

  it('falls back to an absolute date after a week', () => {
    const earlier = before(10 * DAY);
    expect(formatRelativeTimeLocalized(earlier.toISOString(), t)).toBe(earlier.toLocaleDateString());
  });
});
