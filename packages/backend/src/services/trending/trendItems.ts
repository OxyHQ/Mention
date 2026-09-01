/**
 * From SCORED terms to the rows a batch stores.
 *
 * Detection says what was measured and scoring says which measurements make the
 * cut; this module answers everything else a stored row needs — what the trend
 * is called, how it is filed, when its current run began, how the term was
 * WRITTEN, and whether the shared Topic registry knows it.
 *
 * Everything expensive here is scoped to the trends that actually made the cut
 * (at most `MtnConfig.trending.detection.maxTrends`), never to the candidate
 * space — which is the whole corpus's vocabulary.
 */

import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { MtnConfig } from '@mention/shared-types';
import { TopicType } from '@oxyhq/core';
import { getDb } from '../../db/postgres';
import { trending, TrendingType } from '../../db/schema/discovery';
import { logger } from '../../utils/logger';
import { topicService } from '../TopicService';
import { loadExcerptsByTerm } from './trendExcerpts';
import {
  deriveTrendLabel,
  fallbackTrendLabel,
  TREND_LABEL_VERSION,
  type TrendLabel,
} from './trendLabeling';
import { resolveTrendStartedAt, type ScoredTrend } from './trendScoring';
import type { TermCandidate } from './trendDetection';
import type { TrendCategory, TrendStatus } from '@mention/shared-types';

export interface TrendItem {
  type: TrendingType;
  /** The term (retrieval key). */
  name: string;
  /** Every term the row stands for, `name` first. One element unless merged. */
  terms: string[];
  /** What a reader sees. Never the bare term unless labelling produced nothing better. */
  displayName: string;
  category: TrendCategory;
  description: string;
  score: number;
  burstScore: number;
  volume: number;
  authorCount: number;
  momentum: number;
  startedAt: Date;
  status?: TrendStatus;
  actorIds: string[];
  languages: string[];
  topicId?: string;
}

/**
 * Which of the three `TrendingType` values a row gets.
 *
 * Provenance only — how the term was WRITTEN, not how it was scored. It exists
 * because `GET /trending?type=` is a public filter and because a term backed by
 * a real Topic document routes to a topic page. The hashtag test is a majority:
 * a term most of whose posts spelled it with a `#` is a hashtag; a term people
 * mostly just wrote is an entity.
 */
function resolveTrendType(input: {
  hasTopic: boolean;
  topicVolume: number;
  hashtagVolume: number;
  volume: number;
}): TrendingType {
  // A term the CLASSIFIER produced is a topic, whether or not the shared Topic
  // registry resolved a document for it. Those are two different facts and only
  // the first is about what the term IS: registry resolution is a remote call
  // that can return nothing for a slug this instance classifies perfectly well,
  // and gating the type on it filed `politics` as an `entity` on the live list.
  // The registry linkage still rides separately, in `topicId`.
  if (input.hasTopic || input.topicVolume > 0) return TrendingType.TOPIC;
  return input.hashtagVolume * 2 >= input.volume ? TrendingType.HASHTAG : TrendingType.ENTITY;
}

/**
 * Turn scored terms into the rows a batch stores: label, category, onset,
 * provenance type and registry linkage.
 *
 * Everything expensive here is scoped to the trends that actually made the
 * cut (at most `MtnConfig.trending.detection.maxTrends`), never to the
 * candidate space — which is the whole corpus's vocabulary.
 */
export async function buildTrendItems(
  ranked: readonly ScoredTrend[],
  candidates: readonly TermCandidate[],
  calculatedAt: Date,
): Promise<TrendItem[]> {
  if (ranked.length === 0) return [];

  const byTerm = new Map(candidates.map((candidate) => [candidate.measurement.term, candidate]));
  const terms = ranked.map((trend) => trend.term);

  const appearances = await loadTrendAppearances(terms, calculatedAt);
  const startedAt = new Map(
    terms.map((term) => [term, resolveTrendStartedAt(appearances.get(term) ?? [], calculatedAt)]),
  );

  // Only terms the CLASSIFIER produced are looked up in the topic registry.
  // `resolveNames` is a write-through registry call, so handing it arbitrary
  // words extracted from prose would fill the shared Topic registry with this
  // instance's vocabulary — a side effect trending has no business causing.
  const topicTerms = terms.filter((term) => (byTerm.get(term)?.topicVolume ?? 0) > 0);
  const [labels, topicMap] = await Promise.all([
    resolveTrendLabels(ranked, startedAt),
    topicService.resolveNames(topicTerms.map((name) => ({ name, type: TopicType.TOPIC }))),
  ]);

  return ranked.map((trend) => {
    const candidate = byTerm.get(trend.term);
    const topicDoc = topicMap.get(trend.term.toLowerCase());
    const label = labels.get(trend.term) ?? fallbackTrendLabel(trend.term);

    return {
      type: resolveTrendType({
        hasTopic: Boolean(topicDoc),
        topicVolume: candidate?.topicVolume ?? 0,
        hashtagVolume: candidate?.hashtagVolume ?? 0,
        volume: trend.volume,
      }),
      name: trend.term,
      terms: candidate?.members ?? [trend.term],
      displayName: label.displayName,
      category: label.category,
      description: '',
      score: trend.score,
      burstScore: trend.burstScore,
      volume: trend.volume,
      authorCount: trend.authorCount,
      momentum: trend.momentum,
      startedAt: startedAt.get(trend.term) ?? calculatedAt,
      ...(trend.status ? { status: trend.status } : {}),
      actorIds: candidate?.actorIds ?? [],
      languages: candidate?.languages ?? [],
      ...(topicDoc ? { topicId: topicDoc._id.toString() } : {}),
    };
  });
}

