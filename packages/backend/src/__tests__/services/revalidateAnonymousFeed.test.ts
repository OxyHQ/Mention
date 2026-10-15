import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
const { records, hydrate } = vi.hoisted(() => ({ records: vi.fn(), hydrate: vi.fn() }));
vi.mock('../../db/posts/postRepository', () => ({ loadPostRecords: records }));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hydrate },
}));
import { revalidateAnonymousFeed } from '../../services/revalidateAnonymousFeed';
// Cache fixtures only need the fields exercised by the cache boundary. The real
// hydrator owns the full DTO and is covered by its database-backed suites.
const cached = (id: string, text: string): HydratedPost =>
  ({ id, content: { text }, user: { id: `author-${id}` } }) as HydratedPost;
beforeEach(() => {
  vi.clearAllMocks();
  records.mockResolvedValue([{ id: 'current-row' }]);
});
describe('anonymous feed cache authorization boundary', () => {
  it('replaces stale bodies and removes revoked posts and their slice reasons', async () => {
    const hidden = cached('hidden', 'Formerly public private content');
    const old = cached('visible', 'Old body');
    const current = cached('visible', 'Current body');
    hydrate.mockResolvedValue([current]);
    const page: SlicedFeedResponse = {
      items: [hidden, old],
      totalCount: 2,
      hasMore: true,
      nextCursor: 'ranking-cursor',
      slices: [
        {
          _sliceKey: 'thread',
          isIncompleteThread: false,
          reason: { type: 'boost', actor: hidden.user },
          items: [hidden, old].map((post) => ({
            post,
            isThreadParent: false,
            isThreadChild: false,
            isThreadLastChild: false,
          })),
        },
      ],
    };
    const result = await revalidateAnonymousFeed(page, ['es']);
    expect(records).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledWith(['hidden', 'visible']);
    expect(hydrate).toHaveBeenCalledWith([{ id: 'current-row' }], {
      safetyRequester: { accessToken: null },
      maxDepth: 2,
      requestLanguages: ['es'],
    });
    expect(result.items).toEqual([current]);
    expect(result.slices[0].items.map((item) => item.post)).toEqual([current]);
    expect(result.slices[0].reason).toBeUndefined();
    expect(result.slices[0].isIncompleteThread).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Formerly public');
    expect(result.nextCursor).toBe('ranking-cursor');
  });
  it('does not return the cached payload when live authorization fails', async () => {
    hydrate.mockRejectedValue(new Error('Policy service unavailable'));
    await expect(
      revalidateAnonymousFeed({
        items: [cached('one', 'Cached body')],
        totalCount: 1,
        hasMore: false,
      }),
    ).rejects.toThrow('Policy service unavailable');
  });
});
