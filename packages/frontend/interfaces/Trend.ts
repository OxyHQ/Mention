import type { PostUser, TrendCategory, TrendStatus } from '@mention/shared-types';

export interface Trend {
  id: string;
  type: 'hashtag' | 'topic' | 'entity';
  /**
   * The TERM — the retrieval key the trend's feed matches on. Not for display:
   * render {@link Trend.displayName}.
   */
  text: string;
  /**
   * What a reader is shown ("Kremer Trade", not `orioles`).
   *
   * Always populated by the store, falling back to the term for a trend that
   * predates labelling, so no renderer needs its own fallback — and none can
   * forget one and print a raw slug at a user.
   */
  displayName: string;
  /** Coarse taxonomy hint. Absent when nothing was assigned. */
  category?: TrendCategory;
  /**
   * When this run of the trend began, ISO. Drives the `new` badge and the age
   * label. Absent on trends that predate onset tracking — those simply show no
   * badge, which is honest: nobody knows when they started.
   */
  startedAt?: string;
  /** Present only while the trend is bursting hard enough to be called out. */
  status?: TrendStatus;
  /** Distinct authors behind the trend. Absent on rows that predate the field. */
  authorCount?: number;
  /**
   * A few of the accounts posting about it, already resolved server-side — the
   * faces beside the row. Absent when none resolved.
   */
  actors?: PostUser[];
  hashtag: string;
  description: string;
  score: number;
  volume: number;
  momentum: number;
  /**
   * Rank within the WHOLE unfiltered batch (hashtags and topics merged), as the
   * server computed it. It is the sort tiebreak, NOT what a list paints: every
   * surface caps its list and filters hidden trends, so rendering this raw shows
   * gaps (1, 2, 5, 9) the moment a reader hides one. Paint the position in the
   * rendered list instead.
   */
  rank: number;
  created_at: string;
  direction: 'up' | 'down' | 'flat';
  /**
   * The batch this trend came from — `GET /trending`'s top-level `recId`, echoed
   * back with any reported press so the server can tell a press on the current
   * batch from one on a page a CDN served after the batch rotated.
   *
   * Optional and load-bearing: history trends genuinely have none (an archive is
   * not a recommendation).
   */
  recId?: string;
  /**
   * Recent history of this trend's `volume`, oldest first — the sparkline's only
   * input. Every value is a measurement: the server reads them from the trending
   * batches it has stored and downsamples by averaging, never interpolating.
   *
   * Optional and load-bearing, exactly like `recId`. The server omits it entirely
   * for a trend seen in too few batches to draw a meaningful line (the floor is
   * `MtnConfig.trending.series.minPoints`, applied server-side so it has one
   * authority), and history trends never carry one. Absent means DRAW NOTHING —
   * it must never be filled in with a flat or synthesized line.
   */
  series?: number[];
}
