/**
 * STARTER-PACK CURATION scoring — the data + policy layer behind the
 * `starterPackBoost` ranking signal.
 *
 * A starter pack contains USERS, so "curation" is an AUTHOR-level endorsement:
 * other people put this author on a list that newcomers actually FOLLOWED
 * THROUGH. That is a human, crowd-validated quality signal for authors whose
 * follow graph is still thin, which raw engagement counts systematically miss.
 *
 * TWO LAYERS, deliberately split:
 *
 *  - The POLICY ({@link computeStarterPackScores}) is a PURE, injectable function
 *    over curation EDGES. It owns every anti-gaming rule (self-owned packs
 *    excluded, unused packs excluded, dedupe by CURATOR, bounded curator count,
 *    clamped score) and is authoritative for ANY accessor, so it is fully
 *    unit-testable with mocks.
 *  - The ACCESSOR ({@link starterPackCurationDeps}) is the only place that knows
 *    about the database. Its query pre-applies the same predicates purely as an
 *    INDEX-SERVED WORK BOUND (it must never return MORE than the policy would
 *    keep per author); the policy re-applies them regardless.
 *
 * COST: per BATCH of authors — never per post and never per author — one SQL
 * statement plus one batched curator follower-count resolution (a Redis MGET, and
 * a single bulk Oxy call only for curators not yet cached). It runs ONLY on the
 * user-summary cache-fill path (`PostHydrationService.resolveUserSummaries`), so a
 * warm feed pays nothing and the RANKING path pays nothing at all.
 *
 * FAIL-SOFT: any error yields NO score for the affected authors, which the signal
 * reads as exactly neutral (1.0). Curation can never break or empty a feed.
 */

import { MtnConfig } from '@mention/shared-types';
import { and, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { starterPackMembers, starterPacks } from '../db/schema/lists';
import { resolveCuratorFollowerCounts } from './curatorFollowerCounts';
import { logger } from '../utils/logger';

const CURATION = MtnConfig.ranking.optInSignals.starterPackBoost;

/**
 * One curation edge: a pack owned by `curatorId` that contains `authorId` and has
 * been used `useCount` times. One edge per (pack, member) pair — the policy is
 * what collapses several packs by the same curator into a single contribution.
 */
export interface CurationEdge {
  authorId: string;
  curatorId: string;
  useCount: number;
}

/**
 * The data accessors {@link computeStarterPackScores} depends on. Injected so the
 * policy can be tested with mocks (and so a future ingest path can supply edges
 * from somewhere other than Mongo).
 */
export interface StarterPackCurationDeps {
  /** Candidate curation edges for a batch of authors — ONE call per batch. */
  loadCurationEdges(authorIds: string[]): Promise<CurationEdge[]>;
  /**
   * Follower counts for a batch of curators — ONE call per batch. An id that is
   * absent from the returned map has an UNKNOWN follower count, which
   * {@link curatorAuthority} treats as the neutral floor (never a penalty).
   */
  loadCuratorFollowerCounts(curatorIds: string[]): Promise<Map<string, number>>;
}

/**
 * How much a curator's own audience amplifies their endorsement.
 *
 * Same bounded log shape as the author-authority signal: `1 + k · log1p(followers)`
 * clamped to `[min, max]`. The floor is NEUTRAL (1.0), so a curator with no — or
 * an unresolved — follower count still endorses at full base weight and is simply
 * never amplified. This is what makes a ring of low-follower accounts curating
 * each other worth a fraction of a genuine curator with a real audience, without
 * ever penalizing a small curator.
 */
export function curatorAuthority(followerCount: number | undefined): number {
  const { logScale, min, max } = CURATION.curatorAuthority;
  if (typeof followerCount !== 'number' || !Number.isFinite(followerCount) || followerCount < 0) {
    return min;
  }
  const raw = 1 + logScale * Math.log1p(followerCount);
  return Math.min(max, Math.max(min, raw));
}

/**
 * The weight of a single pack: `log1p(useCount) · curatorAuthority(owner)`.
 *
 * Log-scaled in usage so the 1st use matters far more than the 500th, and a pack
 * can never dominate by raw volume. Monotonically increasing in `useCount` for a
 * FIXED curator — which is exactly why "the curator's best pack" is well-defined.
 */
export function packWeight(useCount: number, curatorFollowerCount: number | undefined): number {
  const uses = Number.isFinite(useCount) && useCount > 0 ? useCount : 0;
  return Math.log1p(uses) * curatorAuthority(curatorFollowerCount);
}

/** Whether an edge survives the two hard anti-gaming rules (self-owned / unused). */
function isEligible(edge: CurationEdge): boolean {
  // Rule 1 — a pack NEVER endorses its own owner (otherwise: self-boosting).
  if (!edge.authorId || !edge.curatorId || edge.curatorId === edge.authorId) {
    return false;
  }
  // Rule 2 — only crowd-validated packs endorse anyone.
  return Number.isFinite(edge.useCount) && edge.useCount >= CURATION.minUseCount;
}

/**
 * Collapse eligible edges into `authorId → (curatorId → best useCount)`.
 *
 * Rule 3 — DEDUPE BY CURATOR, NOT BY PACK: one curator contributes exactly one
 * entry, their BEST pack. Because `packWeight` is monotonic in `useCount` for a
 * fixed curator, the highest-`useCount` pack IS the highest-weight pack, so this
 * can be resolved before any follower count is known.
 */
function groupByAuthorAndCurator(edges: CurationEdge[]): Map<string, Map<string, number>> {
  const byAuthor = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    if (!isEligible(edge)) continue;
    let curators = byAuthor.get(edge.authorId);
    if (!curators) {
      curators = new Map<string, number>();
      byAuthor.set(edge.authorId, curators);
    }
    const best = curators.get(edge.curatorId);
    if (best === undefined || edge.useCount > best) {
      curators.set(edge.curatorId, edge.useCount);
    }
  }
  return byAuthor;
}

