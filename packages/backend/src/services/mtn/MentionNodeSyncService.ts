/**
 * Mention Node Sync Service (MTN Protocol — B3 bidirectional node sync)
 *
 * The two-way sync between a user's personal data node (a `mention-node`) and
 * Mention's fast local copy:
 *
 *  - INGEST ({@link ingestFromNode}): pulls a user's authentic signed-record
 *    chain BACK from their node, re-verifies EVERY record, mirrors it into the
 *    `MentionSignedRecord` ledger, materializes it into the feed-readable store
 *    (`PostMaterializer.projectRecord`), and counter-signs a witness.
 *  - EXPORT ({@link exportToNode}): pushes a user's new local PUBLIC records OUT
 *    to their node (`NodeClient.pushRecords`).
 *
 * A faithful port of oxy-api's `nodeSync.service.ts`, scoped to `app.mention.*`,
 * keyed by `oxyUserId` (a string), and EXTENDED with the materialization step
 * (Mention is the feed-rendering app; Oxy is not).
 *
 * ## Absolute read-path invariant
 *
 * Every node fetch here goes through `@oxyhq/core/server`'s `safeFetch`
 * (HTTPS-only, private-IP denylist, DNS-pinned, bounded redirects) and runs ONLY
 * in the background scheduler. NOTHING in a request's read path ever calls this.
 * A down/slow/malicious node leaves Mention's mirror STALE — never wrong and
 * never slow. `ingestFromNode` / `exportToNode` NEVER throw into a caller; they
 * log and record `lastError` on the {@link MentionUserNode} row. Ingest batches
 * are bounded so a backfill never contends with the hot path.
 *
 * ## Trust model — verify everything, trust nothing the node says
 *
 * The node is untrusted transport. Every record it returns is independently
 * re-verified with {@link verifyAndStoreRecord} (the SAME chain engine the
 * dual-write uses): signature over the canonical input, recomputed `recordId`,
 * current-verification-method / subject ownership, freshness, and v2 chain
 * continuity. A record whose `publicKey` is not a current VM of THIS user's DID,
 * or whose `subject` is not this user's DID, is rejected as forged/foreign — a
 * node cannot inject a record the user did not sign.
 *
 * ## Conflict resolution
 *
 *  - **Linear append** (the normal case): a record that extends Mention's chain
 *    head by one is appended atomically, advancing the head + the cursor.
 *  - **Last-writer-wins per `(oxyUserId, nsid, rkey)`**: a record whose
 *    `issuedAt` is not newer for that key (tiebreak: higher `recordId`) is the
 *    loser — Mention keeps what it has and skips. Re-pulling an already-ingested
 *    record is therefore idempotent.
 *  - **Genuine fork**: a record authentically signed by the owner that conflicts
 *    Mention's chain is ALSO preserved (a non-chained mirror row so the unique
 *    `(oxyUserId, seq)` chain index is never violated) and wins materialization
 *    for its key. Both branches persist; nothing is deleted; the fork is logged.
 *
 * ## Anti-rewrite counter-signature
 *
 * Every recordId Mention ingests is COUNTER-SIGNED with the Mention custodial key
 * into an append-only {@link MentionNodeIngestWitness}. When the custodial key is
 * unconfigured (dev/pre-prod) witnessing is skipped (logged once) but ingest
 * still proceeds.
 *
 * ## DEFERRED — blob / media sync
 *
 * A node serves blobs by `sha256`, but Mention has NO reverse `sha256 → fileId`/
 * `url` resolver yet (the same gap that deferred the blob-ref READ side in PR
 * #280). So for an ingested post record whose `embed` carries blob refs, the
 * RECORD + text + thread structure + likes + reposts are materialized fully now;
 * the media BYTES are deferred — `PostMaterializer.resolveEmbedToMedia` is a no-op
 * until the upstream reverse content-address index lands. No fake URL is invented;
 * an existing post's fileId media survives re-projection.
 */

