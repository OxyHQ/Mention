import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HydratedPost, SlicedFeedResponse } from '@mention/shared-types';
const { records, hydrate, authorize } = vi.hoisted(() => ({
  records: vi.fn(),
  hydrate: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock('../../db/posts/postRepository', () => ({ loadPostRecords: records }));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: hydrate, authorizeAnonymousRecords: authorize },
}));
import { UNRATED_MATERIAL_ITEM } from '../../services/contentAccessBatcher';
import { postRevision } from '../../services/hydrationRevisions';
import { revalidateAnonymousFeed } from '../../services/revalidateAnonymousFeed';
// Cache fixtures only need the fields exercised by the cache boundary. The real
// hydrator owns the full DTO and is covered by its database-backed suites.
const cached = (id: string, text: string): HydratedPost =>
  ({ id, content: { text }, user: { id: `author-${id}` } }) as HydratedPost;
const row = (id: string, text: string) => ({ id, content: { text }, stats: { likes: 1 } });
const allow = (...ids: string[]) =>
  new Map(
    [...ids, UNRATED_MATERIAL_ITEM.resourceId].map((id) => [
      id,
      { allowed: true, reason: 'allowed', policyVersion: '2' },
    ]),
  );
beforeEach(() => {
  vi.clearAllMocks();
});
describe('anonymous feed cache authorization boundary', () => {
  it('serves an unchanged page after current authorization without hydrating it again', async () => {
    const page = { items: [cached('one', 'Body')], totalCount: 1, hasMore: false };
    records.mockResolvedValue([{ ...row('one', 'Body'), stats: { likes: 9 } }]);
    authorize.mockResolvedValue(allow('one'));
    const result = await revalidateAnonymousFeed({
      page,
      // Built from a ranked candidate: the engine's scores are not part of the post.
      revisions: {
        one: postRevision({ ...row('one', 'Body'), finalScore: 3, engagementScore: 7 }),
      },
      unratedMaterialAllowed: true,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(hydrate).not.toHaveBeenCalled();
    expect(result).toBe(page);
  });
  it('replaces stale bodies and removes revoked posts and their slice reasons', async () => {
    const hidden = cached('hidden', 'Formerly public private content');
    const old = cached('visible', 'Old body');
    const current = cached('visible', 'Current body');
    records.mockResolvedValue([row('hidden', 'x'), row('visible', 'Current body')]);
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
    const result = await revalidateAnonymousFeed(
      {
        page,
        revisions: {
          hidden: postRevision(row('hidden', 'x')),
          visible: postRevision(row('visible', 'Old body')),
        },
        unratedMaterialAllowed: true,
      },
      ['es'],
    );
    expect(records).toHaveBeenCalledWith(['hidden', 'visible']);
    expect(hydrate).toHaveBeenCalledWith([row('hidden', 'x'), row('visible', 'Current body')], {
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
    records.mockResolvedValue([row('one', 'Cached body')]);
    authorize.mockRejectedValue(new Error('Policy service unavailable'));
    await expect(
      revalidateAnonymousFeed({
        page: { items: [cached('one', 'Cached body')], totalCount: 1, hasMore: false },
        revisions: { one: postRevision(row('one', 'Cached body')) },
        unratedMaterialAllowed: true,
      }),
    ).rejects.toThrow('Policy service unavailable');
  });
});
