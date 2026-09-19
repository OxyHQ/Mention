import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * PHASE 4a DISCOVERY-GATE LANE-SCOPING in the FeedEngine.
 *
 * Asserts the engine only applies `definition.discoveryFilters` to candidates
 * from NON-trusted sources, stamps the opaque `_discovery` marker on the ones that
 * survive, never gates trusted lanes, honors shadow vs enforce mode, and still
 * falls back to popular when the gate empties the pool (never-blank). Heavy
 * collaborators are faked (no DB / Redis / Oxy); the rankPosts mock captures the
 * merged pool so the `_discovery` marks are observable.
 */

let capturedPool: Array<Record<string, unknown>> = [];
const rankPosts = vi.fn(async (posts: Array<Record<string, unknown>>) => {
  capturedPool = posts;
  for (const p of posts) p.finalScore = 1;
  return posts;
});
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (...args: unknown[]) => rankPosts(...(args as Parameters<typeof rankPosts>)) },
}));

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

/**
 * Hoisted so the author-aware tests can assert on it — the engine's author batch
 * goes through here, and "was it called, and how many times" is the whole point
 * of resolving the pool once.
 */
const { resolveUserSummaries } = vi.hoisted(() => ({
  resolveUserSummaries: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { user: { id, name: {} } }]))),
}));

vi.mock('../services/PostHydrationService', () => ({
  postHydrationService: {
    hydrateSlices: vi.fn(async (slices: unknown[]) => slices),
    hydratePosts: vi.fn(async (posts: unknown[]) => posts),
  },
  resolveUserSummaries,
}));

vi.mock('../services/FeedSeenPostsService', () => ({
  feedSeenPostsService: {
    getSeenPostIds: vi.fn(async () => []),
    markPostsAsSeen: vi.fn(async () => undefined),
  },
}));

import { FeedEngine } from '../mtn/feed/engine/FeedEngine';
import { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';
import type { CandidatePost, FeedDefinition, FilterModule, SourceModule } from '../mtn/feed/engine/types';
import { feedCandidate } from './fixtures/feedCandidate';

/** A pre-cutover ObjectId-hex id — see `feedEngine.test.ts` on why not `post-N`. */
const id = (n: number) => `5f${n.toString().padStart(22, '0')}`;

/** The hashtag the fake gate filter rejects — a REAL field, not a private marker. */
const JUNK_TAG = 'gatejunk';

function makePost(n: number, overrides: Partial<CandidatePost> = {}): CandidatePost {
  return feedCandidate({
    id: id(n),
    oxyUserId: `author-${n}`,
    createdAt: new Date(2020, 0, n),
    // The axis the popular sources sort on, and the one their cursor is minted
    // from. A real candidate from those sources always carries it; without it the
    // fallback cannot mint a cursor at all, which would make the pagination
    // assertions below silently vacuous.
    engagementScore: 100 - n,
    ...overrides,
  });
}

/** A candidate the fake gate filter rejects. */
function junkPost(n: number, overrides: Partial<CandidatePost> = {}): CandidatePost {
  return makePost(n, { hashtags: [JUNK_TAG], ...overrides });
}

function source(id: string, posts: CandidatePost[], trusted = false): SourceModule {
  return { id, kind: 'source', userComposable: false, trusted, gather: async () => posts };
}

/** A gate filter that rejects candidates tagged as junk. */
const gateFilter: FilterModule = {
  id: 'gate',
  kind: 'filter',
  keep: (post) => !post.hashtags.includes(JUNK_TAG),
};

let registry: FeedModuleRegistry;
let engine: FeedEngine;
let originalRollout: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resolveUserSummaries.mockImplementation(
    async (ids: string[]) => new Map(ids.map((id) => [id, { user: { id, name: {} } }])),
  );
  capturedPool = [];
  registry = new FeedModuleRegistry();
  registry.register(gateFilter);
  engine = new FeedEngine(registry);
  originalRollout = process.env.DISCOVERY_GATE_ROLLOUT;
});

afterEach(() => {
  if (originalRollout === undefined) delete process.env.DISCOVERY_GATE_ROLLOUT;
  else process.env.DISCOVERY_GATE_ROLLOUT = originalRollout;
});

function setShadow(value: boolean): void {
  process.env.DISCOVERY_GATE_ROLLOUT = value ? 'shadow' : 'enforce';
}

function def(sources: FeedDefinition['sources']): FeedDefinition {
  return {
    id: 'for_you',
    title: 'For You',
    mode: 'ranked',
    sources,
    signals: [],
    filters: [],
    discoveryFilters: [{ module: 'gate', enabled: true }],
    execution: { neverBlank: true, popularFallback: 'popular' },
  };
}

