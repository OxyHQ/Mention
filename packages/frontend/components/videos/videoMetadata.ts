import type { TFunction } from 'i18next';
import { dateDiff } from '@/utils/dateUtils';

export function videoPublicationDate(createdAt: string, locale: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return { relative: '', absolute: '' };
  const { unit, value } = dateDiff(date, Date.now());
  const absolute = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date);
  const relative =
    unit === 'month' && value >= 12
      ? absolute
      : new Intl.RelativeTimeFormat(locale, { numeric: unit === 'now' ? 'auto' : 'always' }).format(
          value === 0 ? 0 : -value,
          unit === 'now' ? 'second' : unit,
        );
  return { relative, absolute };
}

export function videoViewCount(
  t: TFunction,
  locale: string,
  count: number | null | undefined,
  compact = false,
) {
  if (count == null) return '';
  const formattedCount = new Intl.NumberFormat(
    locale,
    compact ? { notation: 'compact' } : undefined,
  ).format(count);
  return t('videos.viewCount', {
    count,
    formattedCount,
    defaultValue_one: '{{formattedCount}} view',
    defaultValue_other: '{{formattedCount}} views',
  });
}
