/**
 * `GET /trending/summary`'s result, cached 30s per term.
 *
 * Its own file, alongside `trendGraph.ts`/`trendScoring.ts`/`trendDetection.ts`
 * etc. — `TrendingService.ts` already splits each concern out this way.
 *
 * The frontend deliberately never caches this response (`staleTime: 0,
 * refetchOnMount: 'always'`, per the Trend screen) — every open is meant to
 * re-ask. That is a VIEWER-side freshness choice, not a reason the two DB
 * reads behind it (`trend_batches` latest-batch lookup + a `trending` row by
 * `(name, calculatedAt)`) have to re-run for every one of a popular trend's
 * concurrent viewers: `getTrendSummary` is a pure read (no write, no counter,
 * nothing this cache could short-circuit) — verified by reading its body —
 * so sharing one computation across viewers for a few seconds changes nothing
 * about what the frontend's re-fetch policy accomplishes.
 */

import { createCache } from '../../utils/cache';
import type { TrendDetail } from '../TrendingService';

const TREND_SUMMARY_PREFIX = 'trendsummary:v1:';
const TREND_SUMMARY_TTL_SECONDS = 30;

const cache = createCache({ name: 'TrendSummaryCache', ttlSeconds: TREND_SUMMARY_TTL_SECONDS });

function keyFor(normalizedTerm: string): string {
  return `${TREND_SUMMARY_PREFIX}${normalizedTerm}`;
}

/** Serve `normalizedTerm`'s summary from cache, computing it via `load` on a miss. */
export async function getOrLoadTrendSummary(
  normalizedTerm: string,
  load: () => Promise<TrendDetail>,
): Promise<TrendDetail> {
  return cache.getOrCompute(keyFor(normalizedTerm), load);
}
