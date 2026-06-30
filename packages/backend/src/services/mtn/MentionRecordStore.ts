/**
 * Mention RecordStore — the @oxyhq/protocol {@link RecordStore} implementation
 * over Mention's Mongo `MentionSignedRecord` + `MentionRepoHead` models.
 *
 * This is the storage HALF of the MTN chain adapter: the protocol engine
 * (`@oxyhq/protocol`'s `verifyAndAppend`) owns verification + continuity policy
 * and delegates every read/write here. It MIRRORS oxy-api's `oxyRecordStore`,
 * including:
 *
 *  - `withTransaction` (the atomic append + head advance, with the session-less
 *    fallback for a standalone mongod in local dev),
 *  - the unique `{oxyUserId, seq}` index backstop translated to `chain_conflict`
 *    on a duplicate-key (E11000) error,
 *  - the v1 `{type}` vs v2 `{nsid, rkey}` monotonicity split (incl. the v2 guard
 *    that returns `null` when `collection`/`rkey` are missing so a malformed v2
 *    envelope cannot collapse the frontier to a global-latest comparison), and
 *  - the `nsid` denormalization of the envelope's `collection` field.
 *
 * The store is **subject-keyed by the subject DID** (the protocol's notion of a
 * subject). Mention's chain key is the Oxy account id (string), so each method
 * parses the DID back to its `oxyUserId` via {@link parseUserDid}. (Blob storage
 * is out of scope for B1 — no `BlobStore` is implemented here yet.)
 */

import mongoose, { type ClientSession } from 'mongoose';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import type { AppendOutcome, ChainHead, RecordStore } from '@oxyhq/protocol';
import { parseUserDid } from './mentionDid';
import MentionSignedRecord from '../../models/MentionSignedRecord';
import MentionRepoHead from '../../models/MentionRepoHead';
import { logger } from '../../utils/logger';

/** Default page size for the log read helpers. */
export const DEFAULT_LOG_LIMIT = 100;
/** Hard ceiling so a single log call can never scan an unbounded slice. */
const MAX_LOG_LIMIT = 500;

function clampLogLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT));
}

/**
 * Run a unit of work inside a Mongo transaction, falling back to a session-less
 * execution when the deployment does not support transactions (e.g. a standalone
 * mongod in local dev). Production runs a single-node replica set, so the
 * transactional path is the norm. Mirrors oxy-api's `oxyRecordStore`.
 */
