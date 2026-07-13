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
 *   - `feed_federated_share{descriptor}` — the federated share (0..1) of a feed's
 *     merged candidate pool.
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
 */

import { metrics } from '../../utils/metrics';

export const FEED_METRICS = {
  discoveryGated: 'feed_discovery_gated_total',
  federatedShare: 'feed_federated_share',
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

/** Count a discovery candidate the gate rejected (see {@link FEED_METRICS}). */
export function recordDiscoveryGated(reason: string, source: string, measureOnly: boolean): void {
  metrics.incrementCounter(FEED_METRICS.discoveryGated, 1, {
    reason,
    source,
    shadow: measureOnly ? 'true' : 'false',
  });
}

/** Record the federated share (0..1) of a feed's merged candidate pool. */
export function recordFederatedShare(descriptor: string, share: number): void {
  metrics.setGauge(FEED_METRICS.federatedShare, share, { descriptor: baseDescriptor(descriptor) });
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
