/**
 * A stored trend ROW and the shape it goes over the wire in.
 *
 * One mapping, shared by the live list and the history archive, so the two can
 * never answer with differently-shaped trends; plus the language ORDERING that
 * decides which of them a reader sees first, which is a presentation rule and
 * deliberately never a filter.
 */

import { trending } from '../../db/schema/discovery';
import type { PostUser, TrendCategory, TrendStatus } from '@mention/shared-types';

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
 * Move the trends a reader can READ to the front, without removing any.
 *
 * A filter would be the obvious thing and is wrong: on a network where one
 * language dominates, filtering leaves speakers of every other language with an
 * empty widget — the failure the never-blank rule exists to prevent, arriving by
 * a different road. Ordering gives a reader their own language first and still
 * shows them what the rest of the network is talking about.
 *
 * A trend with NO recorded language (written before trending measured it, or
 * carried by posts whose language never resolved) is treated as matching: its
 * language is unknown, not foreign, and hiding it would be a claim nobody made.
 *
 * Stable: the incoming order is score order, and terms that match equally keep
 * it.
 */
export function orderByLanguageMatch(
  trends: readonly SerializedTrend[],
  languages: readonly string[],
): SerializedTrend[] {
  if (languages.length === 0) return [...trends];

  const wanted = new Set(languages);
  const matches = (trend: SerializedTrend): boolean =>
    !trend.languages?.length || trend.languages.some((language) => wanted.has(language));

  const readable: SerializedTrend[] = [];
  const rest: SerializedTrend[] = [];
  for (const trend of trends) (matches(trend) ? readable : rest).push(trend);
  return [...readable, ...rest];
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