const idsOf = (pool: Array<Record<string, unknown>>) => pool.map((p) => String(p.id));
const markOf = (pool: Array<Record<string, unknown>>, postId: string) =>
  pool.find((p) => String(p.id) === postId)?._discovery;

describe('lane scoping', () => {
  it('never gates a TRUSTED lane, even when the candidate would fail the gate', async () => {
    setShadow(false); // enforce
    registry.register(source('trusted', [junkPost(1)], true));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(def([{ module: 'trusted', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // The junk trusted post survived (not dropped) and is NOT marked `_discovery`.
    expect(idsOf(capturedPool)).toContain(id(1));
    expect(markOf(capturedPool, id(1))).toBeUndefined();
  });

  it('marks surviving DISCOVERY candidates `_discovery` and drops gated ones (enforce)', async () => {
    setShadow(false); // enforce
    registry.register(source('disc', [makePost(1), junkPost(2)]));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // #2 (junk) dropped; #1 kept and marked `_discovery`.
    expect(idsOf(capturedPool)).toEqual([id(1)]);
    expect(markOf(capturedPool, id(1))).toBe(true);
  });

  it('a post in BOTH a trusted and a discovery lane enters as the TRUSTED (unmarked) copy', async () => {
    setShadow(false); // enforce
    // #1 is junk but present in the trusted lane first → trusted copy wins, ungated/unmarked.
    registry.register(source('trusted', [junkPost(1)], true));
    registry.register(source('disc', [junkPost(1), makePost(2)]));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(
      def([{ module: 'trusted', enabled: true }, { module: 'disc', enabled: true }]),
      { currentUserId: 'v' },
      { limit: 30 },
    );

    // #1 present (trusted copy, unmarked); #2 present (discovery, marked).
    expect(idsOf(capturedPool).sort()).toEqual([id(1), id(2)].sort());
    expect(markOf(capturedPool, id(1))).toBeUndefined();
    expect(markOf(capturedPool, id(2))).toBe(true);
  });
});

describe('shadow mode', () => {
  it('KEEPS everything and still marks `_discovery` (measure, do not drop)', async () => {
    setShadow(true); // shadow
    registry.register(source('disc', [makePost(1), junkPost(2)]));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // Both kept (nothing dropped in shadow); both marked `_discovery`.
    expect(idsOf(capturedPool).sort()).toEqual([id(1), id(2)].sort());
    expect(markOf(capturedPool, id(1))).toBe(true);
    expect(markOf(capturedPool, id(2))).toBe(true);
  });
});

describe('never-blank', () => {
  it('falls back to popular when enforcing empties the discovery pool', async () => {
    setShadow(false); // enforce
    registry.register(source('disc', [junkPost(1), junkPost(2)]));
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: popularGather });

    const result = await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    expect(popularGather).toHaveBeenCalledOnce();
    expect(result.items.map((i) => i.id)).toEqual([id(9)]);
  });
});

describe('no discoveryFilters → nothing gated or marked', () => {
  it('a feed without discoveryFilters never marks `_discovery`', async () => {
    registry.register(source('disc', [junkPost(1)]));
    registry.register(source('popular', [makePost(9)]));
    const plain: FeedDefinition = {
      id: 'plain', title: 'Plain', mode: 'ranked',
      sources: [{ module: 'disc', enabled: true }], signals: [], filters: [],
      execution: {},
    };

    await engine.run(plain, { currentUserId: 'v' }, { limit: 30 });

    expect(idsOf(capturedPool)).toEqual([id(1)]);
    expect(markOf(capturedPool, id(1))).toBeUndefined();
  });
});

/**
 * AUTHOR-AWARE GATE FILTERS.
 *
 * A filter that declares `needsAuthor` is judged in a SECOND pass, after the
 * engine resolves the merged pool's authors in one batch. The two things worth
 * pinning down are that the batch is paid for once and only when something asks
 * for it, and that not knowing keeps the candidate.
 */
describe('author-aware gate filters', () => {
  /** Rejects any author the resolution did not answer for — the unsafe shape, on purpose. */
  const strictAuthorFilter: FilterModule = {
    id: 'authorGate',
    kind: 'filter',
    needsAuthor: true,
    keep: (post, ctx) => ctx.authorSummaries?.get(post.oxyUserId ?? '') !== undefined,
  };

  function authorDef(sources: FeedDefinition['sources']): FeedDefinition {
    return {
      id: 'for_you', title: 'For You', mode: 'ranked', sources, signals: [], filters: [],
      discoveryFilters: [{ module: 'authorGate', enabled: true }],
      execution: {},
    };
  }

  beforeEach(() => {
    registry.register(strictAuthorFilter);
  });

  it('resolves the pool’s authors exactly once, and hands them to ranking', async () => {
    setShadow(true); // measure-only: nothing is dropped, so the pool is observable
    registry.register(source('disc', [makePost(1), makePost(2)]));

    await engine.run(authorDef([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // ONE batch for the merged pool. `rankPosts` would otherwise resolve the same
    // author set a step later, which is the round trip this is here to prevent.
    expect(resolveUserSummaries).toHaveBeenCalledTimes(1);
    expect(resolveUserSummaries).toHaveBeenCalledWith(['author-1', 'author-2']);
    expect((rankPosts.mock.calls[0] as unknown[])[2]).toHaveProperty('authorSummaries');
  });

  it('never resolves authors for a gate that does not ask about them', async () => {
    registry.register(source('disc', [makePost(1)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('KEEPS every candidate when author resolution fails — an outage is not a verdict', async () => {
    setShadow(false); // enforce: a rejection here really would drop the post
    resolveUserSummaries.mockRejectedValueOnce(new Error('redis is gone'));
    registry.register(source('disc', [makePost(1), makePost(2)]));

    const result = await engine.run(
      authorDef([{ module: 'disc', enabled: true }]),
      { currentUserId: 'v' },
      { limit: 30 },
    );

    // `strictAuthorFilter` rejects on an absent entry, so an empty map would have
    // emptied this feed. It does not, because the engine leaves `authorSummaries`
    // undefined on failure and the filter is written to read that as unknown.
    expect(idsOf(capturedPool)).toEqual([id(1), id(2)]);
    expect(result.slices.length).toBeGreaterThan(0);
  });

  it('does not gate a TRUSTED lane, so its authors are never judged', async () => {
    setShadow(false);
    registry.register(source('followed', [makePost(1)], true));

    await engine.run(
      authorDef([{ module: 'followed', enabled: true }]),
      { currentUserId: 'v' },
      { limit: 30 },
    );

    expect(idsOf(capturedPool)).toEqual([id(1)]);
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });
});

/**
 * THE POPULAR FALLBACK — the one path that never passes through `gatherPool`.
 *
 * It is what an anonymous reader sees and what a reader who outran their own pool
 * sees, so it is a recommendation like any other and answers to the same gate.
 * What is specific to it is the SHAPE of the filtering: it scans to fill rather
 * than filtering a window already cut to the page, or a gate that rejects would
 * turn into short pages that look like the end of the feed.
 */
describe('popular fallback — the gate applies there too', () => {
  function fallbackDef(): FeedDefinition {
    return {
      id: 'for_you', title: 'For You', mode: 'ranked',
      sources: [{ module: 'disc', enabled: true }],
      signals: [], filters: [],
      discoveryFilters: [{ module: 'gate', enabled: true }],
      execution: { neverBlank: true, popularFallback: 'popular' },
    };
  }

  it('drops gated candidates from the ANONYMOUS fallback page', async () => {
    setShadow(false); // enforce
    registry.register(source('disc', []));
    registry.register(source('popular', [junkPost(1), makePost(2), junkPost(3), makePost(4)]));

    const result = await engine.run(fallbackDef(), {}, { limit: 10 });

    expect(result.items.map((i) => i.id)).toEqual([id(2), id(4)]);
  });

  it('SCANS to fill, so a rejection backfills instead of shortening the page', async () => {
    setShadow(false);
    registry.register(source('disc', []));
    // The first two are junk. A fixed window of `limit` would have served ONE
    // post; scanning reaches past them for the two clean ones.
    registry.register(source('popular', [junkPost(1), junkPost(2), makePost(3), makePost(4), makePost(5)]));

    const result = await engine.run(fallbackDef(), {}, { limit: 2 });

    expect(result.items.map((i) => i.id)).toEqual([id(3), id(4)]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeDefined();
  });

  it('still reports more when the gate consumed the whole fetched window', async () => {
    setShadow(false);
    registry.register(source('disc', []));
    // Everything the source returned was rejected. The page is empty, but the
    // source was not exhausted — saying otherwise would dead-end the reader at a
    // run of junk with no cursor to get past it.
    registry.register(source('popular', [junkPost(1), junkPost(2), junkPost(3), junkPost(4)]));

    const result = await engine.run(fallbackDef(), {}, { limit: 2 });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(true);
  });

  it('drops nothing in shadow mode, on this path as on the other one', async () => {
    setShadow(true);
    registry.register(source('disc', []));
    registry.register(source('popular', [junkPost(1), makePost(2)]));

    const result = await engine.run(fallbackDef(), {}, { limit: 10 });

    expect(result.items.map((i) => i.id)).toEqual([id(1), id(2)]);
  });
});
