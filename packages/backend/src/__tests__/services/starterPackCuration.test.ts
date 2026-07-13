import { describe, it, expect, vi } from 'vitest';
import { MtnConfig } from '@mention/shared-types';

/**
 * STARTER-PACK CURATION POLICY — the anti-gaming rules are the whole point of this
 * signal, so each one is locked in here against the PURE policy function
 * (`computeStarterPackScores`), driven through MOCKED accessors:
 *
 *   1. self-owned packs are excluded  — otherwise anyone self-boosts;
 *   2. only crowd-validated packs count (`useCount >= minUseCount`);
 *   3. dedupe by CURATOR, not by pack — 50 packs by one curator count ONCE;
 *   4. everything is bounded (curator count, score, and — in the signal — the
 *      multiplier), and log-scaled, so a low-follower ring earns almost nothing;
 *   5. absence of curation is exactly neutral (no score at all → multiplier 1.0).
 *
 * Plus the batching contract (ONE aggregation for N authors) and fail-softness (an
 * accessor that throws degrades to no scores, never to an error).
 */

import {
  buildCurationPipeline,
  computeStarterPackScores,
  curatorAuthority,
  packWeight,
  type CurationEdge,
  type StarterPackCurationDeps,
} from '../../services/starterPackCuration';

const CURATION = MtnConfig.ranking.optInSignals.starterPackBoost;

/** Deps whose accessors are vitest mocks, so call counts can be asserted. */
function mockDeps(
  edges: CurationEdge[],
  followerCounts: Map<string, number> = new Map(),
): StarterPackCurationDeps & {
  loadCurationEdges: ReturnType<typeof vi.fn>;
  loadCuratorFollowerCounts: ReturnType<typeof vi.fn>;
} {
  return {
    loadCurationEdges: vi.fn().mockResolvedValue(edges),
    loadCuratorFollowerCounts: vi.fn().mockResolvedValue(followerCounts),
  };
}

/** The score a single pack contributes, computed from the documented formula. */
function expectedWeight(useCount: number, curatorFollowers?: number): number {
  return Math.log1p(useCount) * curatorAuthority(curatorFollowers);
}

describe('curatorAuthority', () => {
  it('is the NEUTRAL floor for an unknown follower count (never a penalty)', () => {
    expect(curatorAuthority(undefined)).toBe(CURATION.curatorAuthority.min);
    expect(curatorAuthority(Number.NaN)).toBe(CURATION.curatorAuthority.min);
    expect(curatorAuthority(-5)).toBe(CURATION.curatorAuthority.min);
  });

  it('is the floor for a zero-follower curator and grows with log(followers)', () => {
    expect(curatorAuthority(0)).toBe(CURATION.curatorAuthority.min);
    expect(curatorAuthority(1_000)).toBeGreaterThan(curatorAuthority(10));
    expect(curatorAuthority(10)).toBeGreaterThan(curatorAuthority(0));
  });

  it('is CLAMPED at the ceiling for a mega-account curator', () => {
    expect(curatorAuthority(50_000_000)).toBe(CURATION.curatorAuthority.max);
  });
});

