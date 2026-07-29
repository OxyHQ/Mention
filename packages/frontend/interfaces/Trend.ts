export interface Trend {
  id: string;
  type: 'hashtag' | 'topic' | 'entity';
  text: string;
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
