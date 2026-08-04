import { afterAll, afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { MtnConfig } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { starterPackMembers, starterPacks } from '../../db/schema/lists';

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
  computeStarterPackScores,
  curatorAuthority,
  packWeight,
  starterPackCurationDeps,
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

/**
 * The ACCESSOR, against real rows.
 *
 * The suite this replaces asserted that a Mongo pipeline was BUILT — six
 * `toContainEqual` checks over stage objects, none of which could tell a correct
 * query from one that returns nothing. What actually has to hold is a property of
 * the ROWS: the statement is a WORK BOUND, so it may never hand the policy more
 * than `maxCuratorsPerAuthor` curators per author, and WHICH ones it keeps has to
 * be the same on every run — the `$topN` it replaces sorted
 * `{ useCount: -1, '_id.curatorId': 1 }`, and dropping the second key leaves the
 * bounded set at the mercy of the plan.
 *
 * Every expectation below enumerates the curators exactly and is NON-EMPTY: a
 * correlated predicate that silently matches nothing is the failure mode this
 * migration keeps hitting, and `toEqual([])` passes straight through it.
 */
describe('starterPackCurationDeps.loadCurationEdges — against real rows', () => {
  let db: Database;
  const createdPackIds: string[] = [];

  /** Author/curator ids unique per run, so two suites cannot collide. */
  const run = randomUUID();
  const author = (name: string): string => `author-${name}-${run}`;
  const curator = (name: string): string => `curator-${name}-${run}`;

  /** A pack owned by `ownerOxyUserId`, used `useCount` times, containing `members`. */
  async function seedPack(
    ownerOxyUserId: string,
    useCount: number,
    members: string[],
  ): Promise<string> {
    const [pack] = await db
      .insert(starterPacks)
      .values({ ownerOxyUserId, name: `Pack ${randomUUID()}`, useCount })
      .returning({ id: starterPacks.id });
    createdPackIds.push(pack.id);
    if (members.length > 0) {
      await db.insert(starterPackMembers).values(
        members.map((oxyUserId, position) => ({ packId: pack.id, oxyUserId, position })),
      );
    }
    return pack.id;
  }

  beforeAll(async () => {
    db = await connectPostgres();
  });

  afterEach(async () => {
    if (createdPackIds.length > 0) {
      // Members cascade with the pack.
      await db.delete(starterPacks).where(inArray(starterPacks.id, createdPackIds));
      createdPackIds.length = 0;
    }
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('returns one edge per (author, curator) with the curator BEST pack', async () => {
    const target = author('best');
    const owner = curator('best');
    await seedPack(owner, 3, [target]);
    await seedPack(owner, 11, [target]);
    await seedPack(owner, 7, [target]);

    const edges = await starterPackCurationDeps.loadCurationEdges([target]);

    // Exactly one edge, at the MAX useCount — not three edges, and not the last
    // one inserted.
    expect(edges).toEqual([{ authorId: target, curatorId: owner, useCount: 11 }]);
  });

  it('drops a SELF-OWNED pack but keeps a genuine curator in the same batch', async () => {
    const target = author('self');
    const owner = curator('self');
    await seedPack(target, 999, [target]);
    await seedPack(owner, 4, [target]);

    const edges = await starterPackCurationDeps.loadCurationEdges([target]);

    expect(edges).toEqual([{ authorId: target, curatorId: owner, useCount: 4 }]);
  });

  it('drops a pack below `minUseCount` but keeps one at the floor', async () => {
    const target = author('floor');
    const unused = curator('unused');
    const atFloor = curator('atfloor');
    await seedPack(unused, CURATION.minUseCount - 1, [target]);
    await seedPack(atFloor, CURATION.minUseCount, [target]);

    const edges = await starterPackCurationDeps.loadCurationEdges([target]);

    expect(edges).toEqual([
      { authorId: target, curatorId: atFloor, useCount: CURATION.minUseCount },
    ]);
  });

  it('returns edges only for the authors that were asked about', async () => {
    const asked = author('asked');
    const other = author('other');
    const owner = curator('shared');
    await seedPack(owner, 5, [asked, other]);

    const edges = await starterPackCurationDeps.loadCurationEdges([asked]);

    expect(edges).toEqual([{ authorId: asked, curatorId: owner, useCount: 5 }]);
  });

  it('bounds each author at `maxCuratorsPerAuthor`, keeping the HIGHEST useCounts', async () => {
    const target = author('bounded');
    const extra = 5;
    const total = CURATION.maxCuratorsPerAuthor + extra;
    // Curator `i` has useCount `i + 1`, so the survivors are the LAST
    // `maxCuratorsPerAuthor` of them.
    for (let index = 0; index < total; index += 1) {
      await seedPack(curator(`bounded-${String(index).padStart(2, '0')}`), index + 1, [target]);
    }

    const edges = await starterPackCurationDeps.loadCurationEdges([target]);

    expect(edges).toHaveLength(CURATION.maxCuratorsPerAuthor);
    expect(edges.map((edge) => edge.useCount)).toEqual(
      Array.from({ length: CURATION.maxCuratorsPerAuthor }, (_, i) => total - i),
    );
    expect(edges.map((edge) => edge.curatorId)).toEqual(
      Array.from({ length: CURATION.maxCuratorsPerAuthor }, (_, i) =>
        curator(`bounded-${String(total - 1 - i).padStart(2, '0')}`),
      ),
    );
  });

  it('breaks a useCount TIE at the bound by curator id, ascending', async () => {
    /**
     * Every curator here has the SAME `use_count`, so the only thing SPECIFYING
     * which `maxCuratorsPerAuthor` of them survive is the window's secondary sort
     * key — and this assertion names the exact subset the Mongo `$topN`'s
     * `'_id.curatorId': 1` produced.
     *
     * Be clear about what it can and cannot catch: it is a PIN, not a mutation
     * gate. Removing `curator_id asc` from the window was measured and the test
     * still passed, at 13 curators and again at 200 — the `eligible` CTE's
     * `GROUP BY` is planned as a GroupAggregate whose sort already emits
     * `(author_id, curator_id)` ascending, so the secondary key is redundant for
     * THAT plan. It is not redundant in general (a HashAggregate, a parallel
     * plan, or a different major version reorders freely), which is why it stays
     * — and this assertion is what would go red the day the plan changes.
     */
    const target = author('tied');
    const total = CURATION.maxCuratorsPerAuthor + 3;
    const curatorIds = Array.from({ length: total }, (_, i) =>
      curator(`tied-${String(i).padStart(2, '0')}`),
    );
    // Inserted in DESCENDING id order, so the answer can never coincide with the
    // order the rows happen to arrive in — seeding them ascending made this test
    // pass with the tiebreak REMOVED, which is a check that cannot fail.
    for (const owner of [...curatorIds].reverse()) {
      await seedPack(owner, 6, [target]);
    }

    const edges = await starterPackCurationDeps.loadCurationEdges([target]);

    expect(edges.map((edge) => edge.curatorId)).toEqual(
      [...curatorIds].sort().slice(0, CURATION.maxCuratorsPerAuthor),
    );
  });

  it('is empty for an author nobody curated — the vacuity floor for the cases above', async () => {
    await seedPack(curator('elsewhere'), 5, [author('elsewhere')]);

    expect(await starterPackCurationDeps.loadCurationEdges([author('uncurated')])).toEqual([]);
  });

  it('feeds the policy end to end, producing a score above neutral', async () => {
    const target = author('scored');
    await seedPack(curator('scored'), 9, [target]);

    const scores = await computeStarterPackScores([target], {
      loadCurationEdges: starterPackCurationDeps.loadCurationEdges,
      loadCuratorFollowerCounts: async () => new Map(),
    });

    expect(scores.get(target)).toBeCloseTo(packWeight(9, undefined), 10);
  });
});
