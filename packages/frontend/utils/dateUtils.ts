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

/**
 * Compact relative time: "now", "5m", "2h", "3d", "1w", "2mo", "1y"
 * Accepts either a millisecond timestamp (number) or an ISO date string.
 */
export function formatRelativeTimeCompact(input: string | number): string {
  const ts = typeof input === 'number' ? input : Date.parse(String(input));
  if (Number.isNaN(ts)) return 'now';
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
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
