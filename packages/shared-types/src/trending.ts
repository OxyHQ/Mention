/**
 * Trending-topic telemetry — the contract behind `POST /trending/events`.
 *
 * Trends are a recommendation like any other, and until now the only one nobody
 * measured: the right rail, the Explore screen and the feed card all render them
 * and none of them could say whether a single reader ever pressed one.
 *
 * Deliberately NOT the interstitial-card contract (`FeedInterstitialEventInput`).
 * That one requires a valid `feedDescriptor`, and a trend pressed in the right
 * rail or in search is not in any feed at all; its `kind` is also a total
 * `Record` over the card kinds, so mixing trend types into it would fuse two
 * taxonomies that answer different questions. The two live side by side on
 * purpose — see `reportTrendEvent` for why a trend pressed INSIDE the card
 * reports to both.
 *
 * Every field here is either a bounded metric label or is carried for the body
 * alone. Nothing high-cardinality is ever labelled: see `rank` and `recId`.
 */

/**
 * What happened to the trend. `seen` exists from the start because a click count
 * without a denominator says nothing — the click/seen RATIO is the measurement.
 */
export type TrendEventName = 'click' | 'seen';

/** The kind of thing trending; mirrors `Trending.type` on the server. */
export type TrendEventType = 'hashtag' | 'topic' | 'entity';

/**
 * The category taxonomy a trend is filed under — the coarse hint shown beneath
 * its label ("Sports", "Politics").
 *
 * Closed and small because a client has to be able to TRANSLATE it: a category
 * is rendered from a fixed string table per locale, so a vocabulary that could
 * grow at runtime would surface untranslated words to readers. `other` is the
 * honest answer when nothing fits — it renders as no category at all rather
 * than as the word "Other" — and is what any unrecognised value degrades to
 * (see {@link normalizeTrendCategory}).
 *
 * The server derives a category by mapping its rule-based topic slugs onto this
 * list, so the taxonomy a post is classified under and the one a trend is shown
 * under stay a single evolution point.
 *
 * Declared here rather than in `MtnConfig` so the runtime list and the type stay
 * one declaration; the config references it.
 */
export const TREND_CATEGORIES = [
  'news',
  'politics',
  'sports',
  'pop-culture',
  'video-games',
  'tech',
  'science',
  'other',
] as const;

export type TrendCategory = (typeof TREND_CATEGORIES)[number];

/**
 * Narrow an arbitrary string to a {@link TrendCategory}, degrading to `other`.
 *
 * The input is model output, so "unrecognised" is a routine outcome and not an
 * error: a labeller that answers `Entertainment` instead of `pop-culture` must
 * cost the trend its category, never its place in the list.
 */
export function normalizeTrendCategory(value: string | undefined | null): TrendCategory {
  if (!value) return 'other';
  const normalized = value.trim().toLowerCase();
  return (TREND_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as TrendCategory)
    : 'other';
}

/**
 * Whether a trend is bursting hard enough to be called out.
 *
 * One value, not a scale: `hot` is a claim that something is happening right
 * now, and its absence is the ordinary case. The client derives everything else
 * it shows (a `new` badge, an age) from the trend's `startedAt` — a second
 * stored status would be a second thing that can disagree with the timestamp.
 */
export type TrendStatus = 'hot';

/**
 * Where the trend was rendered. Each surface has a different cost and a
 * different denominator, so they are counted apart rather than summed:
 *  - `widget` — the right-rail trends widget
 *  - `explore` — the live "Trending now" section of `/explore/trending`
 *  - `history` — a past-day section of that same screen (an archive, not a
 *    recommendation, which is why history trends carry no `recId`)
 *  - `search` — the search screen's idle suggestions
 *  - `interstitial` — the in-feed trending card
 *  - `feeds` — the trending section of the feeds directory
 */
export type TrendEventSurface =
  | 'widget'
  | 'explore'
  | 'search'
  | 'interstitial'
  | 'history'
  | 'feeds';

export interface TrendEventInput {
  event: TrendEventName;
  type: TrendEventType;
  surface: TrendEventSurface;
  /**
   * 1-based position in the RENDERED list. Carried so a report can be read back
   * in a log, and deliberately NEVER labelled — per-position labels would
   * multiply the series count by the length of every list that shows a trend.
   */
  rank?: number;
  /**
   * The batch token `GET /trending` returned alongside these trends — it
   * identifies the BATCH, not the trend (per-item attribution already rides in
   * `rank`), and history trends genuinely have none.
   *
   * Shape-validated on arrival and then CONSUMED, never labelled: it is
   * high-cardinality by construction (a new one every 30 minutes) and it is
   * client-supplied, so labelling it would hand any caller an unbounded metric.
   * The server derives exactly one bounded label from it — whether the batch the
   * reader acted on is still the current one.
   */
  recId?: string;
}

/**
 * One node of the co-occurrence graph behind a trend batch — a term, with the
 * measurements that decide whether it links to anything.
 */
export interface TrendGraphNodeDTO {
  /** The term. Lowercase, possibly a phrase. */
  term: string;
  /**
   * What a reader is shown, when there is anything better than the term.
   *
   * Present only for terms that became a reported trend, since a label is
   * derived per trend and most nodes are not trends. Joined at read time from
   * the same batch's rows rather than stored twice.
   */
  displayName?: string;
  /** Posts carrying the term in the window. */
  volume: number;
  /** DISTINCT authors of those posts. */
  authorCount: number;
  /** Primary languages of those posts (ISO 639-1). */
  languages: string[];
  /** Coarse regions of those posts, where known. Often empty — the signal is sparse. */
  regions: string[];
  /** The term this node was merged into, when it is part of a story. */
  story?: string;
}

/** One co-occurrence: two terms and how many posts contain both. */
export interface TrendGraphEdgeDTO {
  a: string;
  b: string;
  posts: number;
  /**
   * Whether the clusterer accepted this exact pair.
   *
   * An unlinked edge is the interesting one: it is the visible answer to why
   * two terms are still two rows.
   */
  linked: boolean;
}

/** The graph behind one batch, plus the filter values its own data supports. */
export interface TrendGraphResponse {
  calculatedAt: string;
  nodes: TrendGraphNodeDTO[];
  edges: TrendGraphEdgeDTO[];
  /**
   * Every language present in the UNFILTERED graph, and every region.
   *
   * Sent so a client can offer exactly the filters the data supports rather
   * than a fixed list that promises coverage the network may not have — region
   * in particular is sparse and is frequently empty.
   */
  availableLanguages: string[];
  availableRegions: string[];
  /** Edges the batch dropped for size, if any. */
  droppedEdges?: number;
}
