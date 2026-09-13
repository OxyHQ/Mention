/**
 * The `trending` row lookup every `trend|<term>` feed page resolves before it
 * can match posts — see {@link resolveTrendStory}. Its own file, matching
 * `userSummaryCache.ts`/`postDetailCache.ts`: a cache built on the shared
 * `createCache` primitive is easiest to reason about (and to mock in a test)
 * as its own small module, not a `const` buried in a large multi-source file.
 */

import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { trending } from '../db/schema/discovery';
import { createCache } from '../utils/cache';
import { logger } from '../utils/logger';

const TREND_STORY_PREFIX = 'trendstory:v1:';

/**
 * 30s, matching `TrendingService`'s own `CURRENT_REC_ID_TTL_MS` memo for the
 * same reason: the row this reads only changes when the trend-calculation job
 * runs (on the order of minutes), so a cache this short cannot mislabel a
 * trend for more than a few seconds after a real merge — while still
 * absorbing the repeat lookups one popular trend's scrollers generate (this
 * used to run once per PAGE of `trend|<term>`, uncached, on every request).
 */
const TREND_STORY_TTL_SECONDS = 30;

const cache = createCache({ name: 'TrendStoryCache', ttlSeconds: TREND_STORY_TTL_SECONDS });

function keyFor(term: string): string {
  return `${TREND_STORY_PREFIX}${term}`;
}

/**
 * Every term the trend named `term` stands for — itself, plus anything merged
 * into it.
 *
 * Reads the most recent row for the name, served by
 * `trending_name_calculated_at_type_key` as an exact prefix on `name`. Fail-soft
 * to the bare term: a lookup that finds nothing is the ordinary case for an
 * unmerged trend, and a lookup that throws should cost the extra posts, never
 * the feed.
 *
 * `terms` is nullable — 90 days of rows predate clustering — and a NULL there
 * means the same thing an unmerged row means, so both fall back to `[term]`.
 *
 * The DB read stays UNCAUGHT inside `getOrCompute`: a rejection there is never
 * written to the cache (`cache.ts`'s documented contract), only propagated —
 * so a transient failure costs one request, not every request for the next
 * `TREND_STORY_TTL_SECONDS`. The fail-soft fallback below is what a caught
 * error (or a genuine "no row for this term") both resolve to; only this outer
 * catch may return it, or the failure path would get cached as a real answer.
 */
export async function resolveTrendStory(term: string): Promise<{ terms: string[]; trendId?: string }> {
  try {
    return await cache.getOrCompute(keyFor(term), async () => {
      const [row] = await getDb()
        .select({ id: trending.id, terms: trending.terms })
        .from(trending)
        .where(eq(trending.name, term))
        .orderBy(desc(trending.calculatedAt))
        .limit(1);
      const terms = row?.terms ?? [];
      return { terms: terms.length > 1 ? terms : [term], ...(row ? { trendId: row.id } : {}) };
    });
  } catch (error) {
    logger.warn('[Feed] Trend term lookup failed; matching the bare term', { term, error });
    return { terms: [term] };
  }
}
