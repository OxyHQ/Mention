import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Unit tests for the generic FeedEngine with FAKE modules and mocked heavy
 * services (no DB / Redis / Oxy). Asserts the engine's orchestration:
 * cross-source dedupe, filter application, ranked-by-score ordering,
 * chronological ordering, and pagination + cursor.
 *
 * Every fixture is a WHOLE `CandidatePost` and every stand-in signal is a real
 * field on it — the ranking stub scores by `stats.likesCount`, the filter keys
 * off `hashtags`. The old fixtures hung private markers (`_testScore`) on a
 * `Record<string, unknown>` bag, which is what let them keep saying `_id` after
 * the engine had stopped reading it.
 */

const sessionMemory = vi.hoisted(() => ({
  enabled: false,
  states: new Map<string, unknown>(),
  posts: new Map<string, unknown>(),
  sequence: 0,
}));
const gateContentLoad = vi.hoisted(() =>
  vi.fn(
    async (ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          { variants: [{ source: 'author' as const, text: 'Persisted useful text' }] },
        ]),
      ),
  ),
);
const revokedSocial = vi.hoisted(() => new Set<string>());
vi.mock('../services/socialFeedEvidence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/socialFeedEvidence')>()),
  attachSocialFeedContext: vi.fn(async () => undefined),
  eligibleSocialPostIds: vi.fn(
    async (ids: string[]) => new Set(ids.filter((id) => !revokedSocial.has(id))),
  ),
}));
vi.mock('../mtn/feed/RankedFeedSession', async (importOriginal) => {
  const original = await importOriginal<typeof import('../mtn/feed/RankedFeedSession')>();
  return {
    ...original,
    rankedFeedSessionStore: {
      available: () => sessionMemory.enabled,
      save: async (state: unknown) => {
        const key = `fs1:test-${++sessionMemory.sequence}`;
        sessionMemory.states.set(key, JSON.parse(JSON.stringify(state)));
        return key;
      },
      load: async (key: string, binding: string) => {
        const state = sessionMemory.states.get(key) as
          | { binding: string; expiresAt: number }
          | undefined;
        if (!state || state.binding !== binding || state.expiresAt <= Date.now())
          throw original.expiredFeedCursor();
        return JSON.parse(JSON.stringify(state));
      },
    },
  };
});
vi.mock('../db/posts/postRepository', () => ({
  loadPostGateContent: gateContentLoad,
  loadPostRecords: async (ids: string[]) =>
    ids.flatMap((id) => {
      const post = sessionMemory.posts.get(id);
      return post ? [{ ...(post as object) }] : [];
    }),
}));

// --- Mock the heavy collaborators the engine calls. ---
const rankPosts = vi.fn(
  async (posts: Array<Record<string, unknown>>, _userId?: unknown, _ctx?: unknown) => {
    // Deterministic stand-in for FeedRankingService: likes ARE the score.
    for (const p of posts) {
      const stats = p.stats as { likesCount?: number } | undefined;
      p.finalScore = stats?.likesCount ?? 0;
    }
    return posts;
  },
);
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: {
    rankPosts: (...args: unknown[]) => rankPosts(...(args as Parameters<typeof rankPosts>)),
  },
}));

