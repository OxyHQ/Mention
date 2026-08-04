import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * MTN Protocol — B3 node→Mention INGEST (MentionNodeSyncService.ingestFromNode).
 *
 * Pulls a user's authentic signed chain back from their node (a MOCKED
 * `NodeClient`) and mirrors it into Mention's local store. These tests lock the
 * trust + conflict model + the Mention-specific materialization step:
 *
 *  - every record is RE-VERIFIED via `MentionRecordService.verifyAndStoreRecord`,
 *    then materialized via `PostMaterializer.projectRecord`, then COUNTER-SIGNED
 *    into a witness, and the cursor advances;
 *  - a BAD-SIGNATURE record (verifyAndStoreRecord → bad_signature) is rejected:
 *    NOT projected, NOT witnessed, cursor not advanced, `lastError` stamped;
 *  - a caught-up node is a no-op (no log fetch);
 *  - LWW keeps the existing higher-`issuedAt` record (skips the loser);
 *  - witnessing is skipped cleanly when the custodial key is unset (ingest still
 *    proceeds);
 *  - an unreachable node leaves state stale WITHOUT throwing.
 *
 * `NodeClient`, `MentionUserNode`, `MentionNodeIngestWitness`,
 * `verifyAndStoreRecord`, `projectRecord`, the repo-log head, the signer, and the
 * logger are mocked — no network. The real `@oxyhq/contracts` envelope schema
 * validates crafted envelopes.
 *
 * **The MTN chain is NOT mocked.** `currentKeyValue` (the LWW frontier read) and
 * `storeForkMirror` (the fork archive write) run against real
 * `mention_signed_records` rows, because "did the loser get stored" and "is the
 * existing value really newer" are questions about a ROW — the previous mock could
 * only report that a query object had been constructed, which is true whether or
 * not the query is right.
 */

const mockHead = vi.fn();
const mockLog = vi.fn();
const mockPushRecords = vi.fn();
const mockVerifyAndStore = vi.fn();
const mockProjectRecord = vi.fn();
const mockGetHead = vi.fn();
const mockGetPublicLogSince = vi.fn();
const mockSignMessage = vi.fn();
const mockComputeRecordId = vi.fn();