async function withTransaction<T>(
  work: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transactionsUnsupported =
      message.includes('Transaction numbers are only allowed') ||
      message.includes('replica set') ||
      message.includes('does not support transactions');
    if (transactionsUnsupported) {
      logger.warn(
        'MentionRecordStore: transactions unsupported by this MongoDB deployment; executing without a transaction',
      );
      return work(undefined);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

/** True when an error is a MongoDB duplicate-key (E11000) error. */
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/**
 * The Mention implementation of the protocol {@link RecordStore}, backed by the
 * `MentionSignedRecord` ledger + `MentionRepoHead` head pointer.
 */
export class MentionRecordStoreImpl implements RecordStore {
  async getHead(subject: string): Promise<ChainHead | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    const head = await MentionRepoHead.findOne({ oxyUserId })
      .lean<{ seq: number; headRecordId: string; recordCount?: number } | null>();
    if (!head) {
      return null;
    }
    return {
      headRecordId: head.headRecordId,
      seq: head.seq,
      recordCount: head.recordCount ?? 0,
    };
  }

  /**
   * Persist a verified envelope and (for v2) advance the per-subject hash chain.
   *
   * v1: a single append, NO chain fields and NO head advance. v2: the append AND
   * the head advance happen atomically (one transaction, session-less fallback).
   * A duplicate-key error from the unique `{oxyUserId, seq}` / `recordId` index — a
   * concurrent write that already took this `seq` — is surfaced as
   * `chain_conflict` so the caller re-reads the head and retries.
   */
  async append(subject: string, env: SignedRecordEnvelope, recordId: string): Promise<AppendOutcome> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      // The subject DID does not belong to a user — there is no Mention chain to
      // write. Treated as a continuity conflict (no valid head).
      return { ok: false, reason: 'chain_gap' };
    }

    if (env.version === 2) {
      const seq = env.seq;
      if (typeof seq !== 'number') {
        // A v2 envelope without a numeric seq is malformed (the engine validates
        // this upstream); refuse to advance a chain with no sequence.
        return { ok: false, reason: 'bad_seq' };
      }
      try {
        return await withTransaction(async (session) => {
          const opts = session ? { session } : {};
          await MentionSignedRecord.create(
            [
              {
                subjectDid: env.subject,
                oxyUserId,
                type: env.type,
                envelope: env,
                publicKey: env.publicKey,
                verified: true,
                seq,
                prev: env.prev ?? null,
                recordId,
                // Denormalize the envelope's `collection` to the `nsid` column.
                nsid: env.collection,
                rkey: env.rkey,
              },
            ],
            opts,
          );

          await MentionRepoHead.findOneAndUpdate(
            { oxyUserId },
            {
              $set: { subjectDid: env.subject, seq, headRecordId: recordId },
              $inc: { recordCount: 1 },
              $setOnInsert: { oxyUserId },
            },
            { upsert: true, new: true, ...opts },
          );

          return { ok: true as const, recordId, seq };
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          return { ok: false, reason: 'chain_conflict' };
        }
        throw error;
      }
    }

    // v1: an unchained singleton append. No chain fields, no head advance.
    await MentionSignedRecord.create({
      subjectDid: env.subject,
      oxyUserId,
      type: env.type,
      envelope: env,
      publicKey: env.publicKey,
      verified: true,
    });
    return { ok: true, recordId, seq: -1 };
  }

  async getLogSince(subject: string, sinceSeq: number, limit: number = DEFAULT_LOG_LIMIT): Promise<SignedRecordEnvelope[]> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return [];
    }
    const rows = await MentionSignedRecord.find({ oxyUserId, seq: { $gt: sinceSeq } })
      .sort({ seq: 1 })
      .limit(clampLogLimit(limit))
      .lean<Array<{ envelope: SignedRecordEnvelope }>>();
    return rows.map((row) => row.envelope);
  }

  async resolveCursorSeq(subject: string, recordId: string): Promise<number | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    const row = await MentionSignedRecord.findOne({ oxyUserId, recordId })
      .select('seq')
      .lean<{ seq?: number } | null>();
    return typeof row?.seq === 'number' ? row.seq : null;
  }

  async materializeCurrent(subject: string, collection: string, rkey: string): Promise<SignedRecordEnvelope | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    const row = await MentionSignedRecord.findOne({ oxyUserId, nsid: collection, rkey, verified: true })
      .sort({ createdAt: -1 })
      .lean<{ envelope: SignedRecordEnvelope } | null>();
    return row?.envelope ?? null;
  }

  /**
   * Monotonicity frontier scoped to the LOGICAL record key:
   *  - v1: per `type` (the legacy singleton scope).
   *  - v2: per record KEY (`nsid`, `rkey`) — last-writer-wins for THAT key;
   *    distinct keys are independent appends.
   */
  async latestIssuedAtForKey(subject: string, env: SignedRecordEnvelope): Promise<number | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    // A v2 envelope missing its required `collection`/`rkey` would collapse the
    // filter below to a global-latest comparison across ALL keys — a false
    // replay/rollback rejection of valid appends on OTHER keys. Mirror oxy-api's
    // guard and treat it as "no prior record for this key". (The engine rejects
    // such an envelope as `invalid_envelope` upstream anyway.)
    if (env.version === 2 && (typeof env.collection !== 'string' || typeof env.rkey !== 'string')) {
      return null;
    }
    const filter =
      env.version === 2
        ? { oxyUserId: { $eq: oxyUserId }, nsid: { $eq: env.collection }, rkey: { $eq: env.rkey } }
        : { oxyUserId: { $eq: oxyUserId }, type: { $eq: env.type } };
    const latest = await MentionSignedRecord.findOne(filter)
      .sort({ createdAt: -1 })
      .lean<{ envelope?: { issuedAt?: number } } | null>();
    const latestIssuedAt = latest?.envelope?.issuedAt;
    return typeof latestIssuedAt === 'number' ? latestIssuedAt : null;
  }
}

/** The singleton Mention record store the write service drives. */
export const mentionRecordStore = new MentionRecordStoreImpl();
