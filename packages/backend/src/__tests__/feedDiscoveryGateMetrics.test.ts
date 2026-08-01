import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        _sliceKey: String(post.id),
        items: [{ post, isThreadParent: false, isThreadChild: false, isThreadLastChild: false }],
        isIncompleteThread: false,
      })),
      additionalPostIds: [],
    })),
  },
}));
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

/** Gate filter (id `gate`) that rejects junk-tagged candidates. */
const gateFilter: FilterModule = {
  id: 'gate',
  kind: 'filter',
  keep: (post) => !post.hashtags.includes(JUNK_TAG),
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

const idsOf = () => capturedPool.map((p) => String(p.id));

describe('feed_discovery_gated_total', () => {
  it('counts a rejection with reason=filter-id, source=lane, shadow=false when enforcing', async () => {
    setShadow(false);
    registry.register(source('disc', [junkPost(1), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx(), { limit: 30 });

    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'false' })).toBe(1);
    // Enforced: the junk candidate was dropped.
    expect(idsOf()).not.toContain(id(1));
  });

  it('counts with shadow=true and drops nothing in global shadow mode', async () => {
    setShadow(true);
    registry.register(source('disc', [junkPost(1), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx(), { limit: 30 });

    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'true' })).toBe(1);
    expect(idsOf()).toContain(id(1)); // measure-only: kept
  });

  it('never counts or gates a TRUSTED lane', async () => {
    setShadow(false);
    registry.register(source('trusted', [junkPost(1)], true));

    await engine.run(def([{ module: 'trusted', enabled: true }]), ctx(), { limit: 30 });

    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'trusted', shadow: 'false' })).toBe(0);
    expect(idsOf()).toContain(id(1));
  });
});

describe('A/B enforcement via ctx.discoveryGateBucket', () => {
  it('gate-off forces measure-only (kept, shadow=true) even when config enforces', async () => {
    setShadow(false); // config would enforce
    registry.register(source('disc', [junkPost(1), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx('gate-off'), { limit: 30 });

    expect(idsOf()).toContain(id(1)); // not dropped
    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'true' })).toBe(1);
  });

  it('gate-on enforces (dropped, shadow=false)', async () => {
    setShadow(false);
    registry.register(source('disc', [junkPost(1), makePost(2)]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx('gate-on'), { limit: 30 });

    expect(idsOf()).not.toContain(id(1)); // dropped
    expect(metrics.getCounter(FEED_METRICS.discoveryGated, { reason: 'gate', source: 'disc', shadow: 'false' })).toBe(1);
  });
});

describe('feed_federated_share', () => {
  it('records the federated share of the merged pool by base descriptor', async () => {
    setShadow(true);
    registry.register(source('disc', [
      makePost(1, { federation: { actorUri: 'https://remote/users/a' } }),
      makePost(2), // local
    ]));

    await engine.run(def([{ module: 'disc', enabled: true }]), ctx(), { limit: 30 });

    // pool = [#1 federated, #2 local] → share 0.5.
    expect(metrics.getGauge(FEED_METRICS.federatedShare, { descriptor: 'for_you' })).toBeCloseTo(0.5, 5);
  });
});
