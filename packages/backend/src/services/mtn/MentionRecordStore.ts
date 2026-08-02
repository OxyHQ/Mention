/**
 * Mention RecordStore — the @oxyhq/protocol {@link RecordStore} implementation
 * over Mention's `mention_signed_records` + `mention_repo_heads` Postgres tables.
 *
 * This is the storage HALF of the MTN chain adapter: the protocol engine
 * (`@oxyhq/protocol`'s `verifyAndAppend`) owns verification + continuity policy
 * and delegates every read/write here.
 *
 * The store is **subject-keyed by the subject DID** (the protocol's notion of a
 * subject). Mention's chain key is the Oxy account id (string), so each method
 * parses the DID back to its `oxyUserId` via {@link parseUserDid}. (Blob storage
 * is out of scope — no `BlobStore` is implemented here.)
 *
 * ## The three things the Postgres port had to get right
 *
 * **The append is one transaction, unconditionally.** The Mongoose version wrapped
 * `session.withTransaction` in a fallback that re-ran the work session-LESS when
 * the deployment turned out to be a standalone `mongod` — i.e. the append and the
 * head advance could land non-atomically in local dev, and a crash between them
 * left a head pointing at nothing. Postgres has no such mode, so the fallback is
 * deleted rather than ported: `db.transaction` is the only path.
 *
 * **`chainStatus <> 'conflict'` is NOT the port of Mongo's `$ne`.** Mongo's
 * `{chainStatus: {$ne: 'conflict'}}` MATCHES a document where the field is absent,
 * and every row written before fork classification existed has it absent. SQL
 * three-valued logic does the opposite — `chain_status <> 'conflict'` is NULL for
 * a NULL column and the row is dropped — so a literal translation would silently
 * hide the entire pre-classification history from `getHead`, `getLogSince` and the
 * public log. {@link canonicalChainRow} spells the NULL branch out.
 *
 * **A duplicate key means "retry", but only for the three indexes that mean it.**
 * `pgErrors.ts` exists because a SQLSTATE check that does not name its constraint
 * turns any future unique index on the table into a silent retry loop. The three
 * named here are the concurrency backstop (`{oxy_user_id, seq}`), the content
 * address (`record_id`) and the durable event key (`idempotency_key}`) — a
 * collision on any of them means another writer got there first, which is exactly
 * `chain_conflict`.
 */