// NodeClient is mocked to a stub that returns the canned head/log/push responses.
vi.mock('@oxyhq/protocol/node', () => ({
  NodeClient: class {
    head = (...a: unknown[]) => mockHead(...a);
    log = (...a: unknown[]) => mockLog(...a);
    pushRecords = (...a: unknown[]) => mockPushRecords(...a);
    // Content-addressed blob fetcher (used by the materialize media mirror). These
    // test records carry no embed, so it is never invoked, but the mock mirrors the
    // real client surface.
    getBlob = vi.fn(async () => null);
  },
}));
vi.mock('@oxyhq/protocol', async () => {
  const actual = await vi.importActual<typeof import('@oxyhq/protocol')>('@oxyhq/protocol');
  return {
    ...actual,
    computeRecordId: (...a: unknown[]) => mockComputeRecordId(...a),
    signMessage: (...a: unknown[]) => mockSignMessage(...a),
  };
});
vi.mock('@oxyhq/core/server', () => ({ safeFetch: vi.fn() }));
vi.mock('../../../services/mtn/MentionRecordService', () => ({
  verifyAndStoreRecord: (...a: unknown[]) => mockVerifyAndStore(...a),
}));
vi.mock('../../../services/mtn/PostMaterializer', () => ({
  projectRecord: (...a: unknown[]) => mockProjectRecord(...a),
}));
vi.mock('../../../services/mtn/MentionRepoLogService', () => ({
  getHead: (...a: unknown[]) => mockGetHead(...a),
  getPublicLogSince: (...a: unknown[]) => mockGetPublicLogSince(...a),
}));
// The node row and its witness ledger are REAL. They used to be Mongo statics
// whose `$set` argument the assertions read, which measured what the service
// ASKED FOR rather than what the store kept — so a cursor the column would
// reject (`mention_user_nodes_cursor_check` refuses the `-1` sentinel) and a
// witness whose second write silently replaced the first were both invisible.

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import {
  mentionNodeIngestWitnesses,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../../db/schema/mtn';
import { MTN_CHAIN_STATUS } from '../../../services/mtn/MentionRecordStore';
import { ingestFromNode, exportToNode } from '../../../services/mtn/MentionNodeSyncService';

let db: Database;

/** Every ledger row this suite left behind, newest first. */
async function ledgerRows() {
  return db
    .select()
    .from(mentionSignedRecords)
    .where(eq(mentionSignedRecords.oxyUserId, OXY_USER_ID));
}

/**
 * OWNED BY THIS FILE.
 *
 * `mention_user_nodes.oxy_user_id` is UNIQUE, so seeding a node row under an id
 * another parallel file also seeds is a duplicate-key failure in whichever file
 * loses the race — nothing to do with what either is testing. This used to be
 * the shared `650000000000000000000abc`, which was harmless while these suites
 * only wrote chain records (no unique constraint on the owner there) and became
 * a collision the moment the node row became real.
 *
 * `fixtureIdOwnership.test.ts` cannot catch this: it inspects `id:` FIELD
 * literals, and this is an owner column.
 */
const OXY_USER_ID = '650000000000000000000a51';
const SUBJECT_DID = `did:web:oxy.so:u:${OXY_USER_ID}`;
const PUBLIC_KEY = 'ab'.repeat(33);

/** A well-formed v2 envelope that passes the real contract schema. */
function envelope(seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    type: 'app_record',
    subject: SUBJECT_DID,
    issuer: SUBJECT_DID,
    record: { text: `post ${seq}`, createdAt: new Date(1_700_000_000_000 + seq).toISOString() },
    issuedAt: 1_700_000_000_000 + seq,
    seq,
    prev: seq === 0 ? null : `p${seq}`.padEnd(64, '0'),
    collection: 'app.mention.feed.post',
    rkey: `650000000000000000000${(seq + 100).toString().padStart(3, '0')}`,
    publicKey: PUBLIC_KEY,
    alg: 'ES256K-DER-SHA256',
    signature: 'deadbeef',
    ...overrides,
  };
}

/** The stored node row for this suite's subject. */
async function nodeRow() {
  const [row] = await db
    .select()
    .from(mentionUserNodes)
    .where(eq(mentionUserNodes.oxyUserId, OXY_USER_ID))
    .limit(1);
  return row;
}

/** How many records this suite's subject has had counter-signed. */
async function witnessCount(): Promise<number> {
  const rows = await db
    .select({ id: mentionNodeIngestWitnesses.id })
    .from(mentionNodeIngestWitnesses)
    .where(eq(mentionNodeIngestWitnesses.oxyUserId, OXY_USER_ID));
  return rows.length;
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.MENTION_PRIVATE_KEY = 'aa'.repeat(32);
  process.env.MENTION_PUBLIC_KEY = PUBLIC_KEY;
  await db.delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, OXY_USER_ID));

  await db.delete(mentionNodeIngestWitnesses).where(eq(mentionNodeIngestWitnesses.oxyUserId, OXY_USER_ID));
  await db.delete(mentionUserNodes).where(eq(mentionUserNodes.oxyUserId, OXY_USER_ID));
  await db.insert(mentionUserNodes).values({
    oxyUserId: OXY_USER_ID,
    endpoint: 'https://node.example.com',
    nodePublicKey: PUBLIC_KEY,
  });
  mockGetHead.mockResolvedValue(null); // local head -1
  mockGetPublicLogSince.mockResolvedValue([]); // export: nothing to push by default
  mockSignMessage.mockResolvedValue('witness-sig');
  mockProjectRecord.mockResolvedValue({ ok: true, kind: 'post', id: 'r' });
  mockComputeRecordId.mockImplementation(async (env: { seq?: number }) => `rid-${env.seq}`);
  mockVerifyAndStore.mockImplementation(async (env: { seq?: number }) => ({
    ok: true,
    recordId: `rid-${env.seq}`,
    seq: env.seq,
  }));
});