// sliceFeed → one single-item slice per post, preserving order.
vi.mock('../services/ThreadSlicingService', () => ({
  threadSlicingService: {
    sliceFeed: vi.fn(async (posts: Array<Record<string, unknown>>) => ({
      slices: posts.map((post) => ({
        _sliceKey: String(post.id),
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));

// hydrateSlices / hydratePosts → passthrough. A candidate already carries `id`
// (that IS the record's id), so hydration has nothing to stamp here.
vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (posts: unknown[]) => posts),
  },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { MtnConfig } from '@mention/shared-types';
import { postHydrationService } from '../services/PostHydrationService';
import {
  forYouDefinition,
  mediaDefinition,
  savedDefinition,
  videosDefinition,
} from '../mtn/feed/definitions/presets';
import { safetyFilter } from '../mtn/feed/engine/filters';
import { feedSeenPostsService } from '../services/FeedSeenPostsService';
import { selectRankedPage } from '../mtn/feed/selectRankedPage';
import { FeedEngine, sliceTopWindow } from '../mtn/feed/engine/FeedEngine';
import { threadSlicingService } from '../services/ThreadSlicingService';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import { ScoreCursor, ChronoCursor } from '../mtn/feed/CursorBuilder';
import type {
  CandidatePost,
  FeedDefinition,
  SourceModule,
  FilterModule,
} from '../mtn/feed/engine/types';
import { feedCandidate, postStats } from './fixtures/feedCandidate';

/**
 * A pre-cutover ObjectId-hex id. Ids are plain `text` now, but they are not
 * arbitrary: `isLiveEntityId` accepts exactly the two shapes this database
 * stores (24-char ObjectId hex, uuid v7), and `ScoreCursor` refuses to mint or
 * parse a cursor around anything else. A fixture id like `post-1` silently
 * produces NO cursor and every page becomes page one.
 */
const id = (n: number) => `5f${n.toString().padStart(22, '0')}`;

function makePost(n: number, overrides: Partial<CandidatePost> = {}): CandidatePost {
  return feedCandidate({
    id: id(n),
    oxyUserId: `author-${n}`,
    createdAt: new Date(2020, 0, n),
    ...overrides,
  });
}

/** A candidate the ranking stub will score at `likes`. */
function scored(n: number, likes: number, overrides: Partial<CandidatePost> = {}): CandidatePost {
  return makePost(n, { stats: postStats({ likesCount: likes }), ...overrides });
}

function sourceReturning(id: string, posts: CandidatePost[]): SourceModule {
  return { id, kind: 'source', userComposable: true, gather: async () => posts };
}

let registry: FeedModuleRegistry;
let engine: FeedEngine;

beforeEach(() => {
  vi.clearAllMocks();
  revokedSocial.clear();
  sessionMemory.enabled = false;
  sessionMemory.states.clear();
  sessionMemory.posts.clear();
  registry = new FeedModuleRegistry();
  engine = new FeedEngine(registry);
});

describe('FeedEngine — explicit saved content', () => {
  it.each([false, true])(
    'honors sensitive opt-in (%s) while retaining viewer-aware hydration',
    async (showSensitiveContent) => {
      registry.register(
        sourceReturning('saved', [makePost(1, { metadata: { isSensitive: true } }), makePost(2)]),
      );
      registry.register(safetyFilter);
      const context = {
        currentUserId: 'viewer',
        showSensitiveContent,
        followingIds: [],
        followerIds: [],
        viewerPrivacy: { blockedIds: ['blocked'], restrictedIds: [] },
      };
      const result = await engine.run(savedDefinition, context, { limit: 10 });
      expect(result.items.map((post) => post.id)).toEqual(
        showSensitiveContent ? [id(1), id(2)] : [id(2)],
      );
      expect(postHydrationService.hydratePosts).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          viewerId: 'viewer',
          viewerPrivacy: context.viewerPrivacy,
          viewerGraph: { followingIds: [], followerIds: [] },
        }),
      );
    },
  );
});

describe('FeedEngine — ranked mode', () => {
  it.each([false, true])(
    'forwards bell interest through ranking with Redis session=%s and preserves trusted dedupe',
    async (session) => {
      sessionMemory.enabled = session;
      const bell = scored(1, 10, { oxyUserId: 'bell-author', activitySubscriptionMatch: true });
      sessionMemory.posts.set(bell.id, bell);
      registry.register({ ...sourceReturning('bell', [bell]), trusted: true });
      registry.register(
        sourceReturning('discovery', [{ ...bell, activitySubscriptionMatch: undefined }]),
      );
      const reject = vi.fn(() => false);
      registry.register({ id: 'reject', kind: 'filter', keep: reject });
      const def: FeedDefinition = {
        id: 'for_you',
        title: 'For You',
        mode: 'ranked',
        sources: [
          { module: 'bell', enabled: true },
          { module: 'discovery', enabled: true },
        ],
        signals: [],
        filters: [],
        discoveryFilters: [{ module: 'reject', enabled: true }],
        execution: { sessionPagination: true },
      };
      const response = await engine.run(
        def,
        { currentUserId: 'viewer', activitySubscribedAuthorIds: ['bell-author'] },
        { limit: 10 },
      );
      expect(response.items.map((post) => post.id)).toEqual([bell.id]);
      expect(reject).not.toHaveBeenCalled();
      expect(rankPosts.mock.calls[0]?.[2]).toMatchObject({
        activitySubscribedAuthorIds: ['bell-author'],
      });
      expect(rankPosts.mock.calls[0]?.[0][0]).toMatchObject({ activitySubscriptionMatch: true });
      expect(rankPosts.mock.calls[0]?.[0][0]).not.toHaveProperty('_discovery', true);
    },
  );

  it.each(['hiddenAuthors', 'mutedAuthors', 'blockedAuthors'] as const)(
    'does not trust a %s bell coauthor from discovery while retaining a different eligible bell',
    async (field) => {
      const excluded = scored(1, 10, {
        oxyUserId: 'clean-owner',
        activitySubscriptionMatch: true,
        authorship: [{ oxyUserId: 'unwanted', role: 'collaborator', status: 'accepted' }],
      });
      const mixed = scored(2, 9, {
        oxyUserId: 'clean-owner',
        authorship: [
          { oxyUserId: 'unwanted', role: 'collaborator', status: 'accepted' },
          { oxyUserId: 'eligible', role: 'collaborator', status: 'accepted' },
        ],
      });
      registry.register(sourceReturning('discovery', [excluded, mixed]));
      const gate = vi.fn((_post: CandidatePost) => true);
      registry.register({ id: 'gate', kind: 'filter', keep: gate });
      await engine.run(
        {
          id: 'for_you',
          title: 'For You',
          mode: 'ranked',
          sources: [{ module: 'discovery', enabled: true }],
          signals: [],
          filters: [],
          discoveryFilters: [{ module: 'gate', enabled: true }],
        },
        {
          currentUserId: 'viewer',
          activitySubscribedAuthorIds: ['unwanted', 'eligible'],
          userBehavior: { [field]: ['unwanted'] },
        },
        { limit: 10 },
      );
      expect(gate).toHaveBeenCalledTimes(1);
      expect(gate.mock.calls[0]?.[0]).toMatchObject({ id: excluded.id });
      expect(rankPosts.mock.calls[0]?.[2]).toMatchObject({
        activitySubscribedAuthorIds: ['eligible'],
      });
      expect(excluded).toMatchObject({
        _discovery: true,
        activitySubscriptionMatch: false,
        activitySubscriptionAuthorIds: [],
      });
      expect(mixed).toMatchObject({
        activitySubscriptionMatch: true,
        activitySubscriptionAuthorIds: ['eligible'],
      });
      expect(mixed).not.toHaveProperty('_discovery', true);
    },
  );

  it.each(['primary', 'accepted-coauthor'] as const)(
    'recognizes %s bell interest from another lane while preserving safety and numeric exclusions',
    async (kind) => {
      const author = 'bell-author';
      const overrides: Partial<CandidatePost> =
        kind === 'primary'
          ? { oxyUserId: author }
          : { authorship: [{ oxyUserId: author, role: 'collaborator', status: 'accepted' }] };
      registry.register(
        sourceReturning('discovery', [
          scored(1, 10, overrides),
          scored(2, 10, { ...overrides, content: { variants: [{ source: 'author', text: '3' }] } }),
          scored(3, 10, { ...overrides, metadata: { isSensitive: true } }),
        ]),
      );
      registry.register(safetyFilter);
      const reject = vi.fn(() => false);
      registry.register({ id: 'reject', kind: 'filter', keep: reject });
      const result = await engine.run(
        {
          id: 'for_you',
          title: 'For You',
          mode: 'ranked',
          sources: [{ module: 'discovery', enabled: true }],
          signals: [],
          filters: [{ module: 'safety', enabled: true }],
          discoveryFilters: [{ module: 'reject', enabled: true }],
        },
        { currentUserId: 'viewer', activitySubscribedAuthorIds: [author] },
        { limit: 10 },
      );
      expect(result.items.map((post) => post.id)).toEqual([id(1)]);
      expect(reject).not.toHaveBeenCalled();
      expect(rankPosts.mock.calls[0]?.[0][0]).toMatchObject({ activitySubscriptionMatch: true });
      expect(rankPosts.mock.calls[0]?.[0][0]).not.toHaveProperty('_discovery', true);
    },
  );

  it.each([
    { location: 'discovery', trusted: false, enabled: true, reads: 1 },
    { location: 'discovery', trusted: true, enabled: true, reads: 0 },
    { location: 'pool', trusted: true, enabled: true, reads: 1 },
    { location: 'pool', trusted: false, enabled: false, reads: 0 },
  ])(
    'prepares only applicable shell content ($location/$trusted/$enabled)',
    async ({ location, trusted, enabled, reads }) => {
      const shell = scored(1, 5, { _unassembled: true, content: { variants: [] } });
      const keep = vi.fn(
        (post: CandidatePost) => post.content.variants?.[0]?.text === 'Persisted useful text',
      );
      registry.register({ ...sourceReturning('source', [shell, shell]), trusted });
      registry.register({ id: 'contentGate', kind: 'filter', needsTextMedia: true, keep });
      const refs = [{ module: 'contentGate', enabled }];
      await engine.run(
        {
          id: 'content-gate-test',
          title: 'Test',
          mode: 'ranked',
          sources: [{ module: 'source', enabled: true }],
          signals: [],
          filters: location === 'pool' ? refs : [],
          discoveryFilters: location === 'discovery' ? refs : [],
        },
        { currentUserId: 'viewer' },
        { limit: 20 },
      );
      expect(gateContentLoad).toHaveBeenCalledTimes(reads);
      if (reads) {
        expect(gateContentLoad).toHaveBeenCalledWith([shell.id], undefined, {
          sources: false,
          variantAlt: false,
        });
        expect(keep).toHaveReturnedWith(true);
      }
      expect(shell.content.variants).toEqual([]);
      expect(rankPosts.mock.calls[0]?.[0][0]).toMatchObject({
        _unassembled: true,
        content: { variants: [] },
      });
    },
  );

  it('does not project content for score-only filters or viewer-disabled content gates', async () => {
    registry.register(
      sourceReturning('source', [scored(1, 5, { _unassembled: true, content: { variants: [] } })]),
    );
    registry.register({ id: 'minLength', kind: 'filter', needsTextMedia: true, keep: () => true });
    registry.register({ id: 'scoreOnly', kind: 'filter', keep: () => true });
    await engine.run(
      {
        id: 'disabled-content-gate',
        title: 'Test',
        mode: 'ranked',
        sources: [{ module: 'source', enabled: true }],
        signals: [],
        filters: [{ module: 'scoreOnly', enabled: true }],
        discoveryFilters: [
          { module: 'minLength', enabled: true, params: { viewerGateTuning: true } },
        ],
      },
      { currentUserId: 'viewer', feedTuning: { forYou: { minLength: { enabled: false } } } },
      { limit: 20 },
    );
    expect(gateContentLoad).not.toHaveBeenCalled();
  });

  it('requests extra content tables only for enabled applicable filters', async () => {
    const shell = scored(1, 5, { _unassembled: true, content: { variants: [] } });
    registry.register({ ...sourceReturning('source', [shell]), trusted: true });
    registry.register({
      id: 'links',
      kind: 'filter',
      needsTextMedia: true,
      needsSources: true,
      keep: () => true,
    });
    registry.register({
      id: 'alt',
      kind: 'filter',
      needsTextMedia: true,
      needsVariantAlt: true,
      keep: () => true,
    });
    const def: FeedDefinition = {
      id: 'projection-options',
      title: 'Test',
      mode: 'ranked',
      signals: [],
      sources: [{ module: 'source', enabled: true }],
      filters: [{ module: 'links', enabled: true }],
      discoveryFilters: [{ module: 'alt', enabled: true }],
    };
    await engine.run(def, { currentUserId: 'viewer' }, { limit: 20 });
    expect(gateContentLoad).toHaveBeenLastCalledWith([shell.id], undefined, {
      sources: true,
      variantAlt: false,
    });
    def.filters.push({ module: 'alt', enabled: true });
    await engine.run(def, { currentUserId: 'viewer' }, { limit: 20 });
    expect(gateContentLoad).toHaveBeenLastCalledWith([shell.id], undefined, {
      sources: true,
      variantAlt: true,
    });
  });

  it('dedupes across sources, applies a filter, and orders by composed score', async () => {
    // Two sources with an overlapping post; a filter drops post #3.
    registry.register(sourceReturning('a', [scored(1, 1), scored(2, 5)]));
    registry.register(sourceReturning('b', [scored(2, 5), scored(3, 9, { hashtags: ['dropme'] })]));
    const dropThree: FilterModule = {
      id: 'dropThree',
      kind: 'filter',
      keep: (post) => !post.hashtags.includes('dropme'),
    };
    registry.register(dropThree);

    const def: FeedDefinition = {
      id: 'test-ranked',
      title: 'Test',
      mode: 'ranked',
      sources: [
        { module: 'a', enabled: true },
        { module: 'b', enabled: true },
      ],
      signals: [],
      filters: [{ module: 'dropThree', enabled: true }],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 30 });
    const ids = result.items.map((i) => i.id);

    // #3 filtered out; #2 deduped to one; ordered by score desc (#2=5 before #1=1).
    expect(ids).toEqual([id(2), id(1)]);
    expect(rankPosts).toHaveBeenCalledOnce();
  });

  it('paginates: respects limit and returns an advancing cursor', async () => {
    registry.register(sourceReturning('a', [scored(1, 9), scored(2, 1)]));
    const def: FeedDefinition = {
      id: 'test-page',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'a', enabled: true }],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 1 });
    expect(result.items.map((i) => i.id)).toEqual([id(1)]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeTruthy();
  });

  /**
   * A RANKED (not pre-scored) page continues under the v1 cursor, carrying the
   * `excludeIds` guard.
   *
   * `rankingAsOf` used to be set only for pre-scored feeds, so every other ranked
   * page — For You above all — minted the LEGACY `score:id` form, which carries
   * no exclusions. That is the feed least able to afford it: its scores are
   * recomputed against a fresh `Date.now()` on every page and its engagement
   * counts move underneath, so the `score < cursor.score` window is applied to
   * numbers that shifted since minting. The only thing standing between a reader
   * and a repeat was the seen set — a 1000-id, 30-minute cache shared across
   * three feeds, under most pressure exactly where the scroll is deepest.
   */
  it('mints a ranked cursor carrying the excludeIds guard, not the legacy form', async () => {
    registry.register(sourceReturning('a', [scored(1, 9), scored(2, 5), scored(3, 1)]));
    const def: FeedDefinition = {
      id: 'test-ranked-cursor',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'a', enabled: true }],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 1 });

    expect(result.nextCursor).toBeTruthy();
    const parsed = ScoreCursor.parse(result.nextCursor);
    // The legacy `score:id` form parses too, and yields no `asOf` and no
    // `excludeIds` — which is exactly the state this guards against, so both are
    // asserted rather than only the payload's presence.
    expect(parsed?.asOf).toBeGreaterThan(0);
    expect(parsed?.excludeIds).toContain(id(1));
  });

  it('keeps pre-scored pages disjoint when time and engagement advance', async () => {
    vi.useFakeTimers();
    const initialTime = Date.UTC(2026, 6, 26, 12, 0, 0);
    vi.setSystemTime(initialTime);

    try {
      const candidates = [
        makePost(1, { finalScore: 0.9876543210987654 }),
        makePost(2, { finalScore: 0.8765432109876543 }),
        makePost(3, { finalScore: 0.7654321098765432 }),
        makePost(4, { finalScore: 0.6543210987654321 }),
      ];
      const observedAsOf: Array<number | undefined> = [];
      const gather = vi.fn(async (ctx: Parameters<SourceModule['gather']>[0]) => {
        observedAsOf.push(ctx.rankingAsOf);
        const parsed = ScoreCursor.parse(ctx.cursor);
        const excluded = new Set(parsed?.excludeIds ?? []);
        return candidates
          .filter((post) => {
            if (excluded.has(post.id)) return false;
            if (!parsed || parsed.score === Infinity) return true;
            const score = post.finalScore ?? 0;
            return score < parsed.score || (score === parsed.score && post.id < parsed.id);
          })
          .sort((a, b) => {
            const scoreDiff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
            return scoreDiff || b.id.localeCompare(a.id);
          });
      });
      registry.register({ id: 'pre-scored', kind: 'source', userComposable: false, gather });
      const def: FeedDefinition = {
        id: 'test-pre-scored',
        title: 'Test pre-scored',
        mode: 'ranked',
        sources: [{ module: 'pre-scored', enabled: true }],
        signals: [],
        filters: [],
        execution: { preScored: true },
      };

      const first = await engine.run(def, {}, { limit: 2 });
      const parsedCursor = ScoreCursor.parse(first.nextCursor);
      expect(first.items.map((item) => item.id)).toEqual([id(1), id(2)]);
      expect(parsedCursor).toMatchObject({
        score: 0.8765432109876543,
        id: id(2),
        asOf: initialTime,
      });
      expect(new Set(parsedCursor?.excludeIds)).toEqual(new Set([id(1), id(2)]));

      // The top item loses engagement and would cross below the old watermark;
      // advancing the clock must not create a duplicate on page two.
      candidates[0].finalScore = 0.1;
      vi.setSystemTime(initialTime + 6 * 60 * 60 * 1000);

      const second = await engine.run(def, {}, { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.id)).toEqual([id(3), id(4)]);
      const firstIds = new Set(first.items.map((item) => item.id));
      expect(second.items.some((item) => firstIds.has(item.id))).toBe(false);
      expect(observedAsOf).toEqual([initialTime, initialTime]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects a pre-scored page window before author diversification', async () => {
    const candidates = [
      makePost(10, { oxyUserId: 'author-a', finalScore: 10 }),
      makePost(9, { oxyUserId: 'author-a', finalScore: 9 }),
      makePost(8, { oxyUserId: 'author-b', finalScore: 8 }),
    ];
    const gather = async (ctx: Parameters<SourceModule['gather']>[0]) => {
      const parsed = ScoreCursor.parse(ctx.cursor);
      const excluded = new Set(parsed?.excludeIds ?? []);
      return candidates.filter((post) => {
        if (excluded.has(post.id)) return false;
        if (!parsed || parsed.score === Infinity) return true;
        const score = post.finalScore ?? 0;
        return score < parsed.score || (score === parsed.score && post.id < parsed.id);
      });
    };
    registry.register({ id: 'pre-scored-window', kind: 'source', userComposable: false, gather });
    const def: FeedDefinition = {
      id: 'test-pre-scored-window',
      title: 'Test pre-scored window',
      mode: 'ranked',
      sources: [{ module: 'pre-scored-window', enabled: true }],
      signals: [],
      filters: [],
      execution: { preScored: true },
    };

    const first = await engine.run(def, {}, { limit: 2 });
    const second = await engine.run(def, {}, { limit: 2, cursor: first.nextCursor });

    expect(first.items.map((item) => item.id)).toEqual([id(10), id(9)]);
    expect(second.items.map((item) => item.id)).toEqual([id(8)]);
    expect(
      new Set([...first.items.map((item) => item.id), ...second.items.map((item) => item.id)]),
    ).toEqual(new Set([id(10), id(9), id(8)]));
  });
});