/**
 * The batch timestamps each term has appeared in, within the onset lookback —
 * the input {@link resolveTrendStartedAt} reconstructs a run from.
 *
 * Served by the `(name, calculated_at, type)` unique index (an exact prefix),
 * the same one the sparkline's range scan uses. Fail-soft: without history
 * every trend simply starts now, which is what a first-ever batch genuinely
 * means.
 */
async function loadTrendAppearances(
  terms: readonly string[],
  calculatedAt: Date,
): Promise<Map<string, Date[]>> {
  const byTerm = new Map<string, Date[]>();
  if (terms.length === 0) return byTerm;

  try {
    const cutoff = new Date(calculatedAt.getTime() - MtnConfig.trending.detection.onsetLookbackMs);
    const rows = await getDb()
      .select({ name: trending.name, calculatedAt: trending.calculatedAt })
      .from(trending)
      .where(and(
        inArray(trending.name, [...terms]),
        gte(trending.calculatedAt, cutoff),
      ));

    for (const row of rows) {
      const existing = byTerm.get(row.name);
      if (existing) existing.push(row.calculatedAt);
      else byTerm.set(row.name, [row.calculatedAt]);
    }
  } catch (error) {
    logger.warn('[Trending] Onset history lookup failed; trends will start now', { error });
  }

  return byTerm;
}

/**
 * A label per ranked term: reused when the CURRENT run already has one,
 * generated for the rest.
 *
 * Reuse is scoped to the run (`calculatedAt >= startedAt`) and that boundary
 * is the whole point. Within a run the story is the same story, so renaming it
 * under a reader mid-scroll would be a bug; across runs the term is about
 * something new — `orioles` was a trade last week and is a no-hitter today —
 * so carrying the old headline forward would be worse than having none.
 */
async function resolveTrendLabels(
  ranked: readonly ScoredTrend[],
  startedAt: ReadonlyMap<string, Date>,
): Promise<Map<string, TrendLabel>> {
  const labels = new Map<string, TrendLabel>();

  try {
    const earliestRun = Math.min(
      ...ranked.map((trend) => startedAt.get(trend.term)?.getTime() ?? Date.now()),
    );
    const rows = await getDb()
      .select({
        name: trending.name,
        displayName: trending.displayName,
        category: trending.category,
        calculatedAt: trending.calculatedAt,
      })
      .from(trending)
      .where(and(
        inArray(trending.name, ranked.map((trend) => trend.term)),
        gte(trending.calculatedAt, new Date(earliestRun)),
        sql`${trending.displayName} is not null`,
        // Only a label THESE rules produced may be carried forward. An older
        // one is re-derived, so a rules fix reaches a run already in progress
        // instead of waiting for it to end. `=` is total here because the
        // `is not null` above has already excluded the rows where a NULL
        // `label_version` would make the comparison NULL.
        eq(trending.labelVersion, TREND_LABEL_VERSION),
      ))
      .orderBy(desc(trending.calculatedAt));

    for (const row of rows) {
      // Sorted newest-first, so the first row seen for a term is its latest
      // label; the per-term run boundary is re-checked here because the query
      // could only narrow to the EARLIEST run across all of them.
      if (labels.has(row.name) || row.displayName === null) continue;
      const runStart = startedAt.get(row.name);
      if (runStart && row.calculatedAt < runStart) continue;
      labels.set(row.name, { displayName: row.displayName, category: row.category ?? 'other' });
    }
  } catch (error) {
    logger.warn('[Trending] Label reuse lookup failed; relabelling from scratch', { error });
  }

  const unlabelled = ranked
    .filter((trend) => !labels.has(trend.term))
    .slice(0, MtnConfig.trending.labeling.maxPerBatch);

  const excerptsByTerm = await loadExcerptsByTerm(unlabelled.map((trend) => trend.term));
  for (const trend of unlabelled) {
    labels.set(trend.term, deriveTrendLabel({
      term: trend.term,
      excerpts: excerptsByTerm.get(trend.term) ?? [],
    }));
  }

  // Anything past the per-batch labelling cap still needs a presentable name.
  for (const trend of ranked) {
    if (!labels.has(trend.term)) labels.set(trend.term, fallbackTrendLabel(trend.term));
  }

  return labels;
}
