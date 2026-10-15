import type { TFunction } from 'i18next';
import { MtnConfig } from '@mention/shared-types/mtn/config';
import { getTrendBadge } from '@/components/trending/trendBadge';

// Echo the default so the assertions read as the text a reader sees.
const t = ((_key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? '') as unknown as TFunction;

const now = Date.parse('2026-10-15T10:00:00Z');
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
const newWindowMinutes = MtnConfig.trending.detection.newTrendMaxAgeMs / MINUTE;

describe('getTrendBadge', () => {
  it('calls a term that first trended inside the window new', () => {
    expect(getTrendBadge({ startedAt: ago(30), firstSeenAt: ago(30) }, t, now)).toEqual({
      text: 'New',
      tone: 'new',
    });
  });

  // The defect: `us` trended all week, fell off the five-slot list for a few
  // hours and came back. Its run restarted; it is not a new trend.
  it('gives a returning trend no badge while its new run is young', () => {
    expect(getTrendBadge({ startedAt: ago(30), firstSeenAt: ago(3 * 24 * 60) }, t, now)).toBeNull();
  });

  it("shows a returning trend's run age once the run is past the new window", () => {
    expect(
      getTrendBadge(
        { startedAt: ago(newWindowMinutes + 60), firstSeenAt: ago(3 * 24 * 60) },
        t,
        now,
      ),
    ).toEqual({ text: '3h', tone: 'age' });
  });

  it('falls back to the run onset for a row written before firstSeenAt', () => {
    expect(getTrendBadge({ startedAt: ago(30) }, t, now)?.tone).toBe('new');
  });

  it('lets hot outrank new', () => {
    expect(
      getTrendBadge({ status: 'hot', startedAt: ago(30), firstSeenAt: ago(30) }, t, now)?.tone,
    ).toBe('hot');
  });

  it('shows nothing without an onset', () => {
    expect(getTrendBadge({ firstSeenAt: ago(30) }, t, now)).toBeNull();
  });
});