describe('FeedEngine — ranked pagination coverage', () => {
  /**
   * TEN, not six, and the pool shape is what fixes it. `thinGraphPool`
   * interleaves 1:1, so a page window holds `ceil(PAGE_LIMIT / 2)` of the
   * prolific author's posts — at six that is exactly `maxPerAuthorPerPage`, the
   * cap never binds, nothing is ever deferred, and the case passes against an
   * engine that drops deferred slices outright. (Measured: dropping the overflow
   * tail in `diversifyByAuthor` left this file green at six.) The floor below
   * asserts the binding rather than restating a number, so a change to either
   * the page size or the cap re-derives it instead of quietly going vacuous.
   */
  const PAGE_LIMIT = 10;
  const PROLIFIC_POSTS = 12;
  const SOLO_AUTHORS = 12;

  /**
   * A thin follow graph: ONE prolific author interleaved with a long tail of
   * one-post authors, strictly score-descending. This is the shape
   * `maxPerAuthorPerPage` exists for — the prolific author supplies far more
   * page-eligible candidates than the cap admits, so the reranker has to defer
   * some of them.
   */
  function thinGraphPool(): CandidatePost[] {
    const posts: CandidatePost[] = [];
    let score = PROLIFIC_POSTS + SOLO_AUTHORS;
    for (let i = 0; i < Math.max(PROLIFIC_POSTS, SOLO_AUTHORS); i += 1) {
      if (i < PROLIFIC_POSTS) {
        posts.push(scored(posts.length + 1, score, { oxyUserId: 'prolific' }));
        score -= 1;
      }
      if (i < SOLO_AUTHORS) {
        posts.push(scored(posts.length + 1, score, { oxyUserId: `solo-${i}` }));
        score -= 1;
      }
    }
    return posts;
  }

  function rankedDef(sourceId: string): FeedDefinition {
    return {
      id: 'test-ranked-pagination',
      title: 'Test ranked pagination',
      mode: 'ranked',
      sources: [{ module: sourceId, enabled: true }],
      signals: [],
      filters: [],
    };
  }

  /**
   * Drain a ranked pagination session to exhaustion and report what each page
   * served.
   *
   * A SINGLE page cannot observe this class of bug: page one looks complete and
   * correctly ordered, and the loss only appears as the union of every page
   * falling short of the pool. That is why the check has to paginate.
   */
  async function drainRanked(
    def: FeedDefinition,
    limit: number,
    poolSize: number,
  ): Promise<{ pages: string[][]; served: string[] }> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    // A page that reports `hasMore` must serve at least one item, so a pool of
    // N posts can never need more than N pages. Exceeding that is a loop, not a
    // long session, and must fail loudly rather than spin.
    for (let page = 0; page <= poolSize; page += 1) {
      const result = await engine.run(def, { currentUserId: 'viewer' }, { limit, cursor });
      pages.push(result.items.map((item) => item.id));
      if (!result.hasMore || !result.nextCursor) {
        return { pages, served: pages.flat() };
      }
      cursor = result.nextCursor;
    }
    throw new Error(`Ranked session did not terminate within ${poolSize} pages`);
  }

  it('serves every candidate across the session — per-author-cap overflow rolls forward, never strands', async () => {
    const pool = thinGraphPool();

    // Vacuity floor. The pool is already score-descending, so its first
    // `PAGE_LIMIT` entries ARE the page-one window the reranker sees — and the
    // cap only defers anything if that window holds more of one author than the
    // cap admits. Asserting `PROLIFIC_POSTS > maxPerAuthorPerPage` instead (what
    // this used to do) is a claim about the POOL, which stays true while the
    // WINDOW stops binding: the fixture goes inert and the case still passes.
    const prolificInWindow = pool
      .slice(0, PAGE_LIMIT)
      .filter((post) => post.oxyUserId === 'prolific').length;
    expect(prolificInWindow).toBeGreaterThan(MtnConfig.ranking.diversity.maxPerAuthorPerPage);
    registry.register(sourceReturning('thin-graph', pool));

    const { served } = await drainRanked(rankedDef('thin-graph'), PAGE_LIMIT, pool.length);

    const poolIds = pool.map((post) => post.id);
    const servedSet = new Set(served);
    const stranded = poolIds.filter((id) => !servedSet.has(id));

    // The reranker's documented contract: it DEFERS, it never drops. A deferred
    // slice scores ABOVE the page tail, so the score cursor minted from that
    // tail excludes it from every subsequent page — it is lost, not deferred.
    expect({ strandedCount: stranded.length, strandedIds: stranded }).toEqual({
      strandedCount: 0,
      strandedIds: [],
    });
    expect(servedSet.size).toBe(poolIds.length);
    // A session must not repeat either: coverage bought with duplicates is not
    // coverage.
    expect(served.length).toBe(servedSet.size);
  });

  it('control: a pool with one post per author strands nothing (the cap never binds)', async () => {
    const pool = Array.from({ length: PROLIFIC_POSTS + SOLO_AUTHORS }, (_, i) =>
      scored(i + 1, PROLIFIC_POSTS + SOLO_AUTHORS - i, { oxyUserId: `solo-${i}` }),
    );
    registry.register(sourceReturning('one-each', pool));

    const { served } = await drainRanked(rankedDef('one-each'), PAGE_LIMIT, pool.length);

    const servedSet = new Set(served);
    const stranded = pool.map((post) => post.id).filter((id) => !servedSet.has(id));

    expect({ strandedCount: stranded.length, strandedIds: stranded }).toEqual({
      strandedCount: 0,
      strandedIds: [],
    });
    expect(served.length).toBe(servedSet.size);
  });
});