/**
 * Compute the bounded starter-pack curation score for a batch of authors.
 *
 * Pure w.r.t. its {@link StarterPackCurationDeps}: two batched accessor calls, no
 * per-author or per-post I/O. Returns ONLY authors with a score > 0 — an author
 * nobody curated is simply absent, which the ranking signal reads as exactly
 * neutral (1.0). Never throws: an accessor failure degrades the whole batch to
 * "no scores" (logged), so a Mongo/Redis hiccup can never break a feed.
 */
export async function computeStarterPackScores(
  authorIds: string[],
  deps: StarterPackCurationDeps,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const uniqueAuthorIds = Array.from(new Set(authorIds.filter((id) => id.length > 0)));
  if (uniqueAuthorIds.length === 0) {
    return scores;
  }

  try {
    const edges = await deps.loadCurationEdges(uniqueAuthorIds);
    const byAuthor = groupByAuthorAndCurator(edges);
    if (byAuthor.size === 0) {
      return scores;
    }

    // ONE batched follower-count lookup for every distinct curator in the batch.
    const curatorIds = new Set<string>();
    for (const curators of byAuthor.values()) {
      for (const curatorId of curators.keys()) curatorIds.add(curatorId);
    }
    const followerCounts = await deps.loadCuratorFollowerCounts(Array.from(curatorIds));

    for (const [authorId, curators] of byAuthor) {
      // Rule 4 — bound everything: rank each distinct curator's best pack by
      // weight, keep at most `maxCuratorsPerAuthor`, sum, and clamp the total.
      const weights: number[] = [];
      for (const [curatorId, useCount] of curators) {
        weights.push(packWeight(useCount, followerCounts.get(curatorId)));
      }
      weights.sort((a, b) => b - a);

      let total = 0;
      for (const weight of weights.slice(0, CURATION.maxCuratorsPerAuthor)) {
        total += weight;
      }

      const score = Math.min(CURATION.maxScore, total);
      if (score > 0) {
        scores.set(authorId, score);
      }
    }
  } catch (error) {
    logger.warn('[StarterPackCuration] Score computation failed; authors fall back to neutral', {
      authorCount: uniqueAuthorIds.length,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return new Map<string, number>();
  }

  return scores;
}

/**
 * The bounded set of curation edges for a batch of authors — ONE statement.
 *
 * Mongo needed six aggregation stages here (`$match` → `$project`/`$unwind` over
 * the member ARRAY → `$match` → `$group` → `$group` with `$topN`), because the
 * membership it had to join against lived INSIDE the pack document. As a
 * junction table the whole thing is an ordinary join plus a window function:
 *
 *  - `eligible` — packs that contain one of these authors and are already
 *    crowd-validated (`use_count >= minUseCount`), with SELF-OWNED packs dropped
 *    (`curator <> author`), and one row per (author, curator) holding that
 *    curator's BEST pack. `max(use_count)` is the port of the first `$group`,
 *    and it is well-defined because `packWeight` is monotonic in `use_count` for
 *    a FIXED curator.
 *  - `ranked` — `row_number()` per author, so at most `maxCuratorsPerAuthor`
 *    curators per author ever leave the database. That is the port of `$topN`,
 *    and its ORDER BY reproduces `{ useCount: -1, '_id.curatorId': 1 }` exactly:
 *    without the `curator_id` tiebreak, two curators on the same `use_count` are
 *    ordered arbitrarily, so WHICH of them survives the bound would differ
 *    between two identical requests.
 *
 * This is a WORK BOUND, not the policy. {@link computeStarterPackScores}
 * re-applies every rule to whatever comes back.
 */
async function loadCurationEdges(authorIds: string[]): Promise<CurationEdge[]> {
  const db = getDb();

  const eligible = db.$with('eligible').as(
    db
      .select({
        authorId: starterPackMembers.oxyUserId,
        curatorId: starterPacks.ownerOxyUserId,
        useCount: sql<number>`max(${starterPacks.useCount})`.as('use_count'),
      })
      .from(starterPackMembers)
      .innerJoin(starterPacks, eq(starterPacks.id, starterPackMembers.packId))
      .where(
        and(
          // `inArray`, never `= any(${authorIds})`: a raw JS array interpolated
          // into `sql` binds as a ROW constructor, which Postgres rejects.
          inArray(starterPackMembers.oxyUserId, authorIds),
          gte(starterPacks.useCount, CURATION.minUseCount),
          ne(starterPacks.ownerOxyUserId, starterPackMembers.oxyUserId),
        ),
      )
      .groupBy(starterPackMembers.oxyUserId, starterPacks.ownerOxyUserId),
  );

  const ranked = db.$with('ranked').as(
    db
      .select({
        authorId: eligible.authorId,
        curatorId: eligible.curatorId,
        useCount: eligible.useCount,
        rank: sql<number>`row_number() over (partition by ${eligible.authorId} order by ${eligible.useCount} desc, ${eligible.curatorId} asc)`.as(
          'rank',
        ),
      })
      .from(eligible),
  );

  // `rank` is deliberately not selected out: `row_number()` is a bigint, which
  // postgres.js hands back as a STRING, and it is only ever needed inside the
  // predicate below.
  return db
    .with(eligible, ranked)
    .select({
      authorId: ranked.authorId,
      curatorId: ranked.curatorId,
      useCount: ranked.useCount,
    })
    .from(ranked)
    .where(lte(ranked.rank, CURATION.maxCuratorsPerAuthor));
}

/**
 * The production accessors: curation edges from Postgres, curator follower counts
 * from the DEDICATED curator-follower resolver (`services/curatorFollowerCounts.ts` —
 * its own Redis cache + one bulk Oxy call for the misses).
 *
 * That resolver deliberately does NOT go through the shared `usersummary:` identity
 * cache: that cache is filled by the very function which computes curation scores,
 * so reading curators through it would be recursive AND would make a cached summary's
 * own `starterPackScore` depend on cache fill order. Keeping curator follower counts
 * in a separate single-value cache means a COLD curator is still resolved (from Oxy)
 * and therefore still AMPLIFIES — which is the entire point of weighting an
 * endorsement by the curator's audience.
 */
export const starterPackCurationDeps: StarterPackCurationDeps = {
  loadCurationEdges,
  loadCuratorFollowerCounts(curatorIds: string[]): Promise<Map<string, number>> {
    return resolveCuratorFollowerCounts(curatorIds);
  },
};
