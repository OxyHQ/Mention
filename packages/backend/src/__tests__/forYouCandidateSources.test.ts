import { describe, it, expect, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MtnConfig, PostVisibility } from '@mention/shared-types';

/**
 * Unit tests for For You multi-source candidate generation
 * (`gatherForYouCandidates`).
 *
 * The DB layer is mocked: `Post.find` is routed by inspecting the query's match
 * so each named source returns its own fixture, and `Post.aggregate` serves the
 * trending source. `ContentAffinityService` is injected as a stub. This lets us
 * assert the UNION semantics, dedup, discovery sensitive/NSFW exclusion, caps,
 * and source priority without a live MongoDB.
 */

// Capture every Post.find match so each test can route fixtures by source.
const findCalls: Array<Record<string, unknown>> = [];
let findRouter: (match: Record<string, unknown>) => unknown[] = () => [];
let aggregateRouter: () => unknown[] = () => [];

function chainableFind(result: unknown[]) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    maxTimeMS: () => chain,
    lean: () => Promise.resolve(result),
  };
  return chain;
}

vi.mock('../models/Post', () => ({
  Post: {
    find: vi.fn((match: Record<string, unknown>) => {
      findCalls.push(match);
      return chainableFind(findRouter(match));
    }),
    aggregate: vi.fn(() => ({
      option: () => Promise.resolve(aggregateRouter()),
    })),
  },
}));

import { gatherForYouCandidates, CandidateUserBehavior } from '../mtn/feed/feeds/forYouCandidateSources';
import { toRankedCandidate } from '../mtn/feed/rankedCandidate';

function candidateId(post: { _id: unknown }): string {
  return toRankedCandidate(post)?._id.toString() ?? '';
}

/** Build a lean candidate post fixture. */
function makePost(
  id: string,
  oxyUserId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: new mongoose.Types.ObjectId(id),
    oxyUserId,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    createdAt: new Date(),
    ...extra,
  };
}

/** A stub ContentAffinityService returning the configured candidate authors. */
function affinityStub(userIds: string[]) {
  return {
    getContentCandidates: vi.fn(async () =>
      userIds.map((userId) => ({ userId, weight: 1, reasons: ['engagement'] })),
    ),
  };
}

/** Extract author ids from a following/affinity/subscribed-list match. */
function authorIdsInMatch(match: Record<string, unknown>): string[] | undefined {
  const authorship = match.authorship as
    | { $elemMatch?: { oxyUserId?: { $in?: string[] } } }
    | undefined;
  return authorship?.$elemMatch?.oxyUserId?.$in;
}

/** Classify a Post.find match by which source built it. */
function sourceOf(match: Record<string, unknown>): string {
  if (match['postClassification.topics']) return 'topics';
  // The LANGUAGE source is an ANY-overlap `$in` over the multikey
  // `postClassification.languages` array (the single canonical language field).
  if (match['postClassification.languages']) return 'language';
  if (match['postClassification.region']) return 'region';
  if (authorIdsInMatch(match)) return 'authors'; // following OR affinity (disambiguated by ids)
  return 'global';
}

const oid = (n: number) => `5f${n.toString().padStart(22, '0')}`;

beforeEach(() => {
  findCalls.length = 0;
  findRouter = () => [];
  aggregateRouter = () => [];
  vi.clearAllMocks();
});