describe('FeedEngine — ranking session guards', () => {
  it('requires a refresh for old custom ranking scores after the engagement scale changes', async () => {
    const definition: FeedDefinition = {
      id: 'custom',
      title: 'Custom',
      mode: 'ranked',
      sources: [],
      filters: [],
      signals: [],
    };
    await expect(
      engine.run(definition, {}, { limit: 20, cursor: ScoreCursor.build(1, id(1)) }),
    ).rejects.toMatchObject({ statusCode: 410, code: 'FEED_CURSOR_EXPIRED' });
  });

  it('excludes served cursor ids after score drift even when the seen cache is empty', async () => {
    registry.register(sourceReturning('source', [scored(1, 4), scored(2, 3), scored(3, 2)]));
    const definition: FeedDefinition = {
      id: 'ranked',
      title: 'Ranked',
      mode: 'ranked',
      sources: [{ module: 'source', enabled: true }],
      filters: [],
      signals: [],
    };
    const asOf = Date.UTC(2026, 9, 21);
    const cursor = ScoreCursor.build(10, id(9), { asOf, excludeIds: [id(1)], rankingVersion: 2 });
    const result = await engine.run(definition, { currentUserId: 'viewer' }, { limit: 1, cursor });
    expect(result.items.map((post) => post.id)).toEqual([id(2)]);
    expect(rankPosts.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ rankingAsOf: asOf }));
    expect(ScoreCursor.parse(result.nextCursor)?.excludeIds).toEqual(
      expect.arrayContaining([id(1), id(2)]),
    );
  });
});

