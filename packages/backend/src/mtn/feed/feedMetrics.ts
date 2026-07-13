/**
 * Online feed-quality metrics (Phase 7).
 *
 * A single, thin surface over the shared {@link metrics} collector for the feed
 * observability signals that validate the discovery gate and feed composition in
 * production. Centralizing the metric NAMES and LABELS here keeps every emitter
 * (the engine merge, the interaction tracker) consistent and makes the label
 * cardinality auditable in one place:
 *
 *   - `feed_discovery_gated_total{reason,source,shadow}` — a discovery candidate
 *     the gate rejected, labelled by the filter that rejected it, the source lane
 *     it came from, and whether the rejection was measure-only (`shadow`).
 *   - `feed_pool_candidates_total{descriptor,origin}` — candidates in a feed's
 *     merged pool, split by federated vs local origin. The federated SHARE is
 *     derived from the two series: `federated / (federated + local)`.
 *   - `feed_impression_total{origin,descriptor}` — a genuine feed impression,
 *     split by federated vs local origin. The denominator for engagement- and
 *     report-per-impression.
 *   - `feed_interaction_signal_total{signal,descriptor}` — the derived view/skip
 *     signal an impression produced.
 *   - `feed_report_total{descriptor,origin}` — a viewer report on a feed post.
 *
 * Every label is LOW-CARDINALITY: `reason`/`source`/`signal`/`origin`/`shadow`
 * are fixed small sets, and free-form descriptors are normalized to their base
 * feed type via {@link baseDescriptor} (so `author|<id>` / `hashtag|<tag>` never
 * explode the label space).
 *
 * Every signal here is a COUNTER, never a gauge: the fleet runs several tasks and
 * `/metrics` serves the Redis-aggregated total (see `services/metricsAggregator`).
 * Counters sum correctly across instances; a gauge (a point-in-time value written
 * per request) does not — summing or last-writing one across tasks is meaningless.
 */

import { metrics } from '../../utils/metrics';

export const FEED_METRICS = {
  discoveryGated: 'feed_discovery_gated_total',
  poolCandidates: 'feed_pool_candidates_total',
  impression: 'feed_impression_total',
  interactionSignal: 'feed_interaction_signal_total',
  report: 'feed_report_total',
} as const;

/** A post's origin for metric labelling: federated when it carries a `federation` subdoc. */
export type PostOrigin = 'federated' | 'local';

/**
 * Normalize a feed descriptor (`for_you`, `author|<id>`, `hashtag|<tag>`, …) to
 * its base feed-type token so metric labels stay bounded. Never throws — an
 * absent/blank descriptor collapses to `'unknown'`.
 */
export function baseDescriptor(descriptor: string | undefined | null): string {
  if (!descriptor || typeof descriptor !== 'string') return 'unknown';
  const token = descriptor.split('|')[0].trim();
  return token.length > 0 ? token : 'unknown';
}

/** The origin label for a post given the presence/absence of its `federation` subdoc. */
export function originForFederation(federation: unknown): PostOrigin {
  return federation != null ? 'federated' : 'local';
}

/** Coarse pool-size buckets — the upper bound of each bucket, ascending. */
const POOL_SIZE_BUCKETS = [10, 25, 50, 100, 150] as const;

/**
 * Bucket a candidate-pool size into one of a FIXED set of labels
 * (`0-10`, `11-25`, …, `150+`).
 *
 * The raw count must never be used as a metric label: every distinct label set is
 * a retained histogram series, so an unbounded label (a raw count, a user id) grows
 * the in-process histogram map forever. Bucketing keeps "is ranking slow on big
 * pools?" answerable with a bounded, constant number of series.
 */
export function poolSizeBucket(size: number): string {
  if (!Number.isFinite(size) || size < 0) return 'unknown';
  let lower = 0;
  for (const upper of POOL_SIZE_BUCKETS) {
    if (size <= upper) return `${lower}-${upper}`;
    lower = upper + 1;
  }
  return `${POOL_SIZE_BUCKETS[POOL_SIZE_BUCKETS.length - 1]}+`;
}

/** Count a discovery candidate the gate rejected (see {@link FEED_METRICS}). */
export function recordDiscoveryGated(reason: string, source: string, measureOnly: boolean): void {
  metrics.incrementCounter(FEED_METRICS.discoveryGated, 1, {
    reason,
    source,
    shadow: measureOnly ? 'true' : 'false',
  });
}

/**
 * Count a feed's merged candidate pool, split by origin. The federated share is
 * DERIVED from the two series at query time:
 *
 *   feed_pool_candidates_total{origin="federated"}
 *   / sum without (origin) (feed_pool_candidates_total)
 *
 * which stays correct once the fleet's counters are summed — unlike the gauge this
 * replaces, whose per-request value could not be aggregated across instances.
 * Zero-valued origins are not emitted (an increment of 0 is not a data point).
 */
export function recordPoolCandidates(descriptor: string, federated: number, local: number): void {
  const label = baseDescriptor(descriptor);
  if (federated > 0) {
    metrics.incrementCounter(FEED_METRICS.poolCandidates, federated, { descriptor: label, origin: 'federated' });
  }
  if (local > 0) {
    metrics.incrementCounter(FEED_METRICS.poolCandidates, local, { descriptor: label, origin: 'local' });
  }
}

/** Count a genuine feed impression, split by origin. */
export function recordImpression(descriptor: string, origin: PostOrigin): void {
  metrics.incrementCounter(FEED_METRICS.impression, 1, {
    origin,
    descriptor: baseDescriptor(descriptor),
  });
}

/** Count the derived view/skip signal an impression produced. */
export function recordInteractionSignal(signal: string, descriptor: string): void {
  metrics.incrementCounter(FEED_METRICS.interactionSignal, 1, {
    signal,
    descriptor: baseDescriptor(descriptor),
  });
}

/** Count a viewer report on a feed post, split by origin. */
export function recordReport(descriptor: string, origin: PostOrigin): void {
  metrics.incrementCounter(FEED_METRICS.report, 1, {
    descriptor: baseDescriptor(descriptor),
    origin,
  });
}