describe('computeStarterPackScores — anti-gaming rules', () => {
  it('RULE 1: excludes SELF-OWNED packs (an author cannot curate themselves)', async () => {
    const deps = mockDeps([
      { authorId: 'author-1', curatorId: 'author-1', useCount: 500 },
    ]);

    const scores = await computeStarterPackScores(['author-1'], deps);

    expect(scores.has('author-1')).toBe(false);
  });

  it('RULE 1: a self-owned pack does not inflate a genuine curator\'s contribution', async () => {
    const selfOnly = await computeStarterPackScores(
      ['author-1'],
      mockDeps([
        { authorId: 'author-1', curatorId: 'curator-1', useCount: 4 },
        { authorId: 'author-1', curatorId: 'author-1', useCount: 999 },
      ]),
    );
    const curatorOnly = await computeStarterPackScores(
      ['author-1'],
      mockDeps([{ authorId: 'author-1', curatorId: 'curator-1', useCount: 4 }]),
    );

    expect(selfOnly.get('author-1')).toBe(curatorOnly.get('author-1'));
  });

  it('RULE 2: excludes packs nobody ever used (useCount below minUseCount)', async () => {
    const deps = mockDeps([
      { authorId: 'author-1', curatorId: 'curator-1', useCount: 0 },
      { authorId: 'author-2', curatorId: 'curator-1', useCount: CURATION.minUseCount },
    ]);

    const scores = await computeStarterPackScores(['author-1', 'author-2'], deps);

    expect(scores.has('author-1')).toBe(false);
    expect(scores.get('author-2')).toBeCloseTo(expectedWeight(CURATION.minUseCount), 10);
  });

  it('RULE 3: DEDUPES BY CURATOR — one curator with many packs counts ONCE (their best)', async () => {
    const spammedPacks: CurationEdge[] = Array.from({ length: 50 }, (_, index) => ({
      authorId: 'author-1',
      curatorId: 'curator-1',
      useCount: index + 1, // best pack = useCount 50
    }));

    const scores = await computeStarterPackScores(['author-1'], mockDeps(spammedPacks));

    // Exactly ONE curator's BEST pack — not the sum of fifty.
    expect(scores.get('author-1')).toBeCloseTo(expectedWeight(50), 10);
  });

  it('RULE 3: distinct curators DO each contribute (dedupe is per curator, not global)', async () => {
    const one = await computeStarterPackScores(
      ['author-1'],
      mockDeps([{ authorId: 'author-1', curatorId: 'curator-1', useCount: 3 }]),
    );
    const two = await computeStarterPackScores(
      ['author-1'],
      mockDeps([
        { authorId: 'author-1', curatorId: 'curator-1', useCount: 3 },
        { authorId: 'author-1', curatorId: 'curator-2', useCount: 3 },
      ]),
    );

    expect(two.get('author-1')).toBeCloseTo(2 * expectedWeight(3), 10);
    expect(two.get('author-1') ?? 0).toBeGreaterThan(one.get('author-1') ?? 0);
  });

  it('RULE 4: counts at most `maxCuratorsPerAuthor` distinct curators, highest-weight first', async () => {
    const curatorCount = CURATION.maxCuratorsPerAuthor + 5;
    const edges: CurationEdge[] = Array.from({ length: curatorCount }, (_, index) => ({
      authorId: 'author-1',
      curatorId: `curator-${index}`,
      useCount: index + 1, // the top `maxCuratorsPerAuthor` are the HIGHEST useCounts
    }));

    const scores = await computeStarterPackScores(['author-1'], mockDeps(edges));

    const topUseCounts = Array.from(
      { length: CURATION.maxCuratorsPerAuthor },
      (_, i) => curatorCount - i,
    );
    const expected = topUseCounts.reduce((sum, useCount) => sum + expectedWeight(useCount), 0);
    expect(scores.get('author-1')).toBeCloseTo(Math.min(CURATION.maxScore, expected), 10);
  });

  it('RULE 4: the summed score is CLAMPED at `maxScore`', async () => {
    const edges: CurationEdge[] = Array.from({ length: CURATION.maxCuratorsPerAuthor }, (_, i) => ({
      authorId: 'author-1',
      curatorId: `whale-${i}`,
      useCount: 100_000,
    }));
    const followers = new Map(edges.map((edge) => [edge.curatorId, 5_000_000]));

    const scores = await computeStarterPackScores(['author-1'], mockDeps(edges, followers));

    expect(scores.get('author-1')).toBe(CURATION.maxScore);
  });

  it('RULE 5: an UNCURATED author gets no score at all (the signal reads it as neutral)', async () => {
    const scores = await computeStarterPackScores(['author-1'], mockDeps([]));

    expect(scores.size).toBe(0);
    expect(scores.get('author-1')).toBeUndefined();
  });

  it('a curator with a real audience outweighs a curator with none (same pack usage)', async () => {
    const whale = await computeStarterPackScores(
      ['author-1'],
      mockDeps(
        [{ authorId: 'author-1', curatorId: 'whale', useCount: 10 }],
        new Map([['whale', 100_000]]),
      ),
    );
    const nobody = await computeStarterPackScores(
      ['author-1'],
      mockDeps([{ authorId: 'author-1', curatorId: 'nobody', useCount: 10 }], new Map()),
    );

    expect(whale.get('author-1') ?? 0).toBeGreaterThan(nobody.get('author-1') ?? 0);
    // …but only by the BOUNDED authority spread — never unbounded amplification.
    const ratio = (whale.get('author-1') ?? 0) / (nobody.get('author-1') ?? 1);
    expect(ratio).toBeLessThanOrEqual(CURATION.curatorAuthority.max / CURATION.curatorAuthority.min);
  });

  it('a low-follower CURATION RING scores far below a single genuine curator', async () => {
    // Three sybils with no audience, each with a barely-used pack containing the
    // target — the cheapest realistic gaming attempt.
    const ring = await computeStarterPackScores(
      ['author-1'],
      mockDeps(
        [
          { authorId: 'author-1', curatorId: 'sybil-1', useCount: 1 },
          { authorId: 'author-1', curatorId: 'sybil-2', useCount: 1 },
          { authorId: 'author-1', curatorId: 'sybil-3', useCount: 1 },
        ],
        new Map(),
      ),
    );

    // One real curator with a real audience and a pack people actually used.
    const genuine = await computeStarterPackScores(
      ['author-2'],
      mockDeps(
        [{ authorId: 'author-2', curatorId: 'curator', useCount: 50 }],
        new Map([['curator', 10_000]]),
      ),
    );

    expect(ring.get('author-1') ?? 0).toBeLessThan(genuine.get('author-2') ?? 0);
  });
});

