/**
 * Post-interaction TELEMETRY — validation for `POST /feed/mtn/interactions`.
 *
 * The route takes a BATCH. A feed reports many rows in one pass (a screenful
 * crossing the dwell gate together, or a teardown flush), and the previous
 * one-request-per-row contract meant a fast scroll fired 15–20 requests per
 * second — straight into `feedIPRateLimiter` (10/s per IP), which rejected the
 * overflow and lost the signal.
 *
 * Everything here is pure and synchronous, and lives outside the controller so
 * it can be unit-tested without importing the Express app — same reason as
 * `interstitials/interstitialTelemetry.ts`.
 */

import { FEED_INTERACTION_BATCH_LIMIT } from '@mention/shared-types';
import type { FeedInteractionEventName, FeedInteractionInput } from '@mention/shared-types';

/**
 * Runtime mirror of the `FeedInteractionEventName` union. Typed as a TOTAL
 * `Record` of the union so adding a member upstream fails the build here rather
 * than silently 400-ing a valid new event.
 */
const INTERACTION_EVENTS: Record<FeedInteractionEventName, true> = {
  impression: true,
  click: true,
  like: true,
  reply: true,
  boost: true,
  save: true,
  report: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isInteractionEventName(value: unknown): value is FeedInteractionEventName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INTERACTION_EVENTS, value);
}

export type ParsedFeedInteractionBatch =
  | { ok: true; interactions: FeedInteractionInput[] }
  | { ok: false; error: string };

/**
 * Validate one entry of the batch. The body is attacker-controlled, so nothing
 * is coerced and nothing is trusted:
 *
 *  - `feedDescriptor` and `postUri` must be non-empty strings. `postUri` is NOT
 *    validated as an id here — `trackFeedInteraction` already resolves it to a
 *    real public, published, non-self post before any ranking side effect runs,
 *    which is the check that actually matters.
 *  - `event` must be a member of the union; anything else fails the batch.
 *  - `durationMs` is optional and, when present, must be a finite non-negative
 *    number. It is clamped again server-side before it reaches the dwell
 *    average, so this only rejects values that are not numbers at all.
 */
function parseInteraction(value: unknown): FeedInteractionInput | string {
  if (!isRecord(value)) {
    return 'Each interaction must be an object';
  }

  const { feedDescriptor, postUri, event, durationMs } = value;

  if (typeof feedDescriptor !== 'string' || feedDescriptor.trim().length === 0) {
    return 'Invalid or missing feedDescriptor';
  }

  if (typeof postUri !== 'string' || postUri.trim().length === 0) {
    return 'Invalid or missing postUri';
  }

  if (!isInteractionEventName(event)) {
    return 'Invalid or missing event';
  }

  if (
    durationMs !== undefined &&
    (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0)
  ) {
    return 'Invalid durationMs';
  }

  const interaction: FeedInteractionInput = { feedDescriptor, postUri, event };
  if (typeof durationMs === 'number') {
    interaction.durationMs = durationMs;
  }
  return interaction;
}

/**
 * Validate a client-sent interaction batch.
 *
 * The batch is all-or-nothing: one malformed entry fails the whole request
 * rather than being dropped silently, so a client emitting a bad shape finds out
 * instead of quietly losing ranking signal. An empty batch is a client bug (it
 * should not have sent a request at all) and is rejected for the same reason.
 */
export function parseFeedInteractionBatch(body: unknown): ParsedFeedInteractionBatch {
  if (!isRecord(body)) {
    return { ok: false, error: 'Body must be an object' };
  }

  const { interactions } = body;
  if (!Array.isArray(interactions)) {
    return { ok: false, error: 'Missing interactions array' };
  }

  if (interactions.length === 0) {
    return { ok: false, error: 'interactions must not be empty' };
  }

  if (interactions.length > FEED_INTERACTION_BATCH_LIMIT) {
    return { ok: false, error: `interactions exceeds the ${FEED_INTERACTION_BATCH_LIMIT} per-request limit` };
  }

  const parsed: FeedInteractionInput[] = [];
  for (const entry of interactions) {
    const result = parseInteraction(entry);
    if (typeof result === 'string') {
      return { ok: false, error: result };
    }
    parsed.push(result);
  }

  return { ok: true, interactions: parsed };
}
