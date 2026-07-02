import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The `following` source (timeline variant) must reproduce the Following feed's
 * visibility authorization: followed authors + the viewer may show public /
 * followers-only; subscribed-list-only authors show public ONLY (list
 * subscription is feed-inclusion, never a follow relationship).
 */

const capturedFindQueries: Array<Record<string, unknown>> = [];

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((query: Record<string, unknown>) => {
      capturedFindQueries.push(query);
      return {
        select: () => ({
          sort: () => ({
            limit: () => ({ maxTimeMS: () => ({ lean: () => Promise.resolve([]) }) }),
          }),
        }),
      };
    }),
  },
}));

import { followingSource } from '../mtn/feed/engine/sources/forYouSources';
import type { FeedEngineContext } from '../mtn/feed/engine/types';

beforeEach(() => {
  capturedFindQueries.length = 0;
  vi.clearAllMocks();
});

describe('following source (timeline) visibility authorization', () => {
  it('keeps subscribed-list authors public-only instead of granting followers-only access', async () => {
    const ctx: FeedEngineContext = {
      currentUserId: 'viewer',
      followingIds: ['real-follow'],
      subscribedListMemberIds: ['list-only'],
    };
    await followingSource.gather(ctx, { timeline: true }, 31);

    expect(capturedFindQueries).toHaveLength(1);
    expect(capturedFindQueries[0]).toMatchObject({
      status: 'published',
      $and: [
        {
          $or: [
            { oxyUserId: { $in: ['viewer', 'real-follow'] }, visibility: { $in: ['public', 'followers_only'] } },
            { oxyUserId: { $in: ['list-only'] }, visibility: 'public' },
          ],
        },
      ],
    });
  });

  it('does not duplicate real follows in the public-only subscribed-list branch', async () => {
    const ctx: FeedEngineContext = {
      currentUserId: 'viewer',
      followingIds: ['real-follow'],
      subscribedListMemberIds: ['viewer', 'real-follow', 'list-only'],
    };
    await followingSource.gather(ctx, { timeline: true }, 31);

    expect(capturedFindQueries[0]).toMatchObject({
      $and: [
        {
          $or: [
            { oxyUserId: { $in: ['viewer', 'real-follow'] }, visibility: { $in: ['public', 'followers_only'] } },
            { oxyUserId: { $in: ['list-only'] }, visibility: 'public' },
          ],
        },
      ],
    });
  });
});