import { canonicalize, computeRecordId, signMessage } from '@oxyhq/protocol';
import { NodeClient, type NodeFetch } from '@oxyhq/protocol/node';
import { safeFetch } from '@oxyhq/core/server';
import { signedRecordEnvelopeSchema, type SignedRecordEnvelope } from '@oxyhq/contracts';
import MentionUserNode from '../../models/MentionUserNode';
import MentionSignedRecord from '../../models/MentionSignedRecord';
import MentionNodeIngestWitness from '../../models/MentionNodeIngestWitness';
import { logger } from '../../utils/logger';
import { getHead, getPublicLogSince } from './MentionRepoLogService';
import { verifyAndStoreRecord } from './MentionRecordService';
import { projectRecord } from './PostMaterializer';
import {
  getMentionCustodialPrivateKey,
  getMentionCustodialPublicKey,
} from './mentionRecordEnv';
import {
  MENTION_NODE_INGEST_BATCH,
  MENTION_NODE_INGEST_MAX_ITERATIONS,
  MENTION_NODE_INGEST_FETCH_TIMEOUT_MS,
  MENTION_NODE_INGEST_MAX_BYTES,
  MENTION_NODE_EXPORT_BATCH,
  MENTION_NODE_EXPORT_MAX_ITERATIONS,
  MENTION_NODE_LAST_ERROR_MAX_LEN,
} from './mentionNodes.constants';

/** True only once the missing-custodial-key warning has been logged (avoid spam). */
let warnedMissingCustodialKey = false;

/** The cached node fields the ingest worker needs. */
interface IngestNode {
  endpoint: string;
  cursor?: number;
}

/** Per-record ingest outcome, used to drive cursor advance + loop control. */
type IngestOutcome =
  | { kind: 'appended'; seq: number; recordId: string }
  | { kind: 'fork'; recordId: string }
  | { kind: 'skipped' }
  | { kind: 'stop'; reason: string };

/**
 * The injected transport for the protocol {@link NodeClient}: a thin adapter over
 * `@oxyhq/core/server`'s `safeFetch` (HTTPS-only, DNS-pinned, private-IP
 * denylist, bounded redirects). The client owns the bounded-body reads; this
 * adapter only hands it the SSRF-safe streamed response. The read-path invariant
 * still holds — this runs ONLY in the background scheduler.
 */
const nodeFetch: NodeFetch = async (url, init) => {
  const result = await safeFetch(url, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    ...(init.body ? { body: init.body } : {}),
    headersTimeoutMs: init.headersTimeoutMs,
    maxRedirects: init.maxRedirects,
  });
  return {
    status: result.status,
    headers: result.headers,
    body: result.response,
    destroy: () => result.response.destroy(),
  };
};

/** Build a {@link NodeClient} for a node endpoint with the ingest tunables. */
function makeNodeClient(endpoint: string): NodeClient {
  return new NodeClient({
    baseUrl: endpoint,
    fetch: nodeFetch,
    headersTimeoutMs: MENTION_NODE_INGEST_FETCH_TIMEOUT_MS,
    maxRedirects: 1,
    logMaxBytes: MENTION_NODE_INGEST_MAX_BYTES,
  });
}

/**
 * Counter-sign an ingested recordId with the Mention custodial key and append it
 * to the witness ledger (idempotent per recordId). Non-fatal and never throws: a
 * missing custodial key skips witnessing (warned once); a duplicate is a no-op.
 */