describe('gatherForYouCandidates — union semantics', () => {
  it('includes subscribed-list authors through a public-only source', async () => {
    findRouter = (match) => {
      const ids = authorIdsInMatch(match);
      if (ids?.includes('list-only')) return [makePost(oid(11), 'list-only')];
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['real-follow'],
      subscribedListMemberIds: ['viewer', 'real-follow', 'list-only'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(pool.map((p) => p.oxyUserId)).toContain('list-only');
    const listSource = findCalls.find((match) => authorIdsInMatch(match)?.includes('list-only'));
    expect(listSource).toMatchObject({
      authorship: { $elemMatch: { oxyUserId: { $in: ['list-only'] }, status: 'accepted' } },
    });
  });

  it('includes following + affinity + topic/language matches, not just global', async () => {
    const followingIds = ['follow-1'];
    const affinity = affinityStub(['affinity-1']);
    const behavior: CandidateUserBehavior = {
      preferredTopics: [{ topic: 'tech', weight: 5 }],
      preferredLanguages: ['es'],
    };

    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') {
        const ids = authorIdsInMatch(match);
        if (ids?.includes('follow-1')) return [makePost(oid(1), 'follow-1')];
        if (ids?.includes('affinity-1')) return [makePost(oid(2), 'affinity-1')];
        return [];
      }
      if (src === 'topics') return [makePost(oid(3), 'topic-author', { postClassification: { topics: ['tech'] } })];
      if (src === 'language') return [makePost(oid(4), 'lang-author', { postClassification: { languages: ['es'] } })];
      if (src === 'global') return [makePost(oid(5), 'global-author')];
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds,
      userBehavior: behavior,
      seenPostIds: [],
      contentAffinityService: affinity,
    });

    const authors = pool.map((p) => p.oxyUserId);
    expect(authors).toContain('follow-1');
    expect(authors).toContain('affinity-1');
    expect(authors).toContain('topic-author');
    expect(authors).toContain('lang-author');
    expect(authors).toContain('global-author');
  });

  it('queries the LANGUAGE source as an ANY-overlap $in over the multikey languages[]', async () => {
    findRouter = () => [];
    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: [],
      userBehavior: { preferredLanguages: ['es'] },
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const languageMatch = findCalls.find((m) => sourceOf(m) === 'language') as Record<string, unknown>;
    expect(languageMatch).toBeDefined();
    // Single canonical clause: a post matches when ANY of its languages is the
    // viewer's preferred language (a bilingual ['en','es'] post matches 'es').
    // No legacy scalar $or branch — the single `postClassification.language` is gone.
    expect(languageMatch['postClassification.languages']).toEqual({ $in: ['es'] });
    expect(languageMatch.$or).toBeUndefined();
    expect(languageMatch['postClassification.language']).toBeUndefined();
  });

  it('deduplicates a post that appears in multiple sources by _id', async () => {
    const dupId = oid(10);
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') return [makePost(dupId, 'follow-1')];
      if (src === 'global') return [makePost(dupId, 'follow-1')]; // same _id from a different source
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const ids = pool.map(candidateId);
    expect(ids.filter((id) => id === new mongoose.Types.ObjectId(dupId).toString())).toHaveLength(1);
  });
});

describe('gatherForYouCandidates — discovery safety', () => {
  it('adds sensitive exclusion to discovery sources but NOT to following/affinity', async () => {
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') return [makePost(oid(20), 'follow-1')];
      return [];
    };

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 1 }] },
      seenPostIds: [],
      contentAffinityService: affinityStub(['affinity-1']),
    });

    const hasSensitiveExclusion = (match: Record<string, unknown>): boolean => {
      const and = match.$and as Array<Record<string, unknown>> | undefined;
      return Array.isArray(and) && and.some((c) => 'postClassification.sensitive' in c);
    };

    // The author sources (following + affinity) must NOT carry the discovery
    // sensitive filter (the viewer chose those authors).
    const authorMatches = findCalls.filter((m) => sourceOf(m) === 'authors');
    expect(authorMatches.length).toBeGreaterThan(0);
    for (const m of authorMatches) expect(hasSensitiveExclusion(m)).toBe(false);

    // The discovery sources (topics, global, ...) MUST carry it.
    const discoveryMatches = findCalls.filter((m) => {
      const s = sourceOf(m);
      return s === 'topics' || s === 'global';
    });
    expect(discoveryMatches.length).toBeGreaterThan(0);
    for (const m of discoveryMatches) expect(hasSensitiveExclusion(m)).toBe(true);
  });

  it('drops NSFW-hashtag posts from EVERY source — including following (For You is uniformly SFW)', async () => {
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') {
        const ids = authorIdsInMatch(match);
        if (ids?.includes('follow-1')) {
          // Even a FOLLOWED author's NSFW-tagged post is dropped from For You.
          return [
            makePost(oid(30), 'follow-1', { hashtags: ['nsfw'] }),
            makePost(oid(32), 'follow-1', { hashtags: ['tech'] }), // clean — kept
          ];
        }
        return [];
      }
      if (src === 'global') {
        // A discovery NSFW-tagged post is dropped too.
        return [makePost(oid(31), 'global-author', { hashtags: ['NSFW'] })];
      }
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const ids = pool.map(candidateId);
    expect(ids).toContain(new mongoose.Types.ObjectId(oid(32)).toString()); // clean followed post kept
    expect(ids).not.toContain(new mongoose.Types.ObjectId(oid(30)).toString()); // followed NSFW dropped
    expect(ids).not.toContain(new mongoose.Types.ObjectId(oid(31)).toString()); // discovery NSFW dropped
  });

  it('drops classifier/metadata/federation-flagged sensitive posts from EVERY source', async () => {
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') {
        const ids = authorIdsInMatch(match);
        if (ids?.includes('follow-1')) {
          return [
            makePost(oid(40), 'follow-1', { postClassification: { sensitive: true } }),
            makePost(oid(41), 'follow-1', { metadata: { isSensitive: true } }),
            makePost(oid(42), 'follow-1', { federation: { sensitive: true } }),
            makePost(oid(43), 'follow-1', {}), // clean — kept
          ];
        }
      }
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const ids = pool.map(candidateId);
    expect(ids).toEqual([new mongoose.Types.ObjectId(oid(43)).toString()]);
  });
});

