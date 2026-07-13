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
 *  - The ACCESSOR ({@link mongoStarterPackCurationDeps}) is the only place that
 *    knows about Mongo. Its aggregation pre-applies the same predicates purely as
 *    an INDEX-SERVED WORK BOUND (it must never return MORE than the policy would
 *    keep per author); the policy re-applies them regardless.
 *
 * COST: per BATCH of authors — never per post and never per author — one Mongo
 * aggregation plus one batched curator follower-count resolution (a Redis MGET, and
 * a single bulk Oxy call only for curators not yet cached). It runs ONLY on the
 * user-summary cache-fill path (`PostHydrationService.resolveUserSummaries`), so a
 * warm feed pays nothing and the RANKING path pays nothing at all.
 *
 * FAIL-SOFT: any error yields NO score for the affected authors, which the signal
 * reads as exactly neutral (1.0). Curation can never break or empty a feed.
 */

import { MtnConfig } from '@mention/shared-types';
import type { PipelineStage } from 'mongoose';
import StarterPack from '../models/StarterPack';
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

/** One author's bounded curator list as returned by the Mongo aggregation. */
interface AggregatedCurationRow {
  _id: string;
  curators: Array<{ curatorId: string; useCount: number }>;
}

/**
 * The Mongo aggregation pipeline behind {@link mongoStarterPackCurationDeps}.
 *
 * Exported so its stages can be asserted in a unit test without a live database.
 * It mirrors the policy rules ONLY as a work bound — it must never return more
 * than the policy would keep, and the policy re-applies every rule regardless:
 *
 *  1. `$match`   — packs containing any of these authors, already crowd-validated
 *                  (`useCount >= minUseCount`). Index-served by
 *                  `{ memberOxyUserIds: 1, useCount: -1 }`.
 *  2. `$unwind`  — one row per (pack, matched author), dropping members we did not
 *                  ask about via `$setIntersection`.
 *  3. `$match`   — drop SELF-OWNED packs (`curator !== author`).
 *  4. `$group`   — dedupe by CURATOR, keeping their best (max-`useCount`) pack.
 *  5. `$group`   — keep only each author's top `maxCuratorsPerAuthor` curators by
 *                  usage (`$topN`, MongoDB 5.2+), which caps the rows this ever
 *                  returns at `maxCuratorsPerAuthor · authors`.
 */
export function buildCurationPipeline(authorIds: string[]): PipelineStage[] {
  return [
    {
      $match: {
        memberOxyUserIds: { $in: authorIds },
        useCount: { $gte: CURATION.minUseCount },
      },
    },
    {
      $project: {
        _id: 0,
        curatorId: '$ownerOxyUserId',
        useCount: 1,
        authorId: { $setIntersection: ['$memberOxyUserIds', authorIds] },
      },
    },
    { $unwind: '$authorId' },
    { $match: { $expr: { $ne: ['$authorId', '$curatorId'] } } },
    {
      $group: {
        _id: { authorId: '$authorId', curatorId: '$curatorId' },
        useCount: { $max: '$useCount' },
      },
    },
    {
      $group: {
        _id: '$_id.authorId',
        curators: {
          $topN: {
            n: CURATION.maxCuratorsPerAuthor,
            // Deterministic: usage first, curator id as the tie-break.
            sortBy: { useCount: -1, '_id.curatorId': 1 },
            output: { curatorId: '$_id.curatorId', useCount: '$useCount' },
          },
        },
      },
    },
  ];
}

/**
 * The production accessors: starter packs from Mongo, curator follower counts from
 * the DEDICATED curator-follower resolver (`services/curatorFollowerCounts.ts` —
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
export const mongoStarterPackCurationDeps: StarterPackCurationDeps = {
  async loadCurationEdges(authorIds: string[]): Promise<CurationEdge[]> {
    const rows = await StarterPack.aggregate<AggregatedCurationRow>(buildCurationPipeline(authorIds));
    const edges: CurationEdge[] = [];
    for (const row of rows) {
      for (const curator of row.curators) {
        edges.push({ authorId: row._id, curatorId: curator.curatorId, useCount: curator.useCount });
      }
    }
    return edges;
  },

  loadCuratorFollowerCounts(curatorIds: string[]): Promise<Map<string, number>> {
    return resolveCuratorFollowerCounts(curatorIds);
  },
};
