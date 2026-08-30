/**
 * What DECORATES a served trend row — its sparkline and its faces.
 *
 * Both are read once per page of trends, both are batched (never per trend or
 * per actor), and both are fail-soft in the same direction: a failure costs the
 * decoration and never the list. That shared rule is why they sit together —
 * losing a sparkline or an avatar is a nicety; losing the trends is an outage.
 */

import { and, gte, inArray, sql } from 'drizzle-orm';
import { MtnConfig } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { trending } from '../../db/schema/discovery';
import { logger } from '../../utils/logger';
import { isFallbackUserSummary, resolveUserSummaries } from '../PostHydrationService';
import { buildTrendSeries } from './trendSeries';
import type { SerializedTrend } from './trendRow';
import type { PostUser } from '@mention/shared-types';

/**
 * Recent `volume` history for the given trends, keyed by TERM.
 *
 * The `trending` table is the ONLY per-term time series that exists: the job
 * appends a full batch every 30 minutes and keeps 90 days, and the unique
 * `(name, calculated_at, type)` index serves this range scan directly. (The
 * obvious-looking alternative, `topic_stats`, holds one current-value row per
 * topic and no history whatsoever.) `array_agg` is ordered EXPLICITLY by
 * `calculated_at` rather than relying on the scan order: an aggregate's input
 * order is not guaranteed in Postgres, so an unordered one would draw a
 * sparkline whose points are in whatever sequence the planner produced.
 *
 * Keyed on the NAME alone. It used to be keyed on (name, type), because a name
 * could be measured twice in one batch — once as a hashtag, once as a topic —
 * and interleaving two unrelated quantities would have drawn a zig-zag. Those
 * lanes are gone: a term is measured once, and `type` is now provenance that
 * can flip between batches as the mix of posts spelling it with a `#` shifts.
 * Keeping `type` in the key would therefore cut one continuous history in two
 * at the flip and drop both halves below the drawing floor.
 *
 * A name absent from a batch contributes NO point rather than a zero: it means
 * the trend fell out of the reporting threshold that batch, which is not the
 * same as nobody posting it. Guessing would be exactly the kind of invented
 * data this feature exists to avoid, so short runs are simply dropped by the
 * floor in {@link buildTrendSeries}.
 *
 * DELIBERATELY NOT wired into `getTrendingHistory`. That route is an archive of
 * what trended on days past, and the series here is anchored to `now` — a row
 * from forty days ago would be handed the last 24 hours of a name it was not
 * trending in. Anchoring per archived batch instead would mean one range scan
 * per (name, day) pair — up to 20 days × 20 trends — to decorate a page nobody
 * reads for live movement. Same reasoning that already keeps `recId` off it: an
 * archive is not a recommendation.
 *
 * Fail-soft: an aggregation failure costs the sparkline, never the trend list.
 */
export async function loadVolumeSeries(
  trends: Array<Pick<SerializedTrend, 'name'>>,
): Promise<Map<string, number[]>> {
  const byTrend = new Map<string, number[]>();
  if (trends.length === 0) return byTrend;

  // The `$match` narrows on name — the index's leading field — and the group
  // collapses each name's batches into one series in time order.
  const names = [...new Set(trends.map((trend) => trend.name))];

  try {
    const cutoff = new Date(Date.now() - MtnConfig.trending.series.windowMs);
    const rows = await getDb()
      .select({
        name: trending.name,
        volumes: sql<number[]>`array_agg(${trending.volume} order by ${trending.calculatedAt})`,
      })
      .from(trending)
      .where(and(
        inArray(trending.name, names),
        gte(trending.calculatedAt, cutoff),
      ))
      .groupBy(trending.name);

    for (const row of rows) {
      const series = buildTrendSeries(row.volumes);
      if (series) byTrend.set(row.name, series);
    }
  } catch (error) {
    logger.warn('[Trending] Volume series lookup failed:', error);
  }

  return byTrend;
}

/**
 * Resolve the stored actor ids of a page of trends into renderable users.
 *
 * ONE batched call for the whole page (at most `limit × maxActors` ids), on
 * the same Redis-backed resolver feed hydration uses — never a per-trend or
 * per-actor fetch, which is the N+1 this resolver exists to collapse.
 *
 * Fail-soft: a resolution failure costs the faces, never the trends. Degraded
 * (unresolvable) ids are dropped rather than rendered, on the same rule the
 * rest of the app follows — an avatar with no identity behind it is not
 * evidence that people are posting, which is the only thing these faces claim.
 */
export async function loadTrendActors(
  trends: readonly Pick<SerializedTrend, 'actorIds'>[],
): Promise<Map<string, PostUser>> {
  const resolved = new Map<string, PostUser>();
  const actorIds = [...new Set(trends.flatMap((trend) => trend.actorIds ?? []))];
  if (actorIds.length === 0) return resolved;

  try {
    for (const [actorId, summary] of await resolveUserSummaries(actorIds)) {
      if (!isFallbackUserSummary(summary.user)) resolved.set(actorId, summary.user);
    }
  } catch (error) {
    logger.warn('[Trending] Actor resolution failed; trends will render without faces', { error });
  }

  return resolved;
}