describe('FeedEngine — chronological mode', () => {
  it('orders by createdAt desc and dedupes', async () => {
    registry.register(sourceReturning('a', [makePost(3), makePost(1)]));
    registry.register(sourceReturning('b', [makePost(1), makePost(2)]));
    const def: FeedDefinition = {
      id: 'test-chrono',
      title: 'Test',
      mode: 'chronological',
      sources: [
        { module: 'a', enabled: true },
        { module: 'b', enabled: true },
      ],
      signals: [],
      filters: [],
    };

    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 30 });
    // createdAt = 2020-01-n, so newest first: 3, 2, 1 (deduped).
    expect(result.items.map((i) => i.id)).toEqual([id(3), id(2), id(1)]);
    expect(rankPosts).not.toHaveBeenCalled();
  });
});

describe('FeedEngine — filtered chronological pagination', () => {
  function timeline(posts: CandidatePost[]): FeedDefinition {
    registry.register({
      id: 'timeline',
      kind: 'source',
      userComposable: false,
      gather: async (ctx, _params, cap) => {
        const boundary = ChronoCursor.parse(ctx.cursor);
        return posts
          .filter((post) => !boundary || new Date(post.createdAt!).getTime() < boundary.ts!)
          .slice(0, cap);
      },
    });
    registry.register({
      id: 'visible',
      kind: 'filter',
      keep: (post) => !post.hashtags.includes('hidden'),
    });
    return {
      id: 'timeline',
      title: 'Timeline',
      mode: 'chronological',
      sources: [{ module: 'timeline', enabled: true }],
      filters: [{ module: 'visible', enabled: true }],
      signals: [],
    };
  }

  it('fills past rejected windows and continues from the raw scan without skips', async () => {
    const posts = Array.from({ length: 9 }, (_, n) =>
      makePost(9 - n, {
        hashtags: n < 3 || n === 5 ? ['hidden'] : [],
      }),
    );
    const definition = timeline(posts);
    const first = await engine.run(definition, {}, { limit: 2 });
    expect(first.items.map((post) => post.id)).toEqual([id(6), id(5)]);
    expect(first.hasMore).toBe(true);
    // #4 was rejected after the visible #5 and must still advance the cursor.
    expect(ChronoCursor.parse(first.nextCursor)?.id).toBe(id(4));
    const second = await engine.run(definition, {}, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((post) => post.id)).toEqual([id(3), id(2)]);
    const third = await engine.run(definition, {}, { limit: 2, cursor: second.nextCursor });
    expect(third.items.map((post) => post.id)).toEqual([id(1)]);
    expect(third.hasMore).toBe(false);
  });

  it.each([1, 1.5])(
    'caps filtered and overfetched chronological pages at the requested limit (overfetch %s)',
    async (overfetchMultiplier) => {
      const posts = Array.from({ length: 61 }, (_, index) =>
        makePost(61 - index, {
          hashtags: index === 0 ? ['hidden'] : [],
        }),
      );
      const definition = { ...timeline(posts), execution: { overfetchMultiplier } };
      const served: string[] = [];
      let cursor: string | undefined;
      let hasMore = true;
      for (let page = 0; page < 4 && hasMore; page += 1) {
        const result = await engine.run(definition, {}, { limit: 20, cursor });
        expect(result.slices.length).toBeLessThanOrEqual(20);
        expect(result.items.length).toBeLessThanOrEqual(20);
        served.push(...result.items.map((post) => post.id));
        cursor = result.nextCursor;
        hasMore = result.hasMore;
      }
      expect(hasMore).toBe(false);
      expect(served).toEqual(
        posts.filter((post) => !post.hashtags.includes('hidden')).map((post) => post.id),
      );
      expect(new Set(served).size).toBe(60);
    },
  );

  it('returns an advancing cursor through an entirely rejected bounded scan', async () => {
    const posts = Array.from({ length: 14 }, (_, n) =>
      makePost(14 - n, {
        hashtags: n < 11 ? ['hidden'] : [],
      }),
    );
    const definition = timeline(posts);
    const first = await engine.run(definition, {}, { limit: 2 });
    expect(first.items).toEqual([]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const next = await engine.run(definition, {}, { limit: 2, cursor: first.nextCursor });
    expect(next.items.map((post) => post.id)).toEqual([id(3), id(2)]);
    expect(next.hasMore).toBe(true);
    const final = await engine.run(definition, {}, { limit: 2, cursor: next.nextCursor });
    expect(final.items.map((post) => post.id)).toEqual([id(1)]);
    expect(final.hasMore).toBe(false);
  });
});

describe('FeedEngine — source failures', () => {
  it('a failed chronological source cannot silently advance past its missing rows', async () => {
    const bad: SourceModule = {
      id: 'bad',
      kind: 'source',
      userComposable: true,
      gather: async () => {
        throw new Error('boom');
      },
    };
    registry.register(bad);
    registry.register(sourceReturning('good', [makePost(1)]));
    const def: FeedDefinition = {
      id: 'test-softfail',
      title: 'Test',
      mode: 'chronological',
      sources: [
        { module: 'bad', enabled: true },
        { module: 'good', enabled: true },
      ],
      signals: [],
      filters: [],
    };

    await expect(engine.run(def, { currentUserId: 'viewer' }, { limit: 30 })).rejects.toMatchObject(
      { statusCode: 503, code: 'FEED_SOURCE_UNAVAILABLE' },
    );
  });
});

describe('FeedEngine — ranked fallbacks', () => {
  function rankedDef(): FeedDefinition {
    return {
      id: 'test-fallback',
      title: 'Test',
      mode: 'ranked',
      sources: [{ module: 'lane', enabled: true }],
      signals: [],
      filters: [],
      execution: { seenPosts: true, neverBlank: true, popularFallback: 'popular' },
    };
  }

  it.each([false, true])(
    'anonymous Media ranks fresh supply before popular continuation (session %s)',
    async (session) => {
      sessionMemory.enabled = session;
      const fresh = [scored(1, 30), scored(2, 20), scored(3, 10)];
      const older = [9, 8, 7].map((n) => scored(n, n * 100, { engagementScore: n * 100 }));
      for (const post of [...fresh, ...older]) sessionMemory.posts.set(post.id, post);
      const primary = vi.fn(async (ctx: { seenPostIds?: string[] }) =>
        fresh.filter((post) => !ctx.seenPostIds?.includes(post.id)),
      );
      const popular = vi.fn(async (ctx: { seenPostIds?: string[] }) =>
        [...older, ...fresh].filter((post) => !ctx.seenPostIds?.includes(post.id)),
      );
      registry.register({ id: 'media', kind: 'source', userComposable: false, gather: primary });
      registry.register({
        id: 'popularMedia',
        kind: 'source',
        userComposable: false,
        gather: popular,
      });
      const definition = { ...mediaDefinition, filters: [], discoveryFilters: [] };
      const first = await engine.run(definition, {}, { limit: 2 });
      expect(first.items.map((post) => post.id)).toEqual(fresh.slice(0, 2).map((post) => post.id));
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeDefined();
      expect(popular).not.toHaveBeenCalled();
      expect(rankPosts).toHaveBeenCalledOnce();

      const next = await engine.run(definition, {}, { limit: 2, cursor: first.nextCursor });
      expect(next.items.map((post) => post.id)).toEqual([fresh[2].id]);
      expect(next.hasMore).toBe(true);
      expect(popular).not.toHaveBeenCalled();
      const fallback = await engine.run(definition, {}, { limit: 2, cursor: next.nextCursor });
      expect(fallback.items.map((post) => post.id)).toEqual(
        older.slice(0, 2).map((post) => post.id),
      );
      expect(fallback.hasMore).toBe(true);
      expect(popular).toHaveBeenCalledOnce();
      const primaryCalls = primary.mock.calls.length;
      const final = await engine.run(definition, {}, { limit: 2, cursor: fallback.nextCursor });
      expect(final.items.map((post) => post.id)).toEqual([older[2].id]);
      expect(final.hasMore).toBe(false);
      expect(primary).toHaveBeenCalledTimes(primaryCalls);
      // Popular is already scored on its own axis: only the primary receives
      // ranking, and previously served fresh posts cannot reappear in fallback.
      expect(
        rankPosts.mock.calls
          .flatMap(([posts]) => posts)
          .every((post) => fresh.some((candidate) => candidate.id === post.id)),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'keeps anonymous For You and Videos on popular-first (session %s)',
    async (session) => {
      sessionMemory.enabled = session;
      registry.register(sourceReturning('popular', [makePost(9)]));
      registry.register(sourceReturning('popularVideos', [makePost(8)]));
      for (const preset of [forYouDefinition, videosDefinition]) {
        const result = await engine.run(
          { ...preset, filters: [], discoveryFilters: [] },
          {},
          { limit: 20 },
        );
        expect(result.items).toHaveLength(1);
      }
      expect(rankPosts).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'anonymous Media falls back when primary is empty without changing signed-in behavior (session %s)',
    async (session) => {
      sessionMemory.enabled = session;
      const primary = vi.fn(async () => []);
      const popular = vi.fn(async () => [makePost(9)]);
      registry.register({ id: 'media', kind: 'source', userComposable: false, gather: primary });
      registry.register({
        id: 'popularMedia',
        kind: 'source',
        userComposable: false,
        gather: popular,
      });
      const definition = { ...mediaDefinition, filters: [], discoveryFilters: [] };
      const anonymous = await engine.run(definition, {}, { limit: 20 });
      expect(anonymous.items.map((post) => post.id)).toEqual([id(9)]);
      expect(anonymous.hasMore).toBe(false);
      expect(primary).toHaveBeenCalledOnce();
      expect(popular).toHaveBeenCalledOnce();

      const signedIn = await engine.run(definition, { currentUserId: 'viewer' }, { limit: 20 });
      expect(signedIn.items).toEqual([]);
      expect(signedIn.hasMore).toBe(false);
      expect(popular).toHaveBeenCalledOnce();
    },
  );

  it('serves the popular fallback for an anonymous viewer (never gathering the ranked lane)', async () => {
    const laneGather = vi.fn(async () => [scored(1, 5)]);
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'lane', kind: 'source', userComposable: false, gather: laneGather });
    registry.register({
      id: 'popular',
      kind: 'source',
      userComposable: false,
      gather: popularGather,
    });

    const result = await engine.run(rankedDef(), {}, { limit: 30 });
    expect(popularGather).toHaveBeenCalledOnce();
    expect(laneGather).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.id)).toEqual([id(9)]);
  });

  it('falls back to popular when the authenticated ranked pool is empty (never-blank)', async () => {
    registry.register({
      id: 'lane',
      kind: 'source',
      userComposable: false,
      gather: async () => [],
    });
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({
      id: 'popular',
      kind: 'source',
      userComposable: false,
      gather: popularGather,
    });

    const result = await engine.run(rankedDef(), { currentUserId: 'viewer' }, { limit: 30 });
    expect(popularGather).toHaveBeenCalledOnce();
    expect(result.items.map((i) => i.id)).toEqual([id(9)]);
  });

  it('keeps discovery ranking sensitive content disabled despite viewer opt-in', async () => {
    registry.register({
      id: 'lane',
      kind: 'source',
      userComposable: false,
      gather: async () => [scored(1, 5)],
    });
    registry.register({
      id: 'popular',
      kind: 'source',
      userComposable: false,
      gather: async () => [],
    });

    await engine.run(
      rankedDef(),
      { currentUserId: 'viewer', showSensitiveContent: true },
      { limit: 30 },
    );
    expect(rankPosts).toHaveBeenCalledOnce();
    const rankCtx = rankPosts.mock.calls[0]?.[2];
    expect(rankCtx).toBeDefined();
    expect(
      rankCtx && typeof rankCtx === 'object' && 'showSensitiveContent' in rankCtx
        ? rankCtx.showSensitiveContent
        : undefined,
    ).toBe(false);
  });
});

