/**
 * OxySignalsClient — the SINGLE seam between Mention and the Oxy
 * `POST /app-signals/ingest` contract.
 *
 * Mention reports cross-app recommendation signals (endorsements + interest
 * scores) using its SERVICE token (granted the `signals:write` scope). The
 * source application is derived by Oxy from the token (`req.serviceApp.appId`),
 * so Mention never sends a `clientId`/`appId` here — it can only write signals
 * scoped to itself.
 *
 * The endpoint requires at least one non-empty array; this adapter therefore
 * no-ops (without a network call) when given nothing to send, and chunks large
 * batches to stay under the contract's `max(500)` per array.
 */

import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';

/** Oxy signals ingest endpoint path (service-token call). */
const INGEST_PATH = '/app-signals/ingest';

/**
 * Interaction-affinity events endpoint path (service-token call). Oxy folds
 * these into decayed per-app affinity edges (`fromUserId`→`toUserId`) that boost
 * recommendations. The source application is derived from the service credential
 * (Mention's Oxy `Application`), so no `appId`/`clientId` is sent.
 */
const EVENTS_PATH = '/app-signals/events';

/**
 * Max edges/items per ingest request. The Oxy contract caps each array at 500;
 * we chunk at that boundary so a large desired-state push or interest batch is
 * split across multiple idempotent requests.
 */
const INGEST_CHUNK_SIZE = 500;

/**
 * Max affinity events per `/app-signals/events` request. The Oxy contract caps
 * the `events` array at 1000; we chunk at that boundary so a large drain batch
 * is split across multiple idempotent requests.
 */
const EVENTS_CHUNK_SIZE = 1000;

/** One endorsement edge: `ownerId` endorses `memberId`. */
export interface EndorsementEdge {
  ownerId: string;
  memberId: string;
  /** `'add'` (default) or `'remove'` to retract the edge. */
  op?: 'add' | 'remove';
  /** Stable id of the source scope (e.g. the starter-pack/list `_id`). */
  sourceId?: string;
}

/** One interest signal: how interested `userId` is (0..1). */
export interface InterestSignal {
  userId: string;
  /** Clamped to [0, 1] by the Oxy contract. */
  interestScore: number;
}

/**
 * The interaction types the Oxy `/app-signals/events` contract accepts. Mention
 * only emits a subset (`like`, `reply`, `boost`, `quote`) for v1; the full union
 * mirrors the Oxy contract so the wire type never drifts.
 */
export type AffinityEventType =
  | 'like'
  | 'reply'
  | 'boost'
  | 'follow'
  | 'mention'
  | 'profile_view'
  | 'quote'
  | 'repost';

/**
 * One interaction-affinity event. Local wire type mirroring the Oxy
 * `/app-signals/events` contract (contracts are not published with it). Oxy
 * dedupes re-delivery on `eventId`.
 */
export interface AffinityEvent {
  fromUserId: string;
  toUserId: string;
  type: AffinityEventType;
  /** Optional relative weight; Oxy defaults it when omitted. */
  weight?: number;
  /** ISO-8601 occurrence time; Oxy defaults to receipt time when omitted. */
  occurredAt?: string;
  /** Stable id for idempotent re-delivery (e.g. `like:<likeId>`). */
  eventId?: string;
}

/** Body sent to `POST /app-signals/ingest`. */
interface SignalIngestBody {
  endorsements?: EndorsementEdge[];
  interests?: InterestSignal[];
}

/** Body sent to `POST /app-signals/events`. */
interface AffinityEventsBody {
  events: AffinityEvent[];
}

/** Split an array into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return items.length > 0 ? [items] : [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Adapter over the Oxy app-signals ingest endpoint. Stateless; safe to share.
 */
export class OxySignalsClient {
  /**
   * Push endorsement edges (desired-state add/remove). No-op when `edges` is
   * empty. THROWS on transport/HTTP failure so the caller (EndorsementSignal
   * Service) can leave the work pending in its outbox and retry.
   */
  async pushEndorsements(edges: EndorsementEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const client = getServiceOxyClient();
    for (const batch of chunk(edges, INGEST_CHUNK_SIZE)) {
      const body: SignalIngestBody = { endorsements: batch };
      await client.makeServiceRequest('POST', INGEST_PATH, body);
    }
    logger.debug(`[OxySignalsClient] pushed ${edges.length} endorsement edges`);
  }

  /**
   * Push interest signals (last-write-wins per user). No-op when `items` is
   * empty. THROWS on transport/HTTP failure so the caller can retry on the next
   * job tick.
   */
  async pushInterests(items: InterestSignal[]): Promise<void> {
    if (items.length === 0) return;
    const client = getServiceOxyClient();
    for (const batch of chunk(items, INGEST_CHUNK_SIZE)) {
      const body: SignalIngestBody = { interests: batch };
      await client.makeServiceRequest('POST', INGEST_PATH, body);
    }
    logger.debug(`[OxySignalsClient] pushed ${items.length} interest signals`);
  }

  /**
   * Push interaction-affinity events (append-only; deduped by Oxy on `eventId`).
   * No-op when `events` is empty. THROWS on transport/HTTP failure so the caller
   * (the affinity drain job) can decide whether to re-buffer or drop.
   */
  async pushEvents(events: AffinityEvent[]): Promise<void> {
    if (events.length === 0) return;
    const client = getServiceOxyClient();
    for (const batch of chunk(events, EVENTS_CHUNK_SIZE)) {
      const body: AffinityEventsBody = { events: batch };
      await client.makeServiceRequest('POST', EVENTS_PATH, body);
    }
    logger.debug(`[OxySignalsClient] pushed ${events.length} affinity events`);
  }
}

export const oxySignalsClient = new OxySignalsClient();
export default oxySignalsClient;
