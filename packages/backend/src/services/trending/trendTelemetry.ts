/**
 * Trending-topic TELEMETRY — validation, the batch token, and the one counter.
 *
 * Trends are recommendations, and until this module existed they were the only
 * recommendation surface nobody measured: three screens render them and none
 * could say whether a reader ever pressed one.
 *
 * Three constraints shape this file:
 *
 *  1. It has its OWN endpoint (`POST /trending/events`), not the card one.
 *     `parseInterstitialEvent` requires a valid `feedDescriptor` and a trend
 *     pressed in the right rail or in search sits in no feed at all. A trend
 *     pressed inside the in-feed card therefore reports to BOTH endpoints, on
 *     purpose: `feed_interstitial_events_total{kind='trendingTopics'}` compares
 *     that card against the other card kinds, while
 *     `trend_events_total{surface='interstitial'}` compares that surface against
 *     the other places a trend is shown. Different denominators, different
 *     questions — do not "fix" one away by folding it into the other.
 *  2. `recId` is NEVER a metric label. It is high-cardinality by construction
 *     (a new batch every 30 minutes) AND client-supplied. It is shape-validated
 *     and then consumed to derive ONE bounded label, `freshness`, which answers
 *     something real: how many presses come from a page cached in a CDN whose
 *     batch has already rotated. `rank` is likewise carried and never labelled,
 *     exactly like `position` in the interstitial module.
 *  3. Anonymous readers COUNT. This deliberately diverges from the interstitial
 *     precedent, which 200-no-ops for them: cards are only ever planned for
 *     authenticated viewers, whereas `/trending` is public and the widget renders
 *     for signed-out visitors. Dropping their presses would bias the metric
 *     toward logged-in behaviour.
 *
 * Pure and synchronous, with no Express import, so it is unit-testable without
 * pulling in the app — the same reason `interstitialTelemetry.ts` lives outside
 * its controller.
 */

import type {
  TrendEventInput,
  TrendEventName,
  TrendEventSurface,
  TrendEventType,
} from '@mention/shared-types';
import { metrics } from '../../utils/metrics';

/** `trend_events_total{type,event,surface,freshness}` — the one trend metric. */
export const TREND_EVENT_METRIC = 'trend_events_total';

/**
 * The runtime mirrors of the `TrendEventType` / `TrendEventName` /
 * `TrendEventSurface` unions. Each is typed as a TOTAL `Record` of its union so
 * adding a member upstream fails the build here rather than silently 400-ing a
 * value the rest of the app considers valid.
 */
const TREND_TYPES: Record<TrendEventType, true> = {
  hashtag: true,
  topic: true,
  entity: true,
};

const TREND_EVENTS: Record<TrendEventName, true> = {
  click: true,
  seen: true,
};

const TREND_SURFACES: Record<TrendEventSurface, true> = {
  widget: true,
  explore: true,
  search: true,
  interstitial: true,
  history: true,
  feeds: true,
};

/**
 * A batch token is base-36 of a millisecond timestamp: lowercase alphanumeric,
 * 8 characters for any date this side of 5138. The bound is generous enough to
 * outlive that and tight enough that no client can smuggle a payload through it.
 */
const REC_ID_PATTERN = /^[0-9a-z]{1,12}$/;

/**
 * How the batch a reader acted on relates to the batch that is current NOW.
 *
 * `unknown` is its own value rather than being folded into `stale`: a client
 * that sent no token at all (a history row, an old build) is a different
 * measurement from one that sent a token for a batch that has since rotated.
 */
export type TrendFreshness = 'fresh' | 'stale' | 'unknown';

/**
 * Mint the token for a batch: base-36 of its `calculatedAt`.
 *
 * Deterministic ON PURPOSE. `GET /trending` is cached twice — a CDN `s-maxage`
 * and a 30-minute Redis entry — so a per-request random token would be computed
 * once, frozen into the shared entry, and then handed to every viewer as if it
 * were their own. One token per batch is the only value that survives both
 * caches while still saying something true.
 */
export function mintTrendRecId(calculatedAt: Date): string {
  return calculatedAt.getTime().toString(36);
}

/**
 * Compare a submitted token against the current batch's.
 *
 * The submitted token is NOT trusted to be a real batch — it is only ever
 * compared, never parsed back into a date, so a well-formed token for a batch
 * that never existed simply reads as `stale`.
 */
export function resolveTrendFreshness(
  submitted: string | undefined,
  current: string | null,
): TrendFreshness {
  if (!submitted || !current) return 'unknown';
  return submitted === current ? 'fresh' : 'stale';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTrendEventName(value: unknown): value is TrendEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TREND_EVENTS, value);
}

function isTrendEventType(value: unknown): value is TrendEventType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TREND_TYPES, value);
}

function isTrendEventSurface(value: unknown): value is TrendEventSurface {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TREND_SURFACES, value);
}

export type ParsedTrendEvent =
  | { ok: true; input: TrendEventInput }
  | { ok: false; error: string };

/**
 * Validate a client-sent trend event. The body is attacker-controlled, so
 * nothing is coerced and nothing is trusted:
 *
 *  - `event` / `type` / `surface` must be members of their unions; each becomes
 *    a metric label, so anything else is a 400 rather than an "other" bucket.
 *  - `rank` is optional and, when present, must be a positive integer (it is a
 *    1-based list position). Carried, never labelled.
 *  - `recId` is optional and shape-checked only. It is never labelled, so its
 *    cardinality cannot hurt the metric; the bound exists to keep an arbitrary
 *    client string out of the request body's semantics entirely.
 */
export function parseTrendEvent(body: unknown): ParsedTrendEvent {
  if (!isRecord(body)) {
    return { ok: false, error: 'Body must be an object' };
  }

  const { event, type, surface, rank, recId } = body;

  if (!isTrendEventName(event)) {
    return { ok: false, error: 'Invalid or missing event' };
  }

  if (!isTrendEventType(type)) {
    return { ok: false, error: 'Invalid or missing type' };
  }

  if (!isTrendEventSurface(surface)) {
    return { ok: false, error: 'Invalid or missing surface' };
  }

  if (rank !== undefined && (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1)) {
    return { ok: false, error: 'Invalid rank' };
  }

  if (recId !== undefined && (typeof recId !== 'string' || !REC_ID_PATTERN.test(recId))) {
    return { ok: false, error: 'Invalid recId' };
  }

  const input: TrendEventInput = { event, type, surface };
  if (typeof rank === 'number') input.rank = rank;
  if (typeof recId === 'string') input.recId = recId;

  return { ok: true, input };
}

/**
 * Count a trend event. Synchronous and I/O-free by design: the counter lives in
 * the in-process metrics registry and is scraped from the protected
 * `/internal/metrics` endpoint, so reporting a press can never add latency.
 *
 * `currentRecId` is the token of the batch that is current right now — the
 * caller resolves it (a cached read on the server) so this function stays pure.
 * `null` means it could not be resolved, which reads as `unknown` rather than
 * pretending every press is stale.
 *
 * Label ceiling: 3 types × 2 events × 5 surfaces × 3 freshness values = 90
 * series. Nothing per-trend, per-position or per-viewer is emitted.
 */
export function recordTrendEvent(input: TrendEventInput, currentRecId: string | null): void {
  metrics.incrementCounter(TREND_EVENT_METRIC, 1, {
    type: input.type,
    event: input.event,
    surface: input.surface,
    freshness: resolveTrendFreshness(input.recId, currentRecId),
  });
}