describe('sliceTopWindow', () => {
  const options = { enableThreadGrouping: true, enableReplyContext: false, maxSliceSize: 3 };

  it('slices only the top 2*limit+1 candidates, widening when they fold into too few slices', async () => {
    const sliceFeed = vi.mocked(threadSlicingService.sliceFeed);
    const candidates = Array.from({ length: 50 }, (_, n) => makePost(n) as never);

    sliceFeed.mockClear();
    expect(await sliceTopWindow(candidates, 5, options)).toHaveLength(11);
    expect(sliceFeed.mock.calls.map(([posts]) => posts.length)).toEqual([11]);

    // Every three candidates fold into one slice: 11 make 4, too few for a page of 5.
    sliceFeed.mockClear();
    const foldInThrees: typeof threadSlicingService.sliceFeed = async (posts) => ({
      slices: Array.from({ length: Math.ceil(posts.length / 3) }, (_, index) => ({
        _sliceKey: String(index),
        items: [],
        isIncompleteThread: false,
      })) as never,
      additionalPostIds: [],
    });
    sliceFeed.mockImplementationOnce(foldInThrees).mockImplementationOnce(foldInThrees);
    expect(await sliceTopWindow(candidates, 5, options)).toHaveLength(8);
    expect(sliceFeed.mock.calls.map(([posts]) => posts.length)).toEqual([11, 22]);
  });
});