import { and, asc, eq, gt, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import type { AppendOutcome, ChainHead, RecordStore } from '@oxyhq/protocol';
import { getDb } from '../../db/postgres';
import { isUniqueViolation } from '../../db/pgErrors';
import {
  MTN_CHAIN_STATUSES,
  mentionRepoHeads,
  mentionSignedRecords,
} from '../../db/schema/mtn';
import { parseUserDid } from './mentionDid';

/** Default page size for the log read helpers. */
export const DEFAULT_LOG_LIMIT = 100;
/** Hard ceiling so a single log call can never scan an unbounded slice. */
const MAX_LOG_LIMIT = 500;

/**
 * Local chain-selection metadata, deliberately OUTSIDE the signed envelope:
 * canonical records drive head/log traversal, while a conflicting fork stays
 * eligible for per-key LWW materialization but never for linear-chain state.
 *
 * Typed against the schema's own tuple so a value that the CHECK constraint would
 * reject cannot be written here in the first place.
 */
export type MtnChainStatus = (typeof MTN_CHAIN_STATUSES)[number];
export const MTN_CHAIN_STATUS: { readonly CANONICAL: MtnChainStatus; readonly CONFLICT: MtnChainStatus } = {
  CANONICAL: 'canonical',
  CONFLICT: 'conflict',
};

/**
 * The unique indexes whose violation means "a concurrent writer already took this
 * position" rather than "the caller sent something invalid". Named individually
 * because {@link isUniqueViolation} without a constraint name would map a future,
 * unrelated index onto the retry path.
 */
const CHAIN_CONFLICT_CONSTRAINTS = [
  'mention_signed_records_oxy_user_id_seq_key',
  'mention_signed_records_record_id_key',
  'mention_signed_records_idempotency_key',
] as const;

export interface StoredIdempotentRecord {
  recordId: string;
  seq: number;
  envelope: SignedRecordEnvelope;
}

function clampLogLimit(limit: number): number {
  return Math.max(1, Math.min(Math.trunc(limit) || DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT));
}

/**
 * Rows that may participate in the authoritative chain.
 *
 * The `IS NULL` arm is load-bearing, not defensive: `chain_status` is absent on
 * every row written before fork classification landed, and those rows are
 * canonical. See the module docblock.
 */
export function canonicalChainRow(): SQL {
  const clause = or(
    isNull(mentionSignedRecords.chainStatus),
    ne(mentionSignedRecords.chainStatus, MTN_CHAIN_STATUS.CONFLICT),
  );
  // `or` is only `undefined` for an empty argument list; two arguments always
  // produce a clause. Narrowed rather than asserted so the type stays honest.
  if (!clause) throw new Error('canonicalChainRow: empty clause');
  return clause;
}

/** True when an error is a duplicate key on one of the chain's own unique indexes. */
function isChainAppendConflict(error: unknown): boolean {
  return CHAIN_CONFLICT_CONSTRAINTS.some((name) => isUniqueViolation(error, name));
}

/** The envelope's self-asserted issue time, as a number SQL can sort on. */
const ENVELOPE_ISSUED_AT: SQL = sql`(${mentionSignedRecords.envelope} ->> 'issuedAt')::numeric`;

/**
 * The last-writer-wins order over the records of ONE logical key: newest
 * `issuedAt` first, a tie broken by the higher `recordId`.
 *
 * This is the order the rest of the MTN layer already states —
 * `incomingWinsLww` in `MentionNodeSyncService` is the same two comparisons in
 * TypeScript, and `@oxyhq/protocol`'s `RecordStore` contract calls
 * `materializeCurrent` "last-writer-wins" and `latestIssuedAtForKey` "the
 * monotonicity frontier ... (replay/rollback defence)". Both of those are
 * statements about `issuedAt`, so `issuedAt` has to be what the SQL sorts on.
 *
 * **`created_at` is not a stand-in for it, and the gap is not theoretical.**
 * `created_at` defaults to `now()`, which is `transaction_timestamp()`: every
 * row written inside ONE transaction — a batch backfill, a migration — carries
 * the identical value to the microsecond. `order by created_at desc limit 1`
 * over those rows is a TIE, so whichever row the scan happens to reach first
 * becomes the answer, and for `latestIssuedAtForKey` that answer is a frontier
 * BELOW the true maximum. A frontier that under-reports accepts exactly the
 * record it exists to reject (step 5 of the engine's verify: `env.issuedAt <=
 * latestIssuedAt`), and the accepted rollback is then stored with a LATER
 * `created_at` than the record it supersedes — so the disagreement between the
 * two columns is permanent from the first tie onward and every later rollback
 * for that key is accepted too.
 *
 * Sorting on `id` instead would be worse in a way that is invisible: `id` is
 * `text` holding a 24-char ObjectId hex for every pre-cutover row and a uuid v7
 * for everything after, and under the database's collation `'0' < '6'` — so
 * `order by id desc` puts EVERY post-cutover record last and reliably answers
 * with the oldest branch of the key.
 *
 * `nulls last` on both keys is deliberate: DESC defaults to NULLS FIRST, which
 * would let a row with no `issuedAt` at all win the sort and take the frontier
 * out entirely. A v1 row carries no `recordId`; it reaches only
 * `latestIssuedAtForKey`, which reads the `issuedAt` and nothing else, so the
 * tiebreak has no work to do there.
 */
export const LWW_CURRENT_ORDER: SQL[] = [
  sql`${ENVELOPE_ISSUED_AT} desc nulls last`,
  sql`${mentionSignedRecords.recordId} desc nulls last`,
];

/**
 * The Mention implementation of the protocol {@link RecordStore}, backed by the
 * `mention_signed_records` ledger + `mention_repo_heads` head pointer.
 */
export class MentionRecordStoreImpl implements RecordStore {
  async getHead(subject: string): Promise<ChainHead | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    const db = getDb();
    const [head] = await db
      .select({
        seq: mentionRepoHeads.seq,
        headRecordId: mentionRepoHeads.headRecordId,
        recordCount: mentionRepoHeads.recordCount,
      })
      .from(mentionRepoHeads)
      .where(eq(mentionRepoHeads.oxyUserId, oxyUserId))
      .limit(1);
    if (!head) {
      return null;
    }

    // Never build a new append on a head that no longer resolves to the
    // authoritative branch. Missing status is accepted for pre-classification rows.
    const [headRecord] = await db
      .select({ id: mentionSignedRecords.id })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, oxyUserId),
          eq(mentionSignedRecords.recordId, head.headRecordId),
          eq(mentionSignedRecords.seq, head.seq),
          eq(mentionSignedRecords.verified, true),
          canonicalChainRow(),
        ),
      )
      .limit(1);
    if (!headRecord) {
      throw new Error(
        `MentionRecordStore: inconsistent canonical head for ${oxyUserId}`,
      );
    }

    return {
      headRecordId: head.headRecordId,
      seq: head.seq,
      recordCount: head.recordCount,
    };
  }

  /**
   * Persist a verified envelope and (for v2) advance the per-subject hash chain.
   *
   * v1: a single append, NO chain fields and NO head advance. v2: the append AND
   * the head advance happen atomically in ONE transaction. A duplicate-key error
   * from the unique `{oxy_user_id, seq}` / `record_id` / `idempotency_key` index —
   * a concurrent write that already took this position — is surfaced as
   * `chain_conflict` so the caller re-reads the head and retries.
   */
  async append(
    subject: string,
    env: SignedRecordEnvelope,
    recordId: string,
  ): Promise<AppendOutcome> {
    return this.appendRecord(subject, env, recordId);
  }

  /**
   * Scope only the append operation to a durable producer event. The protocol
   * engine still reads the same head/frontiers; its eventual append stores the
   * event key atomically with the signed record and head advance.
   */
  withIdempotencyKey(idempotencyKey: string): RecordStore {
    return {
      getHead: (subject) => this.getHead(subject),
      append: (subject, env, recordId) =>
        this.appendRecord(subject, env, recordId, idempotencyKey),
      getLogSince: (subject, sinceSeq, limit) =>
        this.getLogSince(subject, sinceSeq, limit),
      resolveCursorSeq: (subject, recordId) =>
        this.resolveCursorSeq(subject, recordId),
      materializeCurrent: (subject, collection, rkey) =>
        this.materializeCurrent(subject, collection, rkey),
      latestIssuedAtForKey: (subject, env) =>
        this.latestIssuedAtForKey(subject, env),
    };
  }

  /**
   * Resolve the append previously committed for one durable producer event.
   * The caller verifies its collection/rkey/issuedAt identity before accepting
   * it, so accidental key reuse fails closed.
   */
  async findByIdempotencyKey(
    subject: string,
    idempotencyKey: string,
  ): Promise<StoredIdempotentRecord | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) return null;

    const [row] = await getDb()
      .select({
        recordId: mentionSignedRecords.recordId,
        seq: mentionSignedRecords.seq,
        envelope: mentionSignedRecords.envelope,
      })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, oxyUserId),
          eq(mentionSignedRecords.idempotencyKey, idempotencyKey),
          eq(mentionSignedRecords.verified, true),
        ),
      )
      .limit(1);
    if (!row || row.recordId === null) {
      return null;
    }
    // A v1 row carries no denormalized `seq`; fall back to the envelope's own.
    const seq =
      row.seq !== null
        ? row.seq
        : row.envelope.version === 2 && typeof row.envelope.seq === 'number'
          ? row.envelope.seq
          : null;
    if (seq === null) return null;
    return {
      recordId: row.recordId,
      seq,
      envelope: row.envelope,
    };
  }

  private async appendRecord(
    subject: string,
    env: SignedRecordEnvelope,
    recordId: string,
    idempotencyKey?: string,
  ): Promise<AppendOutcome> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      // The subject DID does not belong to a user — there is no Mention chain to
      // write. Treated as a continuity conflict (no valid head).
      return { ok: false, reason: 'chain_gap' };
    }

    const db = getDb();

    if (env.version === 2) {
      const seq = env.seq;
      if (typeof seq !== 'number') {
        // A v2 envelope without a numeric seq is malformed (the engine validates
        // this upstream); refuse to advance a chain with no sequence.
        return { ok: false, reason: 'bad_seq' };
      }
      try {
        return await db.transaction(async (tx) => {
          await tx.insert(mentionSignedRecords).values({
            subjectDid: env.subject,
            oxyUserId,
            type: env.type,
            envelope: env,
            publicKey: env.publicKey,
            verified: true,
            seq,
            prev: env.prev ?? null,
            recordId,
            chainStatus: MTN_CHAIN_STATUS.CANONICAL,
            idempotencyKey: idempotencyKey ?? null,
            // Denormalize the envelope's `collection` to the `nsid` column.
            nsid: env.collection,
            rkey: env.rkey,
          });

          await tx
            .insert(mentionRepoHeads)
            .values({
              oxyUserId,
              subjectDid: env.subject,
              seq,
              headRecordId: recordId,
              recordCount: 1,
            })
            .onConflictDoUpdate({
              target: mentionRepoHeads.oxyUserId,
              set: {
                subjectDid: env.subject,
                seq,
                headRecordId: recordId,
                // The bare column reference resolves to the EXISTING row of the
                // conflict target, which is what `$inc` meant.
                recordCount: sql`${mentionRepoHeads.recordCount} + 1`,
                // `$onUpdate` fires for `db.update()`, never for an upsert's
                // DO UPDATE arm, so the stamp is explicit here.
                updatedAt: new Date(),
              },
            });

          return { ok: true as const, recordId, seq };
        });
      } catch (error) {
        if (isChainAppendConflict(error)) {
          return { ok: false, reason: 'chain_conflict' };
        }
        throw error;
      }
    }

    // v1: an unchained singleton append. No chain fields, no head advance.
    await db.insert(mentionSignedRecords).values({
      subjectDid: env.subject,
      oxyUserId,
      type: env.type,
      envelope: env,
      publicKey: env.publicKey,
      verified: true,
      chainStatus: MTN_CHAIN_STATUS.CANONICAL,
      idempotencyKey: idempotencyKey ?? null,
    });
    return { ok: true, recordId, seq: -1 };
  }

  async getLogSince(subject: string, sinceSeq: number, limit: number = DEFAULT_LOG_LIMIT): Promise<SignedRecordEnvelope[]> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return [];
    }
    const rows = await getDb()
      .select({ envelope: mentionSignedRecords.envelope })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, oxyUserId),
          gt(mentionSignedRecords.seq, sinceSeq),
          canonicalChainRow(),
        ),
      )
      .orderBy(asc(mentionSignedRecords.seq))
      .limit(clampLogLimit(limit));
    return rows.map((row) => row.envelope);
  }

  async resolveCursorSeq(subject: string, recordId: string): Promise<number | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    const [row] = await getDb()
      .select({ seq: mentionSignedRecords.seq })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, oxyUserId),
          eq(mentionSignedRecords.recordId, recordId),
          canonicalChainRow(),
        ),
      )
      .limit(1);
    return row?.seq ?? null;
  }

  /**
   * The current value of one record key — the last writer, by
   * {@link LWW_CURRENT_ORDER}, NOT by insert order.
   *
   * Fork archives are deliberately in scope (no `canonicalChainRow()` here): a
   * branch that wins its key wins materialization, which is the whole point of
   * preserving it.
   */
  async materializeCurrent(subject: string, collection: string, rkey: string): Promise<SignedRecordEnvelope | null> {
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return null;
    }
    const [row] = await getDb()
      .select({ envelope: mentionSignedRecords.envelope })
      .from(mentionSignedRecords)
      .where(
        and(
          eq(mentionSignedRecords.oxyUserId, oxyUserId),
          eq(mentionSignedRecords.nsid, collection),
          eq(mentionSignedRecords.rkey, rkey),
          eq(mentionSignedRecords.verified, true),
        ),
      )
      .orderBy(...LWW_CURRENT_ORDER)
      .limit(1);
    return row?.envelope ?? null;
  }

  /**
   * Monotonicity frontier scoped to the LOGICAL record key:
   *  - v1: per `type` (the legacy singleton scope).
   *  - v2: per record KEY (`nsid`, `rkey`) — last-writer-wins for THAT key;
   *    distinct keys are independent appends.
   *
   * The frontier is the MAXIMUM `issuedAt` over the key, and it is a replay /
   * rollback defence — so it must be read on the `issuedAt` axis itself and not
   * through a proxy for it. See {@link LWW_CURRENT_ORDER} for what a proxy
   * costs.
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
    let keyClause: SQL | undefined;
    if (env.version === 2) {
      const { collection, rkey } = env;
      if (typeof collection !== 'string' || typeof rkey !== 'string') {
        return null;
      }
      keyClause = and(
        eq(mentionSignedRecords.nsid, collection),
        eq(mentionSignedRecords.rkey, rkey),
      );
    } else {
      keyClause = eq(mentionSignedRecords.type, env.type);
    }
    const [latest] = await getDb()
      .select({ envelope: mentionSignedRecords.envelope })
      .from(mentionSignedRecords)
      .where(and(eq(mentionSignedRecords.oxyUserId, oxyUserId), keyClause))
      .orderBy(...LWW_CURRENT_ORDER)
      .limit(1);
    const latestIssuedAt = latest?.envelope?.issuedAt;
    return typeof latestIssuedAt === 'number' ? latestIssuedAt : null;
  }
}

/** The singleton Mention record store the write service drives. */
export const mentionRecordStore = new MentionRecordStoreImpl();
