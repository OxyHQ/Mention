/**
 * Date utility functions for scheduling and formatting
 */

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000);

export const formatDateInput = (date: Date) => date.toISOString().slice(0, 10);

export const formatTimeInput = (date: Date) => date.toTimeString().slice(0, 5);

export const formatScheduledLabel = (date: Date): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toLocaleString();
  }
};

type DateDiff = {
  value: number;
  unit: 'now' | 'second' | 'minute' | 'hour' | 'day' | 'month';
  earlier: Date;
  later: Date;
};

const NOW = 5;
const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;
const MONTH_30 = DAY * 30;

/**
 * Returns the difference between `earlier` and `later` dates, based on
 * opinionated rules (faithful port of Bluesky's `dateDiff`).
 *
 * - All months are considered exactly 30 days.
 * - Dates assume `earlier` <= `later`, and will otherwise return 'now'.
 * - All values round down (or up when `rounding === 'up'`).
 */
export function dateDiff(
  earlier: number | string | Date,
  later: number | string | Date,
  rounding: 'up' | 'down' = 'down',
): DateDiff {
  let diff = {
    value: 0,
    unit: 'now' as DateDiff['unit'],
  };
  const e = new Date(earlier);
  const l = new Date(later);
  const diffSeconds = Math.floor((l.getTime() - e.getTime()) / 1000);

  if (diffSeconds < NOW) {
    diff = {
      value: 0,
      unit: 'now',
    };
  } else if (diffSeconds < MINUTE) {
    diff = {
      value: diffSeconds,
      unit: 'second',
    };
  } else if (diffSeconds < HOUR) {
    const value =
      rounding === 'up'
        ? Math.ceil(diffSeconds / MINUTE)
        : Math.floor(diffSeconds / MINUTE);
    diff = {
      value,
      unit: 'minute',
    };
  } else if (diffSeconds < DAY) {
    const value =
      rounding === 'up'
        ? Math.ceil(diffSeconds / HOUR)
        : Math.floor(diffSeconds / HOUR);
    diff = {
      value,
      unit: 'hour',
    };
  } else if (diffSeconds < MONTH_30) {
    const value =
      rounding === 'up'
        ? Math.ceil(diffSeconds / DAY)
        : Math.floor(diffSeconds / DAY);
    diff = {
      value,
      unit: 'day',
    };
  } else {
    const value =
      rounding === 'up'
        ? Math.ceil(diffSeconds / MONTH_30)
        : Math.floor(diffSeconds / MONTH_30);
    diff = {
      value,
      unit: 'month',
    };
  }

  return {
    ...diff,
    earlier: e,
    later: l,
  };
}

/**
 * Accepts a `DateDiff` and returns the difference between `earlier` and
 * `later` dates, formatted as a natural language string (faithful port of
 * Bluesky's `formatDateDiff`).
 *
 * - All months are considered exactly 30 days.
 * - Dates assume `earlier` <= `later`, and will otherwise return 'now'.
 * - Differences >= 12 months are returned as a localized absolute date.
 */
export function formatDateDiff({
  diff,
  format = 'short',
}: {
  diff: DateDiff;
  format?: 'short' | 'long';
}): string {
  const long = format === 'long';

  switch (diff.unit) {
    case 'now': {
      return 'now';
    }
    case 'second': {
      return long
        ? `${diff.value} ${diff.value === 1 ? 'second' : 'seconds'}`
        : `${diff.value}s`;
    }
    case 'minute': {
      return long
        ? `${diff.value} ${diff.value === 1 ? 'minute' : 'minutes'}`
        : `${diff.value}m`;
    }
    case 'hour': {
      return long
        ? `${diff.value} ${diff.value === 1 ? 'hour' : 'hours'}`
        : `${diff.value}h`;
    }
    case 'day': {
      return long
        ? `${diff.value} ${diff.value === 1 ? 'day' : 'days'}`
        : `${diff.value}d`;
    }
    case 'month': {
      if (diff.value < 12) {
        return long
          ? `${diff.value} ${diff.value === 1 ? 'month' : 'months'}`
          : `${diff.value}mo`;
      }
      return new Date(diff.earlier).toLocaleDateString();
    }
  }
}

/**
 * Compact relative time, faithful to Bluesky's `dateDiff`/`formatDateDiff`
 * algorithm: "now", "12s", "5m", "2h", "20d", "3mo", then an absolute
 * localized date (e.g. "6/11/2026") once 12 months have passed.
 *
 * Accepts a millisecond timestamp (number), an ISO date string, or a Date.
 * NaN-safe: an unparseable input returns 'now'.
 */
export function formatTimeAgo(
  input: number | string | Date,
  opts?: { format?: 'short' | 'long' },
): string {
  if (Number.isNaN(new Date(input).getTime())) return 'now';
  const diff = dateDiff(input, Date.now());
  return formatDateDiff({ diff, format: opts?.format });
}

/**
 * Full absolute timestamp for the focused post-detail view, e.g.
 * "9:20 PM · Jun 11, 2026". Returns '' for an unparseable date.
 */
export function formatFullTimestamp(input: string | number): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '';

  const hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, '0');

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const day = date.getDate();
  const year = date.getFullYear();

  return `${displayHours}:${displayMinutes} ${ampm} · ${month} ${day}, ${year}`;
}

/**
 * Localized relative time for notifications.
 * Uses i18n translation keys: notification.now, notification.minutes_ago,
 * notification.hours_ago, notification.days_ago. Falls back to toLocaleDateString for older dates.
 */
export function formatRelativeTimeLocalized(
  dateString: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const now = new Date();
  const date = new Date(dateString);
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (diffInSeconds < 60) return t('notification.now');
  if (diffInSeconds < 3600) return t('notification.minutes_ago', { count: Math.floor(diffInSeconds / 60) });
  if (diffInSeconds < 86400) return t('notification.hours_ago', { count: Math.floor(diffInSeconds / 3600) });
  if (diffInSeconds < 604800) return t('notification.days_ago', { count: Math.floor(diffInSeconds / 86400) });
  return date.toLocaleDateString();
}
