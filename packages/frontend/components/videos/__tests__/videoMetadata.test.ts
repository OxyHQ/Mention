import { videoPublicationDate, videoTitleText, videoViewCount } from '../videoMetadata';
import type { TFunction } from 'i18next';

it('uses the same readable mention label as the post body in video titles', () => {
  expect(videoTitleText('  Gov. [@Gavin Newsom](gavinnewsom@bsky.social): Watch this.  ')).toBe(
    'Gov. Gavin Newsom: Watch this.',
  );
  expect(videoTitleText('From [@@alice@example.social](https://example.social/@alice)')).toBe(
    'From @alice@example.social',
  );
  expect(videoTitleText('Literal [caption] and @plain')).toBe('Literal [caption] and @plain');
  expect(videoTitleText()).toBe('');
});

it('shows relative publication times for recent videos and an absolute date for older ones', () => {
  jest.useFakeTimers({ now: new Date('2025-02-04T12:00:00Z') });
  try {
    expect(videoPublicationDate('bad timestamp', 'en')).toEqual({ relative: '', absolute: '' });
    expect(videoPublicationDate('2025-02-04T12:00:00Z', 'en').relative).toBe('now');
    expect(videoPublicationDate('2025-01-04T12:00:00Z', 'en').relative).toBe('1 month ago');
    expect(videoPublicationDate('2024-01-04T12:00:00Z', 'en')).toEqual({
      relative: 'January 4, 2024',
      absolute: 'January 4, 2024',
    });
  } finally {
    jest.useRealTimers();
  }
});

it('provides localized counts only when the video has a view count', () => {
  const translate = jest.fn(
    (_: string, options: { formattedCount: string }) => options.formattedCount,
  );
  const t = translate as unknown as TFunction;
  expect(videoViewCount(t, 'en', undefined)).toBe('');
  expect(translate).not.toHaveBeenCalled();
  expect(videoViewCount(t, 'en', 0)).toBe('0');
  expect(videoViewCount(t, 'en', 1240)).toBe('1,240');
  expect(videoViewCount(t, 'en', 1240, true)).toBe('1.2K');
  expect(translate).toHaveBeenLastCalledWith(
    'videos.viewCount',
    expect.objectContaining({ count: 1240 }),
  );
});
