/**
 * AffinityEventService — the ONE seam that records Mention interaction events
 * for Oxy's cross-app recommendation affinity graph.
 *
 * Model: when a user LIKES / REPLIES-TO / BOOSTS / QUOTES another user's post,
 * that expresses affinity from the actor toward the content's author. Oxy folds
 * these events into decayed per-app affinity edges (`fromUserId`→`toUserId`)
 * that boost recommendations. Mention only reports the raw interaction; Oxy owns
 * all weighting and decay.
 *
 * Design (best-effort, decoupled from the request path):
 *  - Interaction events are HIGH-VOLUME, so we do NOT push per-event
 *    synchronously and we do NOT use a durable per-event Mongo outbox. Instead
 *    {@link record} `LPUSH`es a compact JSON event onto a bounded Redis list and
 *    returns immediately — fire-and-forget. A Redis failure (or absent Redis)
 *    NEVER affects the user action: it is logged at `debug` and swallowed.
 *  - The list is capped ({@link AFFINITY_BUFFER_MAX_LEN}) via `LTRIM` on every
 *    push, so a stuck drain can never grow the buffer unbounded — the oldest
 *    events are dropped, which is acceptable for affinity.
 *  - A periodic BullMQ job ({@link drainOnce}) drains the list in bounded
 *    batches and hands them to {@link OxySignalsClient.pushEvents}. On push
 *    failure it re-buffers a bounded amount and stops; dropping some events is
 *    acceptable.
 *
 * Self-interactions (`from === to`) are skipped — a user liking/replying to
 * their own post carries no affinity signal.
 */

import { getRedisClient, isRedisConnected } from '../utils/redis';
import { logger } from '../utils/logger';
import {
  oxySignalsClient,
  type OxySignalsClient,
  type AffinityEvent,
  type AffinityEventType,
} from './OxySignalsClient';

/** Redis list key holding buffered, not-yet-pushed affinity events. */
export const AFFINITY_BUFFER_KEY = 'affinity:events:buffer';

/**
 * Hard cap on the buffered event list. `record` trims the list to this length
 * after every push so a stalled drain (Oxy down, Redis-only fleet) can never
 * grow the buffer without bound. At the cap, the OLDEST events are dropped.
 */
export const AFFINITY_BUFFER_MAX_LEN = 50_000;

/** Max events pulled from the buffer per drain tick. */
export const AFFINITY_DRAIN_BATCH_SIZE = 1000;

/** One interaction to record. `type` is the affinity event kind. */
export interface RecordAffinityArgs {
  fromUserId: string;
  toUserId: string;
  type: AffinityEventType;
  /** Stable id for idempotent re-delivery (e.g. `like:<likeId>`). */
  eventId?: string;
  /** ISO-8601 occurrence time; defaults to now when omitted. */
  occurredAt?: string;
}

export class AffinityEventService {
  constructor(private readonly signalsClient: OxySignalsClient = oxySignalsClient) {}