afterEach(async () => {
  delete process.env.MENTION_PRIVATE_KEY;
  delete process.env.MENTION_PUBLIC_KEY;
  await db.delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, OXY_USER_ID));
});

describe('ingestFromNode — happy path', () => {
  it('re-verifies + materializes + witnesses each record and advances the cursor', async () => {
    mockHead.mockResolvedValueOnce({ seq: 2, headRecordId: 'h', recordCount: 3 });
    mockLog.mockResolvedValueOnce({ records: [envelope(0), envelope(1), envelope(2)], count: 3, head: null });

    await ingestFromNode(OXY_USER_ID);

    // EVERY record was re-verified through the chain engine chokepoint.
    expect(mockVerifyAndStore).toHaveBeenCalledTimes(3);
    // EVERY verified record was materialized into the feed-readable store.
    expect(mockProjectRecord).toHaveBeenCalledTimes(3);
    // EVERY ingested record was counter-signed into the witness ledger.
    expect(await witnessCount()).toBe(3);

    // Cursor advanced to the node head (2) + lastSyncedAt stamped + error cleared.
    const row = await nodeRow();
    expect(row?.cursor).toBe(2);
    expect(row?.lastSyncedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
  });

  it('is a caught-up no-op (no log fetch) when the node head is not ahead', async () => {
    mockGetHead.mockResolvedValueOnce({ seq: 5, headRecordId: 'h', recordCount: 6 });
    mockHead.mockResolvedValueOnce({ seq: 5, headRecordId: 'h', recordCount: 6 });

    await ingestFromNode(OXY_USER_ID);

    expect(mockLog).not.toHaveBeenCalled();
    expect(mockVerifyAndStore).not.toHaveBeenCalled();
    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect((await nodeRow())?.cursor).toBe(5);
  });
});

describe('ingestFromNode — bad-signature rejection', () => {
  it('rejects a record whose signature does not verify; never projects or witnesses it', async () => {
    mockHead.mockResolvedValueOnce({ seq: 0, headRecordId: 'h', recordCount: 1 });
    mockLog.mockResolvedValueOnce({ records: [envelope(0)], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValueOnce({ ok: false, reason: 'bad_signature' });

    await ingestFromNode(OXY_USER_ID);

    // It WAS re-verified (the trust boundary ran) but rejected.
    expect(mockVerifyAndStore).toHaveBeenCalledTimes(1);
    expect(mockProjectRecord).not.toHaveBeenCalled(); // not materialized
    expect(await witnessCount()).toBe(0); // not witnessed
    expect(await ledgerRows()).toEqual([]); // no fork mirror
    expect((await nodeRow())?.lastError).toContain('rejected:bad_signature');
  });

  it('rejects a record forged with a key that is not a current verification method', async () => {
    mockHead.mockResolvedValueOnce({ seq: 0, headRecordId: 'h', recordCount: 1 });
    mockLog.mockResolvedValueOnce({ records: [envelope(0)], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValueOnce({
      ok: false,
      reason: 'public_key_not_a_current_verification_method',
    });

    await ingestFromNode(OXY_USER_ID);

    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect(await witnessCount()).toBe(0);
    expect((await nodeRow())?.lastError).toContain('rejected:public_key_not_a_current_verification_method');
  });

  it('rejects a malformed envelope that fails the contract schema', async () => {
    mockHead.mockResolvedValueOnce({ seq: 0, headRecordId: 'h', recordCount: 1 });
    mockLog.mockResolvedValueOnce({ records: [{ not: 'an envelope' }], count: 1, head: null });

    await ingestFromNode(OXY_USER_ID);

    expect(mockVerifyAndStore).not.toHaveBeenCalled(); // never reached the engine
    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect((await nodeRow())?.lastError).toContain('rejected:invalid_envelope');
  });
});

describe('ingestFromNode — last-writer-wins', () => {
  it('keeps the existing higher-issuedAt record and skips the incoming loser', async () => {
    const incoming = envelope(1);
    mockHead.mockResolvedValueOnce({ seq: 1, headRecordId: 'h', recordCount: 2 });
    mockLog.mockResolvedValueOnce({ records: [incoming], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValueOnce({ ok: false, reason: 'stale_issued_at' });
    // A REAL existing row for the SAME (nsid, rkey) key with a strictly higher
    // issuedAt. The frontier read has to find it by key — a filter that misses
    // silently adopts the loser and rewrites the user's post with older content.
    await db.insert(mentionSignedRecords).values({
      subjectDid: SUBJECT_DID,
      oxyUserId: OXY_USER_ID,
      type: 'app_record',
      envelope: { ...incoming, issuedAt: 1_700_000_000_999 } as never,
      publicKey: PUBLIC_KEY,
      verified: true,
      recordId: 'rid-existing',
      chainStatus: MTN_CHAIN_STATUS.CANONICAL,
      nsid: String(incoming.collection),
      rkey: String(incoming.rkey),
    });

    await ingestFromNode(OXY_USER_ID);

    // The loser is NOT stored: the ledger still holds only the incumbent.
    expect((await ledgerRows()).map((row) => row.recordId)).toEqual(['rid-existing']);
    expect(mockProjectRecord).not.toHaveBeenCalled(); // not materialized
    expect(await witnessCount()).toBe(0);
    // Clean skip → cursor stamped, lastError cleared.
    expect((await nodeRow())?.lastError).toBeNull();
  });

  it('preserves a genuine chain fork as a non-chained archive and materializes it', async () => {
    const forked = envelope(1);
    mockHead.mockResolvedValueOnce({ seq: 1, headRecordId: 'h', recordCount: 2 });
    mockLog.mockResolvedValueOnce({ records: [forked], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValueOnce({ ok: false, reason: 'chain_fork' });

    await ingestFromNode(OXY_USER_ID);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    // Off the linear chain — no seq/prev — but addressable for its key, so the
    // fork still wins per-key materialization.
    expect(rows[0]).toMatchObject({
      recordId: 'rid-1',
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
      seq: null,
      prev: null,
      nsid: forked.collection,
      rkey: forked.rkey,
    });
    expect(mockProjectRecord).toHaveBeenCalledTimes(1);
    expect(await witnessCount()).toBe(1);
  });

  it('is idempotent when the same fork is re-pulled', async () => {
    const forked = envelope(1);
    mockHead.mockResolvedValue({ seq: 1, headRecordId: 'h', recordCount: 2 });
    mockLog.mockResolvedValue({ records: [forked], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValue({ ok: false, reason: 'chain_fork' });

    await ingestFromNode(OXY_USER_ID);
    await ingestFromNode(OXY_USER_ID);

    // The unique content-address index makes the second pull a no-op rather than
    // a duplicate archive — and it must not re-materialize or re-witness either.
    expect(await ledgerRows()).toHaveLength(1);
    expect(mockProjectRecord).toHaveBeenCalledTimes(1);
    expect(await witnessCount()).toBe(1);
  });
});

describe('ingestFromNode — counter-sign witness', () => {
  it('skips witnessing cleanly when the custodial key is unset, but still ingests + materializes', async () => {
    delete process.env.MENTION_PRIVATE_KEY;
    delete process.env.MENTION_PUBLIC_KEY;
    mockHead.mockResolvedValueOnce({ seq: 0, headRecordId: 'h', recordCount: 1 });
    mockLog.mockResolvedValueOnce({ records: [envelope(0)], count: 1, head: null });

    await ingestFromNode(OXY_USER_ID);

    expect(mockSignMessage).not.toHaveBeenCalled();
    expect(await witnessCount()).toBe(0);
    // Ingest + materialization still happened; the cursor moved.
    expect(mockVerifyAndStore).toHaveBeenCalledTimes(1);
    expect(mockProjectRecord).toHaveBeenCalledTimes(1);
    expect((await nodeRow())?.cursor).toBe(0);
  });
});

describe('ingestFromNode — resilience', () => {
  it('leaves state stale WITHOUT throwing when the node is unreachable', async () => {
    mockHead.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(ingestFromNode(OXY_USER_ID)).resolves.toBeUndefined();

    expect(mockVerifyAndStore).not.toHaveBeenCalled();
    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect((await nodeRow())?.lastError).toContain('ECONNREFUSED');
  });

  it('no-ops when the user has no registered node', async () => {
    await db.delete(mentionUserNodes).where(eq(mentionUserNodes.oxyUserId, OXY_USER_ID));

    await ingestFromNode(OXY_USER_ID);

    expect(mockHead).not.toHaveBeenCalled();
    expect(await nodeRow()).toBeUndefined();
  });

  /**
   * A REVOKED node is not "no node" — the row is still there — and every write
   * on this path carries `status <> 'revoked'`. Without that term a sweep
   * already in flight when the user revoked would go on stamping cursors and
   * errors onto a registration they had just withdrawn.
   */
  it('does not sync a node the user revoked', async () => {
    await db
      .update(mentionUserNodes)
      .set({ status: 'revoked' })
      .where(eq(mentionUserNodes.oxyUserId, OXY_USER_ID));

    await ingestFromNode(OXY_USER_ID);

    expect(mockHead).not.toHaveBeenCalled();
    const row = await nodeRow();
    expect(row?.status).toBe('revoked');
    expect(row?.lastSyncedAt).toBeNull();
  });
});

describe('ingestFromNode — malformed (untrusted) node response', () => {
  it('treats a non-array `records` payload as empty WITHOUT throwing or projecting', async () => {
    mockHead.mockResolvedValueOnce({ seq: 3, headRecordId: 'h', recordCount: 4 });
    // A hostile/buggy node returns a log page whose `records` is not an array.
    mockLog.mockResolvedValueOnce({ records: undefined, count: 0, head: null });

    await expect(ingestFromNode(OXY_USER_ID)).resolves.toBeUndefined();

    // Nothing was ingested (no TypeError aborted the sweep); the run stamps the
    // cursor cleanly so the next scheduled run retries.
    expect(mockVerifyAndStore).not.toHaveBeenCalled();
    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect(await witnessCount()).toBe(0);
    const row = await nodeRow();
    expect(row?.lastSyncedAt).toBeInstanceOf(Date);
    expect(row?.lastError).toBeNull();
  });
});

describe('exportToNode — malformed (untrusted) push response', () => {
  it('treats a non-array `results` payload as no acknowledgement WITHOUT crashing', async () => {
    mockHead.mockResolvedValueOnce({ seq: -1, headRecordId: null, recordCount: 0 });
    mockGetPublicLogSince.mockResolvedValueOnce([envelope(0)]);
    // The node returns a push response whose `results` is not an array.
    mockPushRecords.mockResolvedValueOnce({ accepted: 1, results: undefined });

    await expect(exportToNode(OXY_USER_ID)).resolves.toBeUndefined();

    // The export stopped cleanly at the last accepted cursor (no indexing crash);
    // lastSyncedAt is stamped so the next run retries the unacknowledged batch.
    const row = await nodeRow();
    expect(row?.lastSyncedAt).toBeInstanceOf(Date);
    // The node's head was `-1` (an empty remote chain), which is the ingest
    // loop's "nothing mirrored yet" sentinel and is stored as NULL — the column
    // CHECK refuses a negative, so passing it through would abort the export.
    expect(row?.cursor).toBeNull();
  });

  it('advances the cursor for accepted records on a well-formed push response', async () => {
    mockHead.mockResolvedValueOnce({ seq: -1, headRecordId: null, recordCount: 0 });
    mockGetPublicLogSince
      .mockResolvedValueOnce([envelope(0)])
      .mockResolvedValueOnce([]); // caught up on the 2nd iteration
    mockPushRecords.mockResolvedValueOnce({
      accepted: 1,
      results: [{ ok: true, recordId: 'rid-0', seq: 0 }],
    });

    await exportToNode(OXY_USER_ID);

    const row = await nodeRow();
    expect(row?.cursor).toBe(0);
    expect(row?.lastError).toBeNull();
  });
});
