import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MtnConfig } from '@mention/shared-types';

/**
 * PHASE 7 — discovery-gate ONLINE metrics + A/B enforcement in the FeedEngine.
 *
 * Asserts the engine emits `feed_discovery_gated_total{reason,source,shadow}` for
 * each gate rejection (with the correct `shadow` semantics in enforce vs shadow vs
 * A/B modes), emits `feed_federated_share{descriptor}` from the merged pool, and
 * that the A/B `gate-off` bucket forces measure-only (nothing dropped) while
 * `gate-on` enforces. Heavy collaborators are faked (no DB / Redis / Oxy).
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
import { metrics } from '../utils/metrics';
import { FEED_METRICS } from '../mtn/feed/feedMetrics';
import type {
  CandidatePost,
  DiscoveryGateBucket,
  FeedDefinition,
  FeedEngineContext,
  FilterModule,
  SourceModule,
} from '../mtn/feed/engine/types';

const oid = (n: number) => new mongoose.Types.ObjectId(`5f${n.toString().padStart(22, '0')}`);

function makePost(n: number, extra: Record<string, unknown> = {}): CandidatePost {
  return { _id: oid(n), oxyUserId: `author-${n}`, createdAt: new Date(2020, 0, n), ...extra };
}

function source(id: string, posts: CandidatePost[], trusted = false): SourceModule {
  return { id, kind: 'source', userComposable: false, trusted, gather: async () => posts };
}

/** Gate filter (id `gate`) that rejects candidates flagged `_junk`. */
const gateFilter: FilterModule = {
  id: 'gate',
  kind: 'filter',
  keep: (post) => (post as Record<string, unknown>)._junk !== true,
};

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

let registry: FeedModuleRegistry;
let engine: FeedEngine;
let originalShadow: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  capturedPool = [];
  metrics.reset();
  registry = new FeedModuleRegistry();
  registry.register(gateFilter);
  registry.register(source('popular', [makePost(9)]));
  engine = new FeedEngine(registry);
  originalShadow = MtnConfig.feed.discoveryGate.shadow;
});

afterEach(() => {
  Object.assign(MtnConfig.feed.discoveryGate, { shadow: originalShadow });
});

function setShadow(value: boolean): void {
  Object.assign(MtnConfig.feed.discoveryGate, { shadow: value });
}

function ctx(bucket?: DiscoveryGateBucket): FeedEngineContext {
  return { currentUserId: 'v', discoveryGateBucket: bucket };
}

const idsOf = () => capturedPool.map((p) => String(p._id));

describe('feed_discovery_gated_total', () => {
  it('counts a rejection with reason=filter-id, source=lane, shadow=false when enforcing', async () => {
    setShadow(false);
    registry.register(source('disc', [makePost(1, { _junk: true }), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx(), { limit: 30 });

    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'false' })).toBe(1);
    // Enforced: the junk candidate was dropped.
    expect(idsOf()).not.toContain(oid(1).toString());
  });

  it('counts with shadow=true and drops nothing in global shadow mode', async () => {
    setShadow(true);
    registry.register(source('disc', [makePost(1, { _junk: true }), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx(), { limit: 30 });

    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'true' })).toBe(1);
    expect(idsOf()).toContain(oid(1).toString()); // measure-only: kept
  });

  it('never counts or gates a TRUSTED lane', async () => {
    setShadow(false);
    registry.register(source('trusted', [makePost(1, { _junk: true })], true));

    await engine.run(def([{ module: 'trusted', enabled: true }]), ctx(), { limit: 30 });

    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'trusted', shadow: 'false' })).toBe(0);
    expect(idsOf()).toContain(oid(1).toString());
  });
});

describe('A/B enforcement via ctx.discoveryGateBucket', () => {
  it('gate-off forces measure-only (kept, shadow=true) even when config enforces', async () => {
    setShadow(false); // config would enforce
    registry.register(source('disc', [makePost(1, { _junk: true }), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx('gate-off'), { limit: 30 });

    expect(idsOf()).toContain(oid(1).toString()); // not dropped
    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'true' })).toBe(1);
  });

  it('gate-on enforces (dropped, shadow=false)', async () => {
    setShadow(false);
    registry.register(source('disc', [makePost(1, { _junk: true }), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx('gate-on'), { limit: 30 });

    expect(idsOf()).not.toContain(oid(1).toString()); // dropped
    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'false' })).toBe(1);
  });
});

describe('feed_pool_candidates_total', () => {
  it('counts the merged pool by origin under the base descriptor', async () => {
    setShadow(true);
    registry.register(source('disc', [
      makePost(1, { federation: { actorUri: 'https://remote/users/a' } }),
      makePost(2), // local
    ]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx(), { limit: 30 });

    // pool = [#1 federated, #2 local] → federated share 0.5, derived from the counters.
    const federated = metrics.getCounter(FEED_METRICS.poolCandidates, { descriptor: 'for_you', origin: 'federated' });
    const local = metrics.getCounter(FEED_METRICS.poolCandidates, { descriptor: 'for_you', origin: 'local' });
    expect(federated).toBe(1);
    expect(local).toBe(1);
    expect(federated / (federated + local)).toBeCloseTo(0.5, 5);
  });

  it('accumulates across requests so the derived share stays correct', async () => {
    setShadow(true);
    registry.register(source('disc', [
      makePost(1, { federation: { actorUri: 'https://remote/users/a' } }),
      makePost(2), // local
      makePost(3), // local
    ]));

    const definition = def([{ module: 'disc', enabled: true }]);
    await engine.run(definition, ctx(), { limit: 30 });
    await engine.run(definition, ctx(), { limit: 30 });

    const federated = metrics.getCounter(FEED_METRICS.poolCandidates, { descriptor: 'for_you', origin: 'federated' });
    const local = metrics.getCounter(FEED_METRICS.poolCandidates, { descriptor: 'for_you', origin: 'local' });
    expect(federated).toBe(2);
    expect(local).toBe(4);
    expect(federated / (federated + local)).toBeCloseTo(1 / 3, 5);
  });
});
