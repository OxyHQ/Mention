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
 * Max edges/items per ingest request. The Oxy contract caps each array at 500;
 * we chunk at that boundary so a large desired-state push or interest batch is
 * split across multiple idempotent requests.
 */
const INGEST_CHUNK_SIZE = 500;

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

/** Body sent to `POST /app-signals/ingest`. */
interface SignalIngestBody {
  endorsements?: EndorsementEdge[];
  interests?: InterestSignal[];
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
}

export const oxySignalsClient = new OxySignalsClient();
export default oxySignalsClient;
