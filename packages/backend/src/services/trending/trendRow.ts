/**
 * A stored trend ROW and the shape it goes over the wire in.
 *
 * One mapping, shared by the live list and the history archive, so the two can
 * never answer with differently-shaped trends; plus the language ORDERING that
 * decides which of them a reader sees first, which is a presentation rule and
 * deliberately never a filter.
 */

import { trending } from '../../db/schema/discovery';
import type { PostUser, TrendCategory, TrendScope, TrendStatus } from '@mention/shared-types';

/**
 * The stored spelling of a trend's kind — the same three strings
 * {@link TrendingType} carries, as the plain literal union the `trending.type`
 * column is typed with.
 *
 * Both spellings exist on purpose. `TrendingType` is a string ENUM and TypeScript
 * treats those nominally, so an enum member is not assignable to `'hashtag'` and
 * vice versa; the enum stays the PUBLIC vocabulary (`routes/trending.routes.ts`
 * validates `?type=` against it) while everything that touches a row uses the
 * column's own type. They are the identical three strings at runtime, which is
 * what makes converting at the boundary a no-op rather than a translation.
 */
export type TrendingKind = (typeof trending.$inferSelect)['type'];

/**
 * How much wider the trend query reaches when a reader's languages have to be
 * matched. Three pages' worth: enough that a reader whose language is a
 * minority here still gets a full list of it, small enough to stay one indexed
 * read.
 */
export const LANGUAGE_OVERFETCH = 3;

/**
 * Select the trends that belong to the reader's language audience.
 *
 * Language preferences are membership, not a weak ranking hint: a short list is
 * more useful than padding it with a story the reader did not ask for. The sole
 * cross-language exception is a resolved concept whose evidence genuinely spans
 * languages and regions (`scope=global`). This keeps international concepts in
 * circulation without treating every high-scoring foreign term as universal.
 *
 * With no requested language, membership remains global. Region is still a
 * presentation preference within the accepted set, and the incoming score order
 * is retained for equal matches.
 */
export function selectForAudience(
  trends: readonly SerializedTrend[],
  languages: readonly string[],
  region?: string,
): SerializedTrend[] {
  const wanted = new Set(languages);
  const accepted = languages.length === 0
    ? [...trends]
    : trends.filter((trend) =>
      trend.languages?.some((language) => wanted.has(language))
      || (trend.scope === 'global' && Boolean(trend.conceptId)),
    );

  if (!region) return accepted;

  return accepted
    .map((trend, index) => ({
      trend,
      index,
      regionMatch: trend.regions?.includes(region) ? 1 : 0,
    }))
    .sort((left, right) => right.regionMatch - left.regionMatch || left.index - right.index)
    .map(({ trend }) => trend);
}

/**
 * A trend row as `GET /trending` serves it.
 *
 * `_id` survives the port because the client's contract requires it; the value
 * is the same one Mongo held, since the backfill copies `_id` verbatim into the
 * `text` primary key.
 */
export interface SerializedTrend {
  _id: string;
  type: TrendingKind;
  /** The TERM — the retrieval key, and what the `trend|<name>` feed matches on. */
  name: string;
  /** What a reader is shown. Absent on rows written before trends had labels. */
  displayName?: string;
  category?: TrendCategory;
  languages?: string[];
  regions?: string[];
  scope?: TrendScope;
  conceptId?: string;
  localizedLabels?: Record<string, string>;
  description: string;
  score: number;
  volume: number;
  authorCount?: number;
  burstScore?: number;
  momentum: number;
  startedAt?: Date;
  status?: TrendStatus;
  actorIds?: string[];
  rank: number;
  topicId?: string;
  calculatedAt: Date;
  updatedAt: Date;
}

/** The one row → wire mapping, shared by the live list and the history archive. */
export function serializeTrend(row: typeof trending.$inferSelect): SerializedTrend {
  return {
    _id: row.id,
    type: row.type,
    name: row.name,
    ...(row.displayName === null ? {} : { displayName: row.displayName }),
    ...(row.category === null ? {} : { category: row.category }),
    ...(row.languages === null ? {} : { languages: row.languages }),
    ...(row.regions === null ? {} : { regions: row.regions }),
    ...(row.scope === null ? {} : { scope: row.scope }),
    ...(row.conceptId === null ? {} : { conceptId: row.conceptId }),
    ...(row.localizedLabels === null ? {} : { localizedLabels: row.localizedLabels }),
    description: row.description,
    score: row.score,
    volume: row.volume,
    ...(row.authorCount === null ? {} : { authorCount: row.authorCount }),
    ...(row.burstScore === null ? {} : { burstScore: row.burstScore }),
    momentum: row.momentum,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.status === null ? {} : { status: row.status }),
    ...(row.actorIds === null ? {} : { actorIds: row.actorIds }),
    rank: row.rank,
    ...(row.topicId === null ? {} : { topicId: row.topicId }),
    calculatedAt: row.calculatedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * A trend as `GET /trending` serves it: the stored row plus the recent history of
 * its `volume`, which is what the row's sparkline draws.
 *
 * `series` is OPTIONAL and load-bearing. A trend seen in fewer than
 * `MtnConfig.trending.series.minPoints` batches has too little history to draw,
 * and the honest response is its absence — never a padded or flattened stand-in.
 * History trends (`getTrendingHistory`) never carry one at all; see
 * {@link loadVolumeSeries}.
 */
export type TrendWithSeries = SerializedTrend & {
  series?: number[];
  /**
   * The stored `actorIds` resolved to renderable users — the faces shown beside
   * the trend.
   *
   * Resolved SERVER-SIDE, on the same cached batch path post authors use, so a
   * trends list costs no per-actor round trip from the client and identity stays
   * on one authority. Absent (rather than empty) when nothing resolved, and ids
   * that resolve to the degraded fallback are dropped: a nameless avatar is
   * worse evidence than no avatar.
   */
  actors?: PostUser[];
};