async function witnessRecord(oxyUserId: string, recordId: string, ingestedAt: number): Promise<void> {
  const privateKey = getMentionCustodialPrivateKey();
  const publicKey = getMentionCustodialPublicKey();
  if (!privateKey || !publicKey) {
    if (!warnedMissingCustodialKey) {
      warnedMissingCustodialKey = true;
      logger.warn('MentionNodeSync: ingest counter-signing skipped — Mention custodial key not configured');
    }
    return;
  }
  try {
    const witnessSignature = await signMessage(
      canonicalize({ recordId, oxyUserId, ingestedAt }),
      privateKey,
    );
    await MentionNodeIngestWitness.create({ oxyUserId, recordId, witnessSignature, ingestedAt });
  } catch (err) {
    // A duplicate recordId (E11000) means we already witnessed it — expected on a
    // re-pull. Anything else is logged, never thrown (background-safe).
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
      return;
    }
    logger.warn('MentionNodeSync: ingest counter-signature failed (non-fatal)', {
      oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Materialize a verified+stored record into the feed-readable store. Best-effort
 * and non-throwing (the materializer itself never throws); a projection failure
 * is logged but never aborts the ingest run.
 */
async function materialize(envelope: SignedRecordEnvelope): Promise<void> {
  try {
    const result = await projectRecord(envelope);
    if (!result.ok) {
      logger.debug('MentionNodeSync: projectRecord skipped an ingested record', {
        collection: envelope.collection,
        rkey: envelope.rkey,
        reason: result.reason,
      });
    }
  } catch (err) {
    logger.warn('MentionNodeSync: projectRecord threw (non-fatal)', {
      collection: envelope.collection,
      rkey: envelope.rkey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The current materialized record for an AtProto-style `(nsid, rkey)` key, as the
 * minimal `{ issuedAt, recordId }` LWW needs. Reads Mention's own copy only.
 */
async function currentKeyValue(
  oxyUserId: string,
  nsid: string,
  rkey: string,
): Promise<{ issuedAt: number; recordId: string } | null> {
  const row = await MentionSignedRecord.findOne({ oxyUserId, nsid, rkey, verified: true })
    .sort({ createdAt: -1 })
    .lean<{ recordId?: string; envelope?: { issuedAt?: number } } | null>();
  if (!row || typeof row.envelope?.issuedAt !== 'number' || typeof row.recordId !== 'string') {
    return null;
  }
  return { issuedAt: row.envelope.issuedAt, recordId: row.recordId };
}

/**
 * Last-writer-wins decision: does the incoming record supersede the existing
 * value for its key? Newer `issuedAt` wins; on an exact `issuedAt` tie the higher
 * `recordId` (string compare) wins. No existing value → incoming always wins.
 */
function incomingWinsLww(
  incoming: { issuedAt: number; recordId: string },
  existing: { issuedAt: number; recordId: string } | null,
): boolean {
  if (!existing) return true;
  if (incoming.issuedAt !== existing.issuedAt) return incoming.issuedAt > existing.issuedAt;
  return incoming.recordId > existing.recordId;
}

/**
 * Persist a forked / tie-breaking envelope as a NON-chained mirror row. It keeps
 * the AtProto `(nsid, rkey)` materialization fields and `recordId` (so it becomes
 * the current value for its key by `createdAt`) but deliberately carries NO `seq`
 * — the authentic linear chain (and its unique `(oxyUserId, seq)` index) is left
 * untouched, so both the existing chain row AND this fork branch persist. The
 * unique `recordId` index makes a re-ingested fork idempotent.
 */
async function storeForkMirror(env: SignedRecordEnvelope, oxyUserId: string, recordId: string): Promise<boolean> {
  try {
    await MentionSignedRecord.create({
      subjectDid: env.subject,
      oxyUserId,
      type: env.type,
      envelope: env,
      publicKey: env.publicKey,
      verified: true,
      // No `seq`/`prev` — intentionally off the linear chain (fork archive).
      recordId,
      nsid: env.version === 2 ? env.collection : undefined,
      rkey: env.version === 2 ? env.rkey : undefined,
    });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
      return false; // already stored (idempotent re-pull)
    }
    throw err;
  }
}

/**
 * Verify + ingest a single envelope from the node. Drives the cursor/loop via the
 * returned {@link IngestOutcome}. `verifyAndStoreRecord` does the heavy lifting
 * (re-verify + atomic append + head advance); its rejection reason routes the
 * record to LWW-skip, fork-preserve, or hard-reject. On any persisted record the
 * envelope is materialized into the feed store + counter-signed.
 */
async function ingestEnvelope(env: SignedRecordEnvelope, oxyUserId: string): Promise<IngestOutcome> {
  const result = await verifyAndStoreRecord(env);

  if (result.ok) {
    const recordId = result.recordId;
    await materialize(env);
    await witnessRecord(oxyUserId, recordId, Date.now());
    return { kind: 'appended', seq: typeof result.seq === 'number' ? result.seq : -1, recordId };
  }

  switch (result.reason) {
    case 'stale_issued_at': {
      // LWW: incoming is not newer for its key — usually an idempotent re-pull.
      // Only an exact-issuedAt tie with a higher recordId flips to incoming (a
      // fork archive); otherwise Mention keeps what it has. Either way the linear
      // chain cannot advance through a stale frontier record, so we stop.
      if (env.version === 2 && env.collection && env.rkey) {
        const recordId = await computeRecordId(env);
        const existing = await currentKeyValue(oxyUserId, env.collection, env.rkey);
        if (incomingWinsLww({ issuedAt: env.issuedAt, recordId }, existing)) {
          const stored = await storeForkMirror(env, oxyUserId, recordId);
          if (stored) {
            await materialize(env);
            await witnessRecord(oxyUserId, recordId, Date.now());
            logger.info('MentionNodeSync: LWW tiebreak adopted incoming record', {
              oxyUserId,
              nsid: env.collection,
              rkey: env.rkey,
            });
            return { kind: 'stop', reason: 'lww_tiebreak' };
          }
        }
      }
      return { kind: 'skipped' };
    }

    case 'chain_fork':
    case 'bad_seq':
    case 'chain_conflict': {
      // A genuine fork: the record is authentically signed by the owner (signature
      // + ownership + freshness all passed before the chain check) but conflicts
      // Mention's chain. Preserve it append-only and let it win materialization
      // for its key (it is strictly newer — `stale_issued_at` is handled above).
      const recordId = await computeRecordId(env);
      const stored = await storeForkMirror(env, oxyUserId, recordId);
      if (stored) {
        await materialize(env);
        await witnessRecord(oxyUserId, recordId, Date.now());
      }
      logger.warn('MentionNodeSync: detected a chain fork; preserved both branches', {
        oxyUserId,
        reason: result.reason,
        recordId,
      });
      return { kind: 'fork', recordId };
    }

    case 'chain_gap':
      // Mention is missing intermediate records this one builds on — cannot append
      // out of order. Stop and leave the mirror stale at the last good seq.
      return { kind: 'stop', reason: 'chain_gap' };

    default:
      // Forged / foreign / malformed: subject_mismatch,
      // public_key_not_a_current_verification_method, untrusted_issuer,
      // bad_signature, invalid_envelope, issued_in_future. Reject and stop so a
      // poisoned log entry can never advance the mirror.
      logger.warn('MentionNodeSync: rejected a record', { oxyUserId, reason: result.reason });
      return { kind: 'stop', reason: `rejected:${result.reason}` };
  }
}

/**
 * Ingest a user's chain from their registered node into Mention's local mirror.
 *
 * Background-safe: NEVER throws. A missing/revoked/unreachable node is a no-op
 * (or records `lastError`) — the mirror simply stays as-is. On success the
 * {@link MentionUserNode} cursor (= Mention's local head seq) and `lastSyncedAt`
 * advance. Bounded iterations cap how much a single run ingests so a long backlog
 * is caught up across several scheduled runs (the hot path is never contended).
 */
export async function ingestFromNode(oxyUserId: string): Promise<void> {
  try {
    const node = await MentionUserNode.findOne({ oxyUserId, status: { $ne: 'revoked' } })
      .select('endpoint cursor')
      .lean<IngestNode | null>();
    if (!node) {
      return; // no registered node — nothing to ingest
    }

    const client = makeNodeClient(node.endpoint);

    // Compare the node's head against Mention's local head. When Mention is
    // already at or ahead of the node, there is nothing to pull — stamp the time.
    let remoteHeadSeq: number;
    try {
      const head = await client.head();
      remoteHeadSeq = typeof head.seq === 'number' && Number.isFinite(head.seq) ? head.seq : -1;
    } catch (err) {
      await recordIngestError(oxyUserId, err);
      return;
    }

    const localHead = await getHead(oxyUserId);
    const localHeadSeq = localHead ? localHead.seq : -1;
    // Never re-pull below our own head: start from the greater of the persisted
    // cursor and the live local head (idempotent — avoids re-ingesting).
    let cursor = Math.max(typeof node.cursor === 'number' ? node.cursor : -1, localHeadSeq);

    if (remoteHeadSeq <= cursor) {
      await markSynced(oxyUserId, cursor, true);
      return;
    }

    let stopReason: string | null = null;

    for (let iteration = 0; iteration < MENTION_NODE_INGEST_MAX_ITERATIONS && !stopReason; iteration += 1) {
      let page: unknown[];
      try {
        page = (await client.log(cursor, MENTION_NODE_INGEST_BATCH)).records;
      } catch (err) {
        await recordIngestError(oxyUserId, err);
        return;
      }
      if (page.length === 0) {
        break; // caught up
      }

      for (const raw of page) {
        const parsed = signedRecordEnvelopeSchema.safeParse(raw);
        if (!parsed.success) {
          stopReason = 'rejected:invalid_envelope';
          logger.warn('MentionNodeSync: rejected a malformed envelope', { oxyUserId });
          break;
        }
        const env = parsed.data;

        // Already mirrored (below our advanced cursor)? Skip without re-work.
        if (env.version === 2 && typeof env.seq === 'number' && env.seq <= cursor) {
          continue;
        }

        const outcome = await ingestEnvelope(env, oxyUserId);
        if (outcome.kind === 'appended') {
          cursor = outcome.seq >= 0 ? outcome.seq : cursor;
        } else if (outcome.kind === 'fork') {
          stopReason = 'chain_fork';
          break;
        } else if (outcome.kind === 'stop') {
          stopReason = outcome.reason;
          break;
        }
        // 'skipped' → continue to the next record (LWW loser / idempotent).
      }

      // A short page means the node has no more records right now.
      if (page.length < MENTION_NODE_INGEST_BATCH) {
        break;
      }
    }

    if (stopReason && stopReason !== 'lww_tiebreak') {
      await MentionUserNode.updateOne(
        { oxyUserId, status: { $ne: 'revoked' } },
        { $set: { cursor, lastSyncedAt: new Date(), lastError: stopReason.slice(0, MENTION_NODE_LAST_ERROR_MAX_LEN) } },
      );
    } else {
      await markSynced(oxyUserId, cursor, true);
    }
  } catch (err) {
    // Background-safe: a programming/DB error must never escape the worker.
    logger.error('MentionNodeSync: ingest encountered an error', {
      oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordIngestError(oxyUserId, err).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/*  Export (Mention → node)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Push a user's new local PUBLIC records OUT to their registered node.
 *
 * Background-safe: NEVER throws. Reads the user's PUBLIC signed-record log
 * (`getPublicLogSince`, which excludes private bookmarks) from the node's last
 * acknowledged `seq` and pushes it in bounded batches via `NodeClient.pushRecords`.
 * The node independently re-verifies every pushed record (the same trust model in
 * reverse), so a push can never corrupt a node; a node-side rejection is logged
 * and the export stops at the last accepted record.
 *
 * Used by the scheduler for `mode:'push'` nodes; pull-mode nodes pace their own
 * sync and are NOT exported to here.
 */
export async function exportToNode(oxyUserId: string): Promise<void> {
  try {
    const node = await MentionUserNode.findOne({ oxyUserId, status: { $ne: 'revoked' } })
      .select('endpoint')
      .lean<{ endpoint: string } | null>();
    if (!node) {
      return;
    }

    const client = makeNodeClient(node.endpoint);

    // The node's head seq is the high-water mark of what it already has.
    let remoteHeadSeq: number;
    try {
      const head = await client.head();
      remoteHeadSeq = typeof head.seq === 'number' && Number.isFinite(head.seq) ? head.seq : -1;
    } catch (err) {
      await recordIngestError(oxyUserId, err);
      return;
    }

    let cursor = remoteHeadSeq;

    for (let iteration = 0; iteration < MENTION_NODE_EXPORT_MAX_ITERATIONS; iteration += 1) {
      const batch = await getPublicLogSince(oxyUserId, cursor, MENTION_NODE_EXPORT_BATCH);
      if (batch.length === 0) {
        break; // node is caught up with our public log
      }

      let pushed: Awaited<ReturnType<NodeClient['pushRecords']>>;
      try {
        pushed = await client.pushRecords(batch);
      } catch (err) {
        await recordIngestError(oxyUserId, err);
        return;
      }

      // Advance the cursor by the records the node accepted in order. A per-item
      // rejection stops the export at the last accepted seq (logged); the next
      // run retries from there.
      let advanced = false;
      for (let i = 0; i < batch.length; i += 1) {
        const itemResult = pushed.results[i];
        const envelope = batch[i];
        if (itemResult?.ok && envelope.version === 2 && typeof envelope.seq === 'number') {
          cursor = envelope.seq;
          advanced = true;
        } else if (itemResult && !itemResult.ok) {
          logger.warn('MentionNodeSync: node rejected an exported record; stopping export', {
            oxyUserId,
            reason: itemResult.reason,
          });
          await markSynced(oxyUserId, cursor, false);
          return;
        }
      }

      if (!advanced || batch.length < MENTION_NODE_EXPORT_BATCH) {
        break;
      }
    }

    await markSynced(oxyUserId, cursor, true);
  } catch (err) {
    logger.error('MentionNodeSync: export encountered an error', {
      oxyUserId,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordIngestError(oxyUserId, err).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/*  Cursor / error bookkeeping                                                */
/* -------------------------------------------------------------------------- */

/** Advance the cursor + stamp `lastSyncedAt`; clear `lastError` when requested. */
async function markSynced(oxyUserId: string, cursor: number, clearError: boolean): Promise<void> {
  await MentionUserNode.updateOne(
    { oxyUserId, status: { $ne: 'revoked' } },
    {
      $set: { cursor, lastSyncedAt: new Date() },
      ...(clearError ? { $unset: { lastError: '' } } : {}),
    },
  );
}

/** Record a non-throwing sync failure as `lastError` on the node row. */
async function recordIngestError(oxyUserId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.debug('MentionNodeSync: node fetch failed', { oxyUserId, error: message });
  await MentionUserNode.updateOne(
    { oxyUserId, status: { $ne: 'revoked' } },
    { $set: { lastError: message.slice(0, MENTION_NODE_LAST_ERROR_MAX_LEN), lastSyncedAt: new Date() } },
  );
}
