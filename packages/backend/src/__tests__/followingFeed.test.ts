import { describe, it, expect, beforeEach, vi } from 'vitest';

const capturedFindQueries: Array<Record<string, unknown>> = [];
const hydrateSlicesMock = vi.fn();
const sliceFeedMock = vi.fn();

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((query: Record<string, unknown>) => {
      capturedFindQueries.push(query);
      return {
        select: () => ({
          sort: () => ({
            limit: () => ({
              maxTimeMS: () => ({
                lean: () => Promise.resolve([]),
              }),
            }),
          }),
        }),
      };
    }),
  },
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: () => hydrateSlicesMock(),
  },
}));

vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: { sliceFeed: (...args: unknown[]) => sliceFeedMock(...args) },
}));

import { FollowingFeed } from '../mtn/feed/feeds/FollowingFeed';

beforeEach(() => {
  capturedFindQueries.length = 0;
  vi.clearAllMocks();
  sliceFeedMock.mockResolvedValue({ slices: [] });
  hydrateSlicesMock.mockResolvedValue([]);
});

describe('FollowingFeed visibility authorization', () => {
  it('keeps subscribed-list authors public-only instead of granting followers-only access', async () => {
    const feed = new FollowingFeed();

    await feed.fetch(
      { cursor: undefined, limit: 20 },
      {
        currentUserId: 'viewer',
        followingIds: ['real-follow'],
        subscribedListMemberIds: ['list-only'],
      },
    );

    expect(capturedFindQueries).toHaveLength(1);
    expect(capturedFindQueries[0]).toMatchObject({
      status: 'published',
      $and: [
        {
          $or: [
            {
              oxyUserId: { $in: ['viewer', 'real-follow'] },
              visibility: { $in: ['public', 'followers_only'] },
            },
            {
              oxyUserId: { $in: ['list-only'] },
              visibility: 'public',
            },
          ],
        },
      ],
    });
  });

  it('does not duplicate real follows in the public-only subscribed-list branch', async () => {
    const feed = new FollowingFeed();

    await feed.fetch(
      { cursor: undefined, limit: 20 },
      {
        currentUserId: 'viewer',
        followingIds: ['real-follow'],
        subscribedListMemberIds: ['viewer', 'real-follow', 'list-only'],
      },
    );

    expect(capturedFindQueries[0]).toMatchObject({
      $and: [
        {
          $or: [
            {
              oxyUserId: { $in: ['viewer', 'real-follow'] },
              visibility: { $in: ['public', 'followers_only'] },
            },
            {
              oxyUserId: { $in: ['list-only'] },
              visibility: 'public',
            },
          ],
        },
      ],
    });
  });
});
