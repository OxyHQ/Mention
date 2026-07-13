import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';

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
  for (const p of posts) p.finalScore = (p._testScore as number | undefined) ?? 1;
  return posts;
});
vi.mock('../services/FeedRankingService', () => ({
  feedRankingService: { rankPosts: (...args: unknown[]) => rankPosts(...(args as Parameters<typeof rankPosts>)) },
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
      for (const p of posts) p.id = String(p._id);
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
import type { CandidatePost, FeedDefinition, FilterModule, SourceModule } from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

function makePost(n: number, extra: Record<string, unknown> = {}): CandidatePost {
  return { _id: oid(n), oxyUserId: `author-${n}`, createdAt: new Date(2020, 0, n), _testScore: 100 - n, ...extra };
}

function source(id: string, posts: CandidatePost[], trusted = false): SourceModule {
  return { id, kind: 'source', userComposable: false, trusted, gather: async () => posts };
}

/** A gate filter that rejects candidates flagged `_junk`. */
const gateFilter: FilterModule = {
  id: 'gate',
  kind: 'filter',
  keep: (post) => (post as Record<string, unknown>)._junk !== true,
};

let registry: FeedModuleRegistry;
let engine: FeedEngine;
let originalShadow: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  capturedPool = [];
  registry = new FeedModuleRegistry();
  registry.register(gateFilter);
  engine = new FeedEngine(registry);
  originalShadow = MtnConfig.feed.discoveryGate.shadow;
});

afterEach(() => {
  // Restore the real shadow flag so no test leaks its override to the next.
  Object.assign(MtnConfig.feed.discoveryGate, { shadow: originalShadow });
});

function setShadow(value: boolean): void {
  Object.assign(MtnConfig.feed.discoveryGate, { shadow: value });
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

const idsOf = (pool: Array<Record<string, unknown>>) => pool.map((p) => String(p._id));
const markOf = (pool: Array<Record<string, unknown>>, id: string) =>
  pool.find((p) => String(p._id) === id)?._discovery;

describe('lane scoping', () => {
  it('never gates a TRUSTED lane, even when the candidate would fail the gate', async () => {
    setShadow(false); // enforce
    registry.register(source('trusted', [makePost(1, { _junk: true })], true));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(def([{ module: 'trusted', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // The junk trusted post survived (not dropped) and is NOT marked `_discovery`.
    expect(idsOf(capturedPool)).toContain(oid(1).toString());
    expect(markOf(capturedPool, oid(1).toString())).toBeUndefined();
  });

  it('marks surviving DISCOVERY candidates `_discovery` and drops gated ones (enforce)', async () => {
    setShadow(false); // enforce
    registry.register(source('disc', [makePost(1), makePost(2, { _junk: true })]));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // #2 (junk) dropped; #1 kept and marked `_discovery`.
    expect(idsOf(capturedPool)).toEqual([oid(1).toString()]);
    expect(markOf(capturedPool, oid(1).toString())).toBe(true);
  });

  it('a post in BOTH a trusted and a discovery lane enters as the TRUSTED (unmarked) copy', async () => {
    setShadow(false); // enforce
    // #1 is junk but present in the trusted lane first → trusted copy wins, ungated/unmarked.
    registry.register(source('trusted', [makePost(1, { _junk: true })], true));
    registry.register(source('disc', [makePost(1, { _junk: true }), makePost(2)]));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(
      def([{ module: 'trusted', enabled: true }, { module: 'disc', enabled: true }]),
      { currentUserId: 'v' },
      { limit: 30 },
    );

    // #1 present (trusted copy, unmarked); #2 present (discovery, marked).
    expect(idsOf(capturedPool).sort()).toEqual([oid(1).toString(), oid(2).toString()].sort());
    expect(markOf(capturedPool, oid(1).toString())).toBeUndefined();
    expect(markOf(capturedPool, oid(2).toString())).toBe(true);
  });
});

describe('shadow mode', () => {
  it('KEEPS everything and still marks `_discovery` (measure, do not drop)', async () => {
    setShadow(true); // shadow
    registry.register(source('disc', [makePost(1), makePost(2, { _junk: true })]));
    registry.register(source('popular', [makePost(9)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    // Both kept (nothing dropped in shadow); both marked `_discovery`.
    expect(idsOf(capturedPool).sort()).toEqual([oid(1).toString(), oid(2).toString()].sort());
    expect(markOf(capturedPool, oid(1).toString())).toBe(true);
    expect(markOf(capturedPool, oid(2).toString())).toBe(true);
  });
});

describe('never-blank', () => {
  it('falls back to popular when enforcing empties the discovery pool', async () => {
    setShadow(false); // enforce
    registry.register(source('disc', [makePost(1, { _junk: true }), makePost(2, { _junk: true })]));
    const popularGather = vi.fn(async () => [makePost(9)]);
    registry.register({ id: 'popular', kind: 'source', userComposable: false, gather: popularGather });

    const result = await engine.run(def([{ module: 'disc', enabled: true }]), { currentUserId: 'v' }, { limit: 30 });

    expect(popularGather).toHaveBeenCalledOnce();
    expect(result.items.map((i) => i.id)).toEqual([oid(9).toString()]);
  });
});

describe('no discoveryFilters → nothing gated or marked', () => {
  it('a feed without discoveryFilters never marks `_discovery`', async () => {
    registry.register(source('disc', [makePost(1, { _junk: true })]));
    registry.register(source('popular', [makePost(9)]));
    const plain: FeedDefinition = {
      id: 'plain', title: 'Plain', mode: 'ranked',
      sources: [{ module: 'disc', enabled: true }], signals: [], filters: [],
      execution: {},
    };

    await engine.run(plain, { currentUserId: 'v' }, { limit: 30 });

    expect(idsOf(capturedPool)).toEqual([oid(1).toString()]);
    expect(markOf(capturedPool, oid(1).toString())).toBeUndefined();
  });
});
