import type { TFunction } from 'i18next';
import { NEW_TREND_MAX_AGE_MS } from '@mention/shared-types/trending';
import type { Trend } from '@/interfaces/Trend';

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_PER_DAY = 24;

export interface TrendBadge {
  text: string;
  tone: 'hot' | 'new' | 'age';
}

/**
 * The badge beside the label: `hot`, `new`, or how long this run has lasted.
 *
 * `hot` outranks everything: it is the stronger claim and the others would
 * compete for the same corner. `new` is measured from `firstSeenAt` — the
 * first time the term trended this week — and NOT from the run's `startedAt`:
 * on a short list a perennial term drops out and returns several times a day,
 * and each return restarts the run without making the trend any newer. Such a
 * returning trend gets no badge until its run is past the `new` window, then its
 * run's age. A row without `firstSeenAt` (written before the field) falls back
 * to the run onset, and one with no `startedAt` at all gets NO badge rather than
 * a guessed one.
 */
export function getTrendBadge(
  trend: Pick<Trend, 'status' | 'startedAt' | 'firstSeenAt'>,
  t: TFunction,
  now: number = Date.now(),
): TrendBadge | null {
  if (trend.status === 'hot') {
    return { text: t('trend.badge.hot', { defaultValue: 'Hot' }), tone: 'hot' };
  }
  if (!trend.startedAt) return null;

  const startedAt = Date.parse(trend.startedAt);
  if (Number.isNaN(startedAt)) return null;

  const ageMs = now - startedAt;
  if (ageMs < 0) return null;

  if (ageMs < NEW_TREND_MAX_AGE_MS) {
    const firstSeenAt = trend.firstSeenAt ? Date.parse(trend.firstSeenAt) : startedAt;
    const isNew = !Number.isNaN(firstSeenAt) && now - firstSeenAt < NEW_TREND_MAX_AGE_MS;
    return isNew ? { text: t('trend.badge.new', { defaultValue: 'New' }), tone: 'new' } : null;
  }

  const hours = Math.floor(ageMs / MS_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return {
      text: t('trend.badge.hoursAgo', { count: hours, defaultValue: `${hours}h` }),
      tone: 'age',
    };
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  return { text: t('trend.badge.daysAgo', { count: days, defaultValue: `${days}d` }), tone: 'age' };
}