describe('FeedEngine — persistent ranked windows', () => {
  function registerPool(sourceId: string, posts: CandidatePost[], trusted = false): void {
    for (const post of posts) sessionMemory.posts.set(post.id, post);
    registry.register({
      id: sourceId,
      kind: 'source',
      userComposable: false,
      trusted,
      gather: async (ctx, _params, cap) => {
        const excluded = new Set(ctx.seenPostIds);
        return posts.filter((post) => !excluded.has(post.id)).slice(0, cap);
      },
    });
  }
  function definition(sources: string[], cap?: number): FeedDefinition {
    return {
      id: 'session-test',
      title: 'Session',
      mode: 'ranked',
      sources: sources.map((module) => ({ module, enabled: true })),
      filters: [],
      signals: [],
      execution: { sessionPagination: true, maxDiscoveryShare: cap },
    };
  }

  it('removes revoked social-only pending posts on continuation and replay, retaining independent supply', async () => {
    sessionMemory.enabled = true;
    const posts = [scored(1, 30), scored(2, 20), scored(3, 10)];
    registerPool('friendsEngaged', posts);
    registerPool('independent', [posts[2]]);
    const def = definition(['friendsEngaged', 'independent']);
    const first = await engine.run(def, { currentUserId: 'viewer' }, { limit: 1 });
    expect(first.items.map((post) => post.id)).toEqual([posts[0].id]);
    const snapshot = sessionMemory.states.get(first.nextCursor!) as {
      pending: Array<{ id: string; socialOnly?: boolean }>;
    };
    expect(snapshot.pending.find((post) => post.id === posts[1].id)?.socialOnly).toBe(true);
    expect(snapshot.pending.find((post) => post.id === posts[2].id)?.socialOnly).toBe(false);
    revokedSocial.add(posts[1].id);
    revokedSocial.add(posts[2].id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await engine.run(
        def,
        { currentUserId: 'viewer' },
        { limit: 1, cursor: first.nextCursor },
      );
      expect(next.items.map((post) => post.id)).toEqual([posts[2].id]);
      expect(next.hasMore).toBe(false);
    }
  });

  it('continues past sixty candidates without losing diversity deferrals or repeating served ids', async () => {
    sessionMemory.enabled = true;
    const posts = Array.from({ length: 125 }, (_, n) =>
      scored(n + 1, 200 - n, { oxyUserId: `author-${Math.floor(n / 25)}` }),
    );
    registerPool('media', posts);
    const def = definition(['media']);
    let cursor: string | undefined;
    const served: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 10, cursor });
      served.push(...result.items.map((post) => post.id));
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect(served).toHaveLength(125);
    expect(new Set(served).size).toBe(125);
    expect(new Set(served)).toEqual(new Set(posts.map((post) => post.id)));
  });

  it('enforces the discovery share using trusted candidates below the score window', async () => {
    sessionMemory.enabled = true;
    registerPool(
      'discovery',
      Array.from({ length: 30 }, (_, n) => scored(n + 1, 100 - n)),
    );
    registerPool(
      'trusted',
      Array.from({ length: 15 }, (_, n) => scored(n + 101, 1)),
      true,
    );
    const def = definition(['trusted', 'discovery'], 0.7);
    const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 10 });
    const trustedIds = new Set(Array.from({ length: 15 }, (_, n) => id(n + 101)));
    expect(result.items).toHaveLength(10);
    expect(result.items.filter((post) => trustedIds.has(post.id))).toHaveLength(3);
    const continuation = sessionMemory.states.get(result.nextCursor!) as {
      pending: Array<{ id: string }>;
    };
    expect(continuation.pending.some((post) => post.id === id(8))).toBe(true);
    expect(JSON.stringify(continuation)).not.toContain('variants');
  });

  it('prioritizes author diversity when a trusted floor cannot be met without six posts by one author', async () => {
    const trusted = Array.from({ length: 30 }, (_, n) =>
      scored(n + 1, 100, { oxyUserId: 'one-author' }),
    );
    const discovery = Array.from({ length: 30 }, (_, n) =>
      scored(n + 101, 1, { _discovery: true }),
    );
    const selected = selectRankedPage(
      [...trusted, ...discovery],
      (p) => p.oxyUserId,
      (p) => p._discovery === true,
      20,
      0.7,
    );
    expect(selected).toHaveLength(20);
    expect(selected.filter((p) => p.oxyUserId === 'one-author')).toHaveLength(3);
    expect(selected.filter((p) => p._discovery)).toHaveLength(17);
    expect(selected.every((p, i) => i === 0 || p.oxyUserId !== selected[i - 1].oxyUserId)).toBe(
      true,
    );
  });

  it('pins the seen penalty when a page is retried after another request marks posts as served', async () => {
    sessionMemory.enabled = true;
    registerPool(
      'source',
      Array.from({ length: 50 }, (_, n) => scored(n + 1, 100 - n)),
    );
    const def = definition(['source']);
    def.execution = { ...def.execution, seenPosts: true };
    const first = await engine.run(def, { currentUserId: 'viewer' }, { limit: 10 });
    const second = await engine.run(
      def,
      { currentUserId: 'viewer' },
      { limit: 10, cursor: first.nextCursor },
    );
    vi.mocked(feedSeenPostsService.getSeenPostIds).mockResolvedValueOnce(
      second.items.map((p) => p.id),
    );
    const retry = await engine.run(
      def,
      { currentUserId: 'viewer' },
      { limit: 10, cursor: first.nextCursor },
    );
    expect(retry.items.map((p) => p.id)).toEqual(second.items.map((p) => p.id));
    expect(rankPosts.mock.calls.at(-1)?.[2]).toMatchObject({ seenPostIds: [] });
  });

  it.each(['for_you', 'explore'])(
    'excludes bare numbers from %s recommendations even from a trusted followed source',
    async (feedId) => {
      sessionMemory.enabled = true;
      const bare = scored(1, 100, { content: { variants: [{ source: 'author', text: '3' }] } });
      const useful = scored(2, 0, {
        content: {
          variants: [{ source: 'author', text: 'PHP security warning https://www.php.net/' }],
        },
      });
      registerPool('trusted', [bare, useful], true);
      const def = { ...definition(['trusted']), id: feedId };
      const result = await engine.run(
        def,
        { currentUserId: 'viewer', followingIds: [bare.oxyUserId] },
        { limit: 10 },
      );
      expect(result.items.map((p) => p.id)).toEqual([useful.id]);
      const following = await engine.run(
        { ...def, id: 'following' },
        { currentUserId: 'viewer' },
        { limit: 10 },
      );
      expect(following.items.map((p) => p.id)).toContain(bare.id);
    },
  );

  it('continues through a full intermediate source window already delivered by another source', async () => {
    sessionMemory.enabled = true;
    const posts = Array.from({ length: 30 }, (_, n) => scored(n + 1, 100 - n));
    for (const post of posts) sessionMemory.posts.set(post.id, post);
    let reads = 0;
    registry.register({
      id: 'overlapping',
      kind: 'source',
      userComposable: false,
      gather: async () => {
        reads += 1;
        if (reads === 1) return posts.slice(0, 10);
        if (reads === 2) return posts.slice(10, 20);
        if (reads === 3) return posts.slice(0, 10); // Full overlap, but a different source boundary.
        if (reads === 4) return posts.slice(20, 30);
        return [];
      },
    });
    const def = definition(['overlapping']);
    const served: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const result = await engine.run(def, { currentUserId: 'viewer' }, { limit: 10, cursor });
      served.push(...result.items.map((p) => p.id));
      if (!result.hasMore) break;
      cursor = result.nextCursor;
    }
    expect(new Set(served)).toEqual(new Set(posts.map((p) => p.id)));
    expect(served).toHaveLength(30);
  });

  it('applies the numeric rule to anonymous popular fallback as well as ranked sources', async () => {
    const bare = scored(1, 100, { content: { variants: [{ source: 'author', text: '3' }] } });
    const useful = scored(2, 0);
    registry.register(sourceReturning('popular', [bare, useful]));
    const def = { ...definition([]), id: 'for_you', execution: { popularFallback: 'popular' } };
    const result = await engine.run(def, {}, { limit: 10 });
    expect(result.items.map((p) => p.id)).toEqual([useful.id]);
  });

  it('keeps a transiently failing source resumable while another source serves content', async () => {
    sessionMemory.enabled = true;
    registerPool(
      'healthy',
      Array.from({ length: 30 }, (_, n) => scored(n + 1, 100 - n)),
    );
    const recovering = scored(200, 300);
    sessionMemory.posts.set(recovering.id, recovering);
    let unavailable = true;
    registry.register({
      id: 'transient',
      kind: 'source',
      userComposable: false,
      gather: async (ctx) => {
        if (unavailable) throw new Error('temporary timeout');
        return ctx.seenPostIds?.includes(recovering.id) ? [] : [recovering];
      },
    });
    const def = definition(['healthy', 'transient']);
    const first = await engine.run(def, { currentUserId: 'viewer' }, { limit: 10 });
    expect(first.items).toHaveLength(10);
    unavailable = false;
    const second = await engine.run(
      def,
      { currentUserId: 'viewer' },
      { limit: 10, cursor: first.nextCursor },
    );
    expect(second.items.map((post) => post.id)).toContain(recovering.id);
  });

  it('revalidates deleted and newly filtered pending records and rejects cross-viewer cursors', async () => {
    sessionMemory.enabled = true;
    const posts = Array.from({ length: 30 }, (_, n) => scored(n + 1, 100 - n));
    registerPool('source', posts);
    registry.register({
      id: 'safe',
      kind: 'filter',
      keep: (post) => !post.hashtags.includes('hidden'),
    });
    const def = definition(['source']);
    def.filters = [{ module: 'safe', enabled: true }];
    const first = await engine.run(def, { currentUserId: 'viewer' }, { limit: 10 });
    sessionMemory.posts.delete(id(11));
    sessionMemory.posts.set(id(12), { ...posts[11], hashtags: ['hidden'] });
    sessionMemory.posts.set(id(13), { ...posts[12], status: 'draft' });
    const second = await engine.run(
      def,
      { currentUserId: 'viewer' },
      { limit: 10, cursor: first.nextCursor },
    );
    expect(second.items.map((post) => post.id)).not.toContain(id(11));
    expect(second.items.map((post) => post.id)).not.toContain(id(12));
    expect(second.items.map((post) => post.id)).not.toContain(id(13));
    await expect(
      engine.run(def, { currentUserId: 'other-viewer' }, { limit: 10, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ statusCode: 410, code: 'FEED_CURSOR_EXPIRED' });
  });
});