describe('computeStarterPackScores — batching + fail-softness', () => {
  it('issues exactly ONE edge lookup and ONE follower lookup for N authors', async () => {
    const authorIds = Array.from({ length: 40 }, (_, i) => `author-${i}`);
    const deps = mockDeps(
      authorIds.map((authorId) => ({ authorId, curatorId: 'curator-1', useCount: 2 })),
      new Map([['curator-1', 500]]),
    );

    const scores = await computeStarterPackScores(authorIds, deps);

    expect(scores.size).toBe(authorIds.length);
    expect(deps.loadCurationEdges).toHaveBeenCalledTimes(1);
    expect(deps.loadCurationEdges).toHaveBeenCalledWith(authorIds);
    expect(deps.loadCuratorFollowerCounts).toHaveBeenCalledTimes(1);
    expect(deps.loadCuratorFollowerCounts).toHaveBeenCalledWith(['curator-1']);
  });

  it('deduplicates the requested author ids before querying', async () => {
    const deps = mockDeps([]);

    await computeStarterPackScores(['author-1', 'author-1', 'author-2'], deps);

    expect(deps.loadCurationEdges).toHaveBeenCalledWith(['author-1', 'author-2']);
  });

  it('touches nothing when there are no authors to score', async () => {
    const deps = mockDeps([]);

    await expect(computeStarterPackScores([], deps)).resolves.toEqual(new Map());
    expect(deps.loadCurationEdges).not.toHaveBeenCalled();
    expect(deps.loadCuratorFollowerCounts).not.toHaveBeenCalled();
  });

  it('skips the follower lookup entirely when nobody is curated', async () => {
    const deps = mockDeps([]);

    await computeStarterPackScores(['author-1'], deps);

    expect(deps.loadCuratorFollowerCounts).not.toHaveBeenCalled();
  });

  it('is FAIL-SOFT: an aggregation failure degrades to NO scores (neutral), never throws', async () => {
    const deps: StarterPackCurationDeps = {
      loadCurationEdges: vi.fn().mockRejectedValue(new Error('mongo unreachable')),
      loadCuratorFollowerCounts: vi.fn(),
    };

    await expect(computeStarterPackScores(['author-1'], deps)).resolves.toEqual(new Map());
  });

  it('is FAIL-SOFT: a follower-count failure degrades to NO scores, never throws', async () => {
    const deps: StarterPackCurationDeps = {
      loadCurationEdges: vi
        .fn()
        .mockResolvedValue([{ authorId: 'author-1', curatorId: 'curator-1', useCount: 3 }]),
      loadCuratorFollowerCounts: vi.fn().mockRejectedValue(new Error('redis unreachable')),
    };

    await expect(computeStarterPackScores(['author-1'], deps)).resolves.toEqual(new Map());
  });

  it('still scores when curator follower counts are simply UNKNOWN (neutral authority)', async () => {
    const scores = await computeStarterPackScores(
      ['author-1'],
      mockDeps([{ authorId: 'author-1', curatorId: 'cold-curator', useCount: 3 }], new Map()),
    );

    expect(scores.get('author-1')).toBeCloseTo(packWeight(3, undefined), 10);
  });
});

describe('buildCurationPipeline', () => {
  const pipeline = buildCurationPipeline(['author-1', 'author-2']);

  it('pre-filters on the indexed member array AND the crowd-validation floor', () => {
    expect(pipeline[0]).toEqual({
      $match: {
        memberOxyUserIds: { $in: ['author-1', 'author-2'] },
        useCount: { $gte: CURATION.minUseCount },
      },
    });
  });

  it('drops self-owned packs in the database, not just in the policy', () => {
    expect(pipeline).toContainEqual({ $match: { $expr: { $ne: ['$authorId', '$curatorId'] } } });
  });

  it('dedupes by CURATOR in the database, keeping their best (max-useCount) pack', () => {
    expect(pipeline).toContainEqual({
      $group: {
        _id: { authorId: '$authorId', curatorId: '$curatorId' },
        useCount: { $max: '$useCount' },
      },
    });
  });

  it('bounds its own output at `maxCuratorsPerAuthor` curators per author', () => {
    expect(pipeline).toContainEqual({
      $group: {
        _id: '$_id.authorId',
        curators: {
          $topN: {
            n: CURATION.maxCuratorsPerAuthor,
            sortBy: { useCount: -1, '_id.curatorId': 1 },
            output: { curatorId: '$_id.curatorId', useCount: '$useCount' },
          },
        },
      },
    });
  });
});