describe('gatherForYouCandidates — hard SFW (ignores showSensitiveContent)', () => {
  it('adds the discovery sensitive exclusion to discovery sources even when opted in', async () => {
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') return [makePost(oid(20), 'follow-1')];
      return [];
    };

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 1 }] },
      seenPostIds: [],
      contentAffinityService: affinityStub(['affinity-1']),
    });

    const hasSensitiveExclusion = (match: Record<string, unknown>): boolean => {
      const and = match.$and as Array<Record<string, unknown>> | undefined;
      return Array.isArray(and) && and.some((c) => 'postClassification.sensitive' in c);
    };

    const discoveryCalls = findCalls.filter((m) => sourceOf(m) !== 'authors');
    expect(discoveryCalls.length).toBeGreaterThan(0);
    for (const m of discoveryCalls) expect(hasSensitiveExclusion(m)).toBe(true);
  });

  it('drops NSFW-hashtag + flagged-sensitive posts from the merged pool even when opted in', async () => {
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') {
        const ids = authorIdsInMatch(match);
        if (ids?.includes('follow-1')) {
          return [
            makePost(oid(30), 'follow-1', { hashtags: ['nsfw'] }),
            makePost(oid(40), 'follow-1', { postClassification: { sensitive: true } }),
            makePost(oid(43), 'follow-1', {}), // clean
          ];
        }
        return [];
      }
      if (src === 'global') {
        return [makePost(oid(31), 'global-author', { hashtags: ['NSFW'] })];
      }
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const ids = pool.map(candidateId);
    expect(ids).not.toContain(new mongoose.Types.ObjectId(oid(30)).toString());
    expect(ids).not.toContain(new mongoose.Types.ObjectId(oid(40)).toString());
    expect(ids).toContain(new mongoose.Types.ObjectId(oid(43)).toString());
    expect(ids).not.toContain(new mongoose.Types.ObjectId(oid(31)).toString());
  });

  it('excludes sensitive content when showSensitiveContent is false (explicit SFW)', async () => {
    findRouter = (match) => {
      const src = sourceOf(match);
      if (src === 'authors') {
        const ids = authorIdsInMatch(match);
        if (ids?.includes('follow-1')) {
          return [
            makePost(oid(30), 'follow-1', { hashtags: ['nsfw'] }),
            makePost(oid(43), 'follow-1', {}), // clean — kept
          ];
        }
      }
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    const ids = pool.map(candidateId);
    expect(ids).not.toContain(new mongoose.Types.ObjectId(oid(30)).toString());
    expect(ids).toContain(new mongoose.Types.ObjectId(oid(43)).toString());
  });
});

