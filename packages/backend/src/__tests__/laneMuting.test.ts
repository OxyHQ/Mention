import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * A reader's muted lanes, applied by the ENGINE.
 *
 * Two places, and the second is the one that gets forgotten: `gatherPool` covers
 * every definition, and `runPopularFallback` is the ONE path that never passes
 * through it — reached by `neverBlank` from an authenticated ranked feed, which
 * is precisely the reader who has mutes.
 *
 * It is not a `FilterModule` because a filter only runs if a definition LISTS it,
 * and `authorDefinition` declares `filters: []` — so a reader's mute would
 * silently not apply on the surface lanes are most visible. That claim is
 * asserted here directly.
 */

vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: {
    rankPosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const post of posts) post.finalScore = (post._testScore as number | undefined) ?? 0;
      return posts;
    }),
  },
}));

vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: {
    sliceFeed: vi.fn(async (posts: Array<Record<string, unknown>>) => ({
      slices: posts.map((post) => ({
        _sliceKey: String(post._id),
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: Array<{ items: Array<{ post: Record<string, unknown> }> }>) => {
      for (const slice of slices) for (const item of slice.items) item.post.id = String(item.post._id);
      return slices;
    }),
    hydratePosts: vi.fn(async (posts: Array<Record<string, unknown>>) => {
      for (const post of posts) post.id = String(post._id);
      return posts;
    }),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { authorDefinition } from '../mtn/feed/definitions/presets';
import type { CandidatePost, FeedDefinition, SourceModule } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);
const MUTED_LANE = 'lane-muted';
const OTHER_LANE = 'lane-other';

function makePost(n: number, extra: Record<string, unknown> = {}): CandidatePost {
  return {
    _id: oid(n),
    oxyUserId: `author-${n}`,
    createdAt: new Date(2020, 0, n),
    engagementScore: 100 - n,
    ...extra,
  };
}

function sourceReturning(id: string, posts: CandidatePost[]): SourceModule {
  return { id, kind: 'source', userComposable: true, gather: async () => posts };
}

const CHRONO: FeedDefinition = {
  id: 'test-chrono',
  title: 'Test',
  mode: 'chronological',
  sources: [{ module: 'src', enabled: true }],
  signals: [],
  filters: [],
};

const RANKED_WITH_FALLBACK: FeedDefinition = {
  id: 'test-ranked',
  title: 'Test',
  mode: 'ranked',
  sources: [{ module: 'src', enabled: true }],
  signals: [],
  filters: [],
  execution: { neverBlank: true, popularFallback: 'popular' },
};

let registry: FeedModuleRegistry;
let engine: FeedEngine;

beforeEach(() => {
  vi.clearAllMocks();
  registry = new FeedModuleRegistry();
  engine = new FeedEngine(registry);
});

function idsOf(response: { slices: Array<{ items: Array<{ post: { id?: string } }> }>; items: Array<{ id?: string }> }): string[] {
  const fromSlices = response.slices.flatMap((slice) => slice.items.map((item) => item.post.id ?? ''));
  return fromSlices.length > 0 ? fromSlices : response.items.map((item) => item.id ?? '');
}

describe('gatherPool — muted lanes', () => {
  it('drops posts in a muted lane and keeps everything else', async () => {
    registry.register(sourceReturning('src', [
      makePost(1, { laneId: MUTED_LANE }),
      makePost(2, { laneId: OTHER_LANE }),
      makePost(3),
    ]));

    const response = await engine.run(
      CHRONO,
      { currentUserId: 'viewer', mutedLaneIds: [MUTED_LANE] },
      { limit: 10 },
    );

    // A post with no lane at all is never affected.
    expect(idsOf(response)).toEqual([oid(3).toString(), oid(2).toString()]);
  });

  it('changes nothing for a reader who muted no lane', async () => {
    registry.register(sourceReturning('src', [makePost(1, { laneId: MUTED_LANE }), makePost(2)]));

    const response = await engine.run(CHRONO, { currentUserId: 'viewer' }, { limit: 10 });

    expect(idsOf(response)).toHaveLength(2);
  });

  it('applies on a definition with an EMPTY filter list — the reason it is not a FilterModule', async () => {
    // `authorDefinition` declares `filters: []`. A `FilterModule` would only run
    // if a definition listed it, so a reader's mute would silently not apply on
    // the profile — the surface lanes are most visible on.
    expect(authorDefinition('author-1', 'posts').filters).toEqual([]);

    registry.register(sourceReturning('authored', [
      makePost(1, { laneId: MUTED_LANE }),
      makePost(2),
    ]));

    const response = await engine.run(
      authorDefinition('author-1', 'posts'),
      { currentUserId: 'viewer', mutedLaneIds: [MUTED_LANE] },
      { limit: 10 },
    );

    expect(idsOf(response)).toEqual([oid(2).toString()]);
  });

  it('applies on the cheap peekLatest probe too', async () => {
    registry.register(sourceReturning('src', [makePost(5, { laneId: MUTED_LANE })]));

    const latest = await engine.peekLatest(CHRONO, {
      currentUserId: 'viewer',
      mutedLaneIds: [MUTED_LANE],
    });

    // Otherwise the "new posts" indicator would announce a post the reader has
    // asked never to be shown.
    expect(latest).toBeUndefined();
  });
});

describe('runPopularFallback — muted lanes', () => {
  it('drops muted posts on the one path that never passes through gatherPool', async () => {
    // An empty ranked pool with `neverBlank` routes straight into the fallback.
    registry.register(sourceReturning('src', []));
    registry.register(sourceReturning('popular', [
      makePost(1, { laneId: MUTED_LANE }),
      makePost(2),
    ]));

    const response = await engine.run(
      RANKED_WITH_FALLBACK,
      { currentUserId: 'viewer', mutedLaneIds: [MUTED_LANE] },
      { limit: 10 },
    );

    expect(response.items.map((item) => item.id)).toEqual([oid(2).toString()]);
  });

  it('reads hasMore from the SOURCE, not from what survived the mute', async () => {
    registry.register(sourceReturning('src', []));
    // limit 2, three candidates ⇒ the source genuinely has more.
    registry.register(sourceReturning('popular', [
      makePost(1, { laneId: MUTED_LANE }),
      makePost(2, { laneId: MUTED_LANE }),
      makePost(3),
    ]));

    const response = await engine.run(
      RANKED_WITH_FALLBACK,
      { currentUserId: 'viewer', mutedLaneIds: [MUTED_LANE] },
      { limit: 2 },
    );

    // Both posts of the served window were muted, so the page is empty — but the
    // source had more, and a cursor must still be minted or the reader's feed
    // dead-ends at the first muted run of posts.
    expect(response.items).toEqual([]);
    expect(response.hasMore).toBe(true);
    expect(response.nextCursor).toBeDefined();
  });

  it('serves the anonymous fallback unfiltered — an anonymous reader has no mutes', async () => {
    registry.register(sourceReturning('src', []));
    registry.register(sourceReturning('popular', [makePost(1, { laneId: MUTED_LANE })]));

    const response = await engine.run(RANKED_WITH_FALLBACK, {}, { limit: 10 });

    expect(response.items).toHaveLength(1);
  });
});
