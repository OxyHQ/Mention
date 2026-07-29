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
}