describe('gatherForYouCandidates — caps and exclusions', () => {
  it('clamps the merged pool to maxPool', async () => {
    const cap = MtnConfig.feed.candidateSources.maxPool;
    // Following alone returns far more than maxPool unique posts.
    findRouter = (match) => {
      if (sourceOf(match) === 'authors') {
        const ids = authorIdsInMatch(match);
        if (ids?.includes('follow-1')) {
          return Array.from({ length: cap + 50 }, (_, i) => makePost(oid(100 + i), 'follow-1'));
        }
      }
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(pool.length).toBeLessThanOrEqual(cap);
  });

  it('excludes seen posts via $nin on every source and within the recency window', async () => {
    const seen = [oid(200)];
    findRouter = () => [];

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 1 }] },
      seenPostIds: seen,
      contentAffinityService: affinityStub([]),
    });

    expect(findCalls.length).toBeGreaterThan(0);
    for (const match of findCalls) {
      const and = match.$and as Array<Record<string, unknown>>;
      const nin = and.find((c) => {
        const id = c._id as { $nin?: unknown[] } | undefined;
        return Array.isArray(id?.$nin);
      });
      expect(nin).toBeDefined();

      const createdAt = match.createdAt as { $gte?: Date } | undefined;
      expect(createdAt?.$gte).toBeInstanceOf(Date);
    }
  });

  it('drops affinity authors that the viewer already follows (FOLLOWING covers them)', async () => {
    let affinityQueriedIds: string[] = [];
    findRouter = (match) => {
      if (sourceOf(match) === 'authors') {
        const ids = authorIdsInMatch(match);
        // The affinity query is the one that does NOT include 'follow-1' only.
        if (ids && !ids.includes('follow-1')) affinityQueriedIds = ids;
      }
      return [];
    };

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: { preferredAuthors: [{ authorId: 'follow-1', weight: 9 }, { authorId: 'aff-2', weight: 5 }] },
      seenPostIds: [],
      contentAffinityService: affinityStub(['follow-1', 'aff-3']),
    });

    // follow-1 is removed from affinity (deduped against following); aff-2/aff-3 remain.
    expect(affinityQueriedIds).not.toContain('follow-1');
    expect(affinityQueriedIds).toEqual(expect.arrayContaining(['aff-2', 'aff-3']));
  });

  it('queries no author/topic/language sources for a brand-new viewer with no signals', async () => {
    findRouter = () => [];

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: [],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    // Only the global discovery source should fire (no following, no affinity,
    // no preferred topics/language/region). Trending uses aggregate, not find.
    const sources = findCalls.map(sourceOf);
    expect(sources).toContain('global');
    expect(sources).not.toContain('authors');
    expect(sources).not.toContain('topics');
    expect(sources).not.toContain('language');
    expect(sources).not.toContain('region');
  });

  it('returns an empty pool (never throws) when every source is empty', async () => {
    findRouter = () => [];
    aggregateRouter = () => [];

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: [],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(pool).toEqual([]);
  });

  it('soft-fails a throwing source to empty without sinking the whole pool', async () => {
    findRouter = (match) => {
      if (sourceOf(match) === 'global') throw new Error('mongo blew up');
      if (sourceOf(match) === 'authors') return [makePost(oid(40), 'follow-1')];
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    // The throwing global source is skipped; the healthy following source survives.
    expect(pool.map((p) => p.oxyUserId)).toContain('follow-1');
  });
});

describe('gatherForYouCandidates — region source (viewerRegion)', () => {
  it('fires the region discovery source ONLY when viewerRegion is provided', async () => {
    findRouter = (match) => {
      if (sourceOf(match) === 'region') {
        return [makePost(oid(60), 'region-author', { postClassification: { region: 'ES' } })];
      }
      return [];
    };

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: [],
      userBehavior: {},
      viewerRegion: 'ES',
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    // The region source fired and contributed its post.
    const sources = findCalls.map(sourceOf);
    expect(sources).toContain('region');
    expect(pool.map((p) => p.oxyUserId)).toContain('region-author');

    // The region query keyed off the exact viewer region.
    const regionMatch = findCalls.find((m) => sourceOf(m) === 'region');
    expect(regionMatch?.['postClassification.region']).toBe('ES');
  });

  it('does NOT fire the region source when viewerRegion is absent (best-effort no-op)', async () => {
    findRouter = () => [];

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: ['follow-1'],
      userBehavior: { preferredTopics: [{ topic: 'tech', weight: 1 }] },
      // viewerRegion intentionally omitted — the common case (region is sparse).
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(findCalls.map(sourceOf)).not.toContain('region');
  });

  it('does NOT fire the region source for an empty-string viewerRegion', async () => {
    findRouter = () => [];

    await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: [],
      userBehavior: {},
      viewerRegion: '',
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(findCalls.map(sourceOf)).not.toContain('region');
  });
});

describe('gatherForYouCandidates — trending source', () => {
  it('contributes trending posts and excludes discovery-sensitive via aggregate match', async () => {
    aggregateRouter = () => [makePost(oid(50), 'trending-author')];
    findRouter = () => [];

    const pool = await gatherForYouCandidates({
      viewerId: 'viewer',
      followingIds: [],
      userBehavior: {},
      seenPostIds: [],
      contentAffinityService: affinityStub([]),
    });

    expect(pool.map((p) => p.oxyUserId)).toContain('trending-author');
  });
});