  /**
   * Fire-and-forget: buffer one interaction event for later delivery to Oxy.
   *
   * NEVER throws — a Redis failure or absent Redis is logged at `debug` and
   * swallowed so the caller's user action is never affected. Self-interactions
   * (`fromUserId === toUserId`) and events missing either party are dropped.
   *
   * Returns `true` when an event was buffered, `false` when it was skipped or
   * buffering failed — the boolean is for tests/observability; callers invoke
   * this fire-and-forget and ignore the result.
   */
  async record(args: RecordAffinityArgs): Promise<boolean> {
    const { fromUserId, toUserId, type } = args;
    if (!fromUserId || !toUserId || fromUserId === toUserId) return false;

    try {
      if (!(await isRedisConnected())) return false;

      const event: AffinityEvent = {
        fromUserId,
        toUserId,
        type,
        occurredAt: args.occurredAt ?? new Date().toISOString(),
        ...(args.eventId ? { eventId: args.eventId } : {}),
      };

      const client = getRedisClient();
      await client.lPush(AFFINITY_BUFFER_KEY, JSON.stringify(event));
      // Cap the buffer so a stalled drain never grows it unbounded. LPUSH writes
      // to the head, so [0, MAX-1] keeps the newest events and drops the oldest.
      await client.lTrim(AFFINITY_BUFFER_KEY, 0, AFFINITY_BUFFER_MAX_LEN - 1);
      return true;
    } catch (error) {
      // Buffering is best-effort and must never surface to the caller.
      logger.debug('[AffinityEvent] failed to buffer event (ignored)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Drain up to one batch of buffered events and push them to Oxy. Called by the
   * periodic BullMQ job. No-op (and returns 0) when Redis is unavailable or the
   * buffer is empty.
   *
   * Batch claim is atomic against concurrent drainers: `LRANGE` + `LTRIM` run in
   * one `MULTI` so a claimed slice is removed from the buffer in the same
   * round-trip and no other drainer re-reads it.
   *
   * On push failure the claimed events are re-buffered ONCE (bounded by the same
   * cap) and the tick stops — the next tick retries. Malformed entries are
   * dropped (never re-buffered). Returns the number of events successfully
   * pushed to Oxy.
   */
  async drainOnce(): Promise<number> {
    let claimed: string[];
    try {
      if (!(await isRedisConnected())) return 0;
      const client = getRedisClient();

      // Atomically read the newest batch (head) and trim it off in one MULTI so
      // a concurrent drainer on another process can't claim the same slice.
      const results = await client
        .multi()
        .lRange(AFFINITY_BUFFER_KEY, 0, AFFINITY_DRAIN_BATCH_SIZE - 1)
        .lTrim(AFFINITY_BUFFER_KEY, AFFINITY_DRAIN_BATCH_SIZE, -1)
        .exec();

      // results[0] is the LRANGE reply (an array of buffered JSON strings).
      const raw = results?.[0];
      claimed = Array.isArray(raw) ? raw.map((entry) => String(entry)) : [];
    } catch (error) {
      logger.warn('[AffinityEvent] drain claim failed (skipping tick)', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }

    if (claimed.length === 0) return 0;

    const events: AffinityEvent[] = [];
    for (const entry of claimed) {
      const parsed = this.parseEvent(entry);
      if (parsed) events.push(parsed);
    }

    if (events.length === 0) return 0;

    try {
      await this.signalsClient.pushEvents(events);
      logger.debug(`[AffinityEvent] drained ${events.length} events to Oxy`);
      return events.length;
    } catch (error) {
      // Push failed — re-buffer the claimed (still-valid) events ONCE so they are
      // retried next tick, then stop. The buffer cap still applies, so this can
      // never grow unbounded.
      logger.warn('[AffinityEvent] push failed; re-buffering claimed batch', {
        count: events.length,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.reBuffer(events);
      return 0;
    }
  }

  /** Re-buffer events after a failed push. Best-effort; swallows Redis errors. */
  private async reBuffer(events: AffinityEvent[]): Promise<void> {
    try {
      const client = getRedisClient();
      const payloads = events.map((event) => JSON.stringify(event));
      await client.lPush(AFFINITY_BUFFER_KEY, payloads);
      await client.lTrim(AFFINITY_BUFFER_KEY, 0, AFFINITY_BUFFER_MAX_LEN - 1);
    } catch (error) {
      logger.debug('[AffinityEvent] re-buffer failed (events dropped)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Parse a buffered JSON entry into an event, or null when malformed. */
  private parseEvent(entry: string): AffinityEvent | null {
    try {
      const value: unknown = JSON.parse(entry);
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as AffinityEvent).fromUserId === 'string' &&
        typeof (value as AffinityEvent).toUserId === 'string' &&
        typeof (value as AffinityEvent).type === 'string'
      ) {
        return value as AffinityEvent;
      }
      return null;
    } catch {
      return null;
    }
  }
}

export const affinityEventService = new AffinityEventService();
export default affinityEventService;
