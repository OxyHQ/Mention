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
 * Where the trend was rendered. Each surface has a different cost and a
 * different denominator, so they are counted apart rather than summed:
 *  - `widget` — the right-rail trends widget
 *  - `explore` — the live "Trending now" section of `/explore/trending`
 *  - `history` — a past-day section of that same screen (an archive, not a
 *    recommendation, which is why history trends carry no `recId`)
 *  - `search` — the search screen's idle suggestions
 *  - `interstitial` — the in-feed trending card
 */
export type TrendEventSurface =
  | 'widget'
  | 'explore'
  | 'search'
  | 'interstitial'
  | 'history';

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
