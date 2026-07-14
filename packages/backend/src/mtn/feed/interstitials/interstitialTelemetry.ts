/**
 * Recommendation-card TELEMETRY — the only measurement the interstitials have.
 *
 * Card events (`impression`, `click`, `follow`, …) answer ONE question: is anyone
 * actually following accounts, subscribing to feeds or using starter packs from
 * the feed? Without it the placement cadence in `MtnConfig.feed.interstitials`
 * can only be tuned by guesswork.
 *
 * Two constraints shape this file:
 *
 *  1. Card events MUST NOT reach `trackFeedInteraction` / the post-interaction
 *     route. That path requires a `postUri` and feeds POST ranking — routing card
 *     engagement there would poison author/topic affinity with engagement that
 *     never touched a post.
 *  2. They are low-cardinality COUNTERS, never per-row documents. A counter write
 *     is a Map update, so the hot path stays I/O-free (no Mongo, no Redis). The
 *     labels are `kind`, `event` and the BASE descriptor — all fixed, small sets.
 *     A viewer id, a slot key or a target account id would make the label space
 *     unbounded, so none of them are ever emitted.
 *
 * The whole surface is pure and synchronous, and lives outside the controller so
 * it can be unit-tested without importing the Express app.
 */

import { isValidFeedDescriptor } from '@mention/shared-types';
import type {
  FeedInterstitialEventInput,
  FeedInterstitialEventName,
  FeedInterstitialKind,
} from '@mention/shared-types';
import { metrics } from '../../../utils/metrics';
import { baseDescriptor } from '../feedMetrics';

/** `feed_interstitial_events_total{kind,event,descriptor}` — the one card metric. */
export const INTERSTITIAL_EVENT_METRIC = 'feed_interstitial_events_total';

/**
 * The runtime mirrors of the `FeedInterstitialKind` / `FeedInterstitialEventName`
 * unions. Typed as a total `Record` of each union so adding a member upstream
 * fails the build here rather than silently 400-ing a valid new card kind.
 */
const INTERSTITIAL_KINDS: Record<FeedInterstitialKind, true> = {
  suggestedUsers: true,
  suggestedFeeds: true,
  suggestedStarterPacks: true,
  similarAccounts: true,
};

const INTERSTITIAL_EVENTS: Record<FeedInterstitialEventName, true> = {
  impression: true,
  click: true,
  follow: true,
  subscribe: true,
  use: true,
  dismiss: true,
  seeMore: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInterstitialKind(value: unknown): value is FeedInterstitialKind {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INTERSTITIAL_KINDS, value);
}

function isInterstitialEventName(value: unknown): value is FeedInterstitialEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INTERSTITIAL_EVENTS, value);
}

export type ParsedInterstitialEvent =
  | { ok: true; input: FeedInterstitialEventInput }
  | { ok: false; error: string };

/**
 * Validate a client-sent card event. Every field is read defensively — the body
 * is attacker-controlled, so nothing is coerced and nothing is trusted:
 *
 *  - `feedDescriptor` must be a REAL descriptor, not merely a string. It becomes
 *    a metric label (via its base token), so an arbitrary string would let a
 *    client mint unbounded label values and blow up the metric's cardinality.
 *  - `kind` / `event` must be members of their unions; anything else is a 400.
 *  - `position` is optional and, when present, must be a non-negative integer. It
 *    is carried for completeness and deliberately NEVER labelled (it would be
 *    per-item cardinality).
 */
export function parseInterstitialEvent(body: unknown): ParsedInterstitialEvent {
  if (!isRecord(body)) {
    return { ok: false, error: 'Body must be an object' };
  }

  const { feedDescriptor, slotKey, kind, event, position } = body;

  if (typeof feedDescriptor !== 'string' || !isValidFeedDescriptor(feedDescriptor)) {
    return { ok: false, error: 'Invalid or missing feedDescriptor' };
  }

  if (typeof slotKey !== 'string' || slotKey.trim().length === 0) {
    return { ok: false, error: 'Invalid or missing slotKey' };
  }

  if (!isInterstitialKind(kind)) {
    return { ok: false, error: 'Invalid or missing kind' };
  }

  if (!isInterstitialEventName(event)) {
    return { ok: false, error: 'Invalid or missing event' };
  }

  if (position !== undefined && (typeof position !== 'number' || !Number.isInteger(position) || position < 0)) {
    return { ok: false, error: 'Invalid position' };
  }

  const input: FeedInterstitialEventInput = { feedDescriptor, slotKey, kind, event };
  if (typeof position === 'number') {
    input.position = position;
  }

  return { ok: true, input };
}

/**
 * Count a card event. Synchronous and I/O-free by design (see the file header):
 * the counter lives in the in-process metrics Map and is scraped from
 * `/metrics`, so reporting an impression can never add latency to a feed
 * interaction.
 */
export function recordInterstitialEvent(input: FeedInterstitialEventInput): void {
  metrics.incrementCounter(INTERSTITIAL_EVENT_METRIC, 1, {
    kind: input.kind,
    event: input.event,
    descriptor: baseDescriptor(input.feedDescriptor),
  });
}
