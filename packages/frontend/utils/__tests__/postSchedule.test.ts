import type { HydratedPost } from '@mention/shared-types';
import { isPastDue, scheduledDate } from '@/utils/postSchedule';

/**
 * The publish time reaches the composer only through the hydrated DTO's
 * `metadata.scheduledFor`, so these two answers decide what every scheduled-post
 * surface says: the row's time label, the preview's header, and — the one that
 * matters — whether the cancel dialog claims the post was never published.
 */

function post(scheduledFor?: string): HydratedPost {
  return {
    id: 'post-1',
    metadata: {
      visibility: 'public',
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
      status: 'scheduled',
      scheduledFor,
    },
  } as HydratedPost;
}

const DUE_AT = '2026-08-02T09:30:00.000Z';
const DUE_MS = new Date(DUE_AT).getTime();

describe('scheduledDate', () => {
  it('reads the publish time hydration emits', () => {
    expect(scheduledDate(post(DUE_AT))).toEqual(new Date(DUE_AT));
  });

  it('answers null for a missing or unparseable time rather than an Invalid Date', () => {
    expect(scheduledDate(post())).toBeNull();
    expect(scheduledDate(post('not-a-date'))).toBeNull();
  });

  it('answers null for a post with no metadata at all', () => {
    expect(scheduledDate({ id: 'post-1' } as HydratedPost)).toBeNull();
  });
});

describe('isPastDue', () => {
  it('is false while the time is still ahead', () => {
    expect(isPastDue(post(DUE_AT), DUE_MS - 1)).toBe(false);
  });

  it('is true from the instant it is due, because the 60s sweep may already have run', () => {
    expect(isPastDue(post(DUE_AT), DUE_MS)).toBe(true);
    expect(isPastDue(post(DUE_AT), DUE_MS + 60_000)).toBe(true);
  });

  it('is false when there is no time to be past — an unknown time is not "publishing"', () => {
    expect(isPastDue(post(), DUE_MS + 60_000)).toBe(false);
    expect(isPastDue(post('not-a-date'), DUE_MS + 60_000)).toBe(false);
  });
});
