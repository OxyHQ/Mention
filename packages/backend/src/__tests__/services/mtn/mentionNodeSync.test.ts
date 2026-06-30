import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
 * `NodeClient`, every model, `verifyAndStoreRecord`, `projectRecord`, the repo-log
 * head, the signer, and the logger are mocked — no DB, no network. The real
 * `@oxyhq/contracts` envelope schema validates crafted envelopes.
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
const mockNodeFindOne = vi.fn();
const mockNodeUpdateOne = vi.fn();
const mockSignedRecordFindOne = vi.fn();
const mockSignedRecordCreate = vi.fn();
const mockWitnessCreate = vi.fn();

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
vi.mock('../../../models/MentionUserNode', () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => mockNodeFindOne(...a),
    updateOne: (...a: unknown[]) => mockNodeUpdateOne(...a),
  },
}));
vi.mock('../../../models/MentionSignedRecord', () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => mockSignedRecordFindOne(...a),
    create: (...a: unknown[]) => mockSignedRecordCreate(...a),
  },
}));
vi.mock('../../../models/MentionNodeIngestWitness', () => ({
  __esModule: true,
  default: { create: (...a: unknown[]) => mockWitnessCreate(...a) },
}));

import { ingestFromNode, exportToNode } from '../../../services/mtn/MentionNodeSyncService';

const OXY_USER_ID = '650000000000000000000abc';
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

/** Chainable `.select().lean()`. */
function selectLean(value: unknown) {
  return { select: () => ({ lean: () => Promise.resolve(value) }) };
}
/** Chainable `.sort().lean()`. */
function sortLean(value: unknown) {
  return { sort: () => ({ lean: () => Promise.resolve(value) }) };
}

/** The update arg (`{ $set, $unset, ... }`) of a Mongo-static mock's last call. */
function lastUpdate(mock: { mock: { calls: unknown[][] } }): {
  $set?: Record<string, unknown>;
  $unset?: Record<string, unknown>;
} {
  const { calls } = mock.mock;
  const last = calls[calls.length - 1];
  return (last?.[1] ?? {}) as { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MENTION_PRIVATE_KEY = 'aa'.repeat(32);
  process.env.MENTION_PUBLIC_KEY = PUBLIC_KEY;

  mockNodeFindOne.mockReturnValue(selectLean({ endpoint: 'https://node.example.com', cursor: undefined }));
  mockGetHead.mockResolvedValue(null); // local head -1
  mockGetPublicLogSince.mockResolvedValue([]); // export: nothing to push by default
  mockNodeUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mockSignedRecordFindOne.mockReturnValue(sortLean(null));
  mockSignedRecordCreate.mockResolvedValue({});
  mockWitnessCreate.mockResolvedValue({});
  mockSignMessage.mockResolvedValue('witness-sig');
  mockProjectRecord.mockResolvedValue({ ok: true, kind: 'post', id: 'r' });
  mockComputeRecordId.mockImplementation(async (env: { seq?: number }) => `rid-${env.seq}`);
  mockVerifyAndStore.mockImplementation(async (env: { seq?: number }) => ({
    ok: true,
    recordId: `rid-${env.seq}`,
    seq: env.seq,
  }));
});

afterEach(() => {
  delete process.env.MENTION_PRIVATE_KEY;
  delete process.env.MENTION_PUBLIC_KEY;
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
    expect(mockWitnessCreate).toHaveBeenCalledTimes(3);

    // Cursor advanced to the node head (2) + lastSyncedAt stamped + error cleared.
    const update = lastUpdate(mockNodeUpdateOne);
    expect(update.$set).toMatchObject({ cursor: 2 });
    expect(update.$set?.lastSyncedAt).toBeInstanceOf(Date);
    expect(update.$unset).toEqual({ lastError: '' });
  });

  it('is a caught-up no-op (no log fetch) when the node head is not ahead', async () => {
    mockGetHead.mockResolvedValueOnce({ seq: 5, headRecordId: 'h', recordCount: 6 });
    mockHead.mockResolvedValueOnce({ seq: 5, headRecordId: 'h', recordCount: 6 });

    await ingestFromNode(OXY_USER_ID);

    expect(mockLog).not.toHaveBeenCalled();
    expect(mockVerifyAndStore).not.toHaveBeenCalled();
    expect(mockProjectRecord).not.toHaveBeenCalled();
    const update = mockNodeUpdateOne.mock.calls[0];
    expect(update[1].$set).toMatchObject({ cursor: 5 });
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
    expect(mockWitnessCreate).not.toHaveBeenCalled(); // not witnessed
    expect(mockSignedRecordCreate).not.toHaveBeenCalled(); // no fork mirror
    const update = mockNodeUpdateOne.mock.calls[0];
    expect(update[1].$set.lastError).toContain('rejected:bad_signature');
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
    expect(mockWitnessCreate).not.toHaveBeenCalled();
    const update = mockNodeUpdateOne.mock.calls[0];
    expect(update[1].$set.lastError).toContain('rejected:public_key_not_a_current_verification_method');
  });

  it('rejects a malformed envelope that fails the contract schema', async () => {
    mockHead.mockResolvedValueOnce({ seq: 0, headRecordId: 'h', recordCount: 1 });
    mockLog.mockResolvedValueOnce({ records: [{ not: 'an envelope' }], count: 1, head: null });

    await ingestFromNode(OXY_USER_ID);

    expect(mockVerifyAndStore).not.toHaveBeenCalled(); // never reached the engine
    expect(mockProjectRecord).not.toHaveBeenCalled();
    const update = mockNodeUpdateOne.mock.calls[0];
    expect(update[1].$set.lastError).toContain('rejected:invalid_envelope');
  });
});

describe('ingestFromNode — last-writer-wins', () => {
  it('keeps the existing higher-issuedAt record and skips the incoming loser', async () => {
    mockHead.mockResolvedValueOnce({ seq: 1, headRecordId: 'h', recordCount: 2 });
    mockLog.mockResolvedValueOnce({ records: [envelope(1)], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValueOnce({ ok: false, reason: 'stale_issued_at' });
    // The existing materialized value for the key has a STRICTLY higher issuedAt.
    mockSignedRecordFindOne.mockReturnValueOnce(
      sortLean({ recordId: 'rid-existing', envelope: { issuedAt: 1_700_000_000_999 } }),
    );

    await ingestFromNode(OXY_USER_ID);

    expect(mockSignedRecordCreate).not.toHaveBeenCalled(); // loser NOT stored
    expect(mockProjectRecord).not.toHaveBeenCalled(); // not materialized
    expect(mockWitnessCreate).not.toHaveBeenCalled();
    // Clean skip → cursor stamped, lastError cleared.
    expect(mockNodeUpdateOne.mock.calls[0][1].$unset).toEqual({ lastError: '' });
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
    expect(mockWitnessCreate).not.toHaveBeenCalled();
    // Ingest + materialization still happened; the cursor moved.
    expect(mockVerifyAndStore).toHaveBeenCalledTimes(1);
    expect(mockProjectRecord).toHaveBeenCalledTimes(1);
    expect(lastUpdate(mockNodeUpdateOne).$set).toMatchObject({ cursor: 0 });
  });
});

describe('ingestFromNode — resilience', () => {
  it('leaves state stale WITHOUT throwing when the node is unreachable', async () => {
    mockHead.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(ingestFromNode(OXY_USER_ID)).resolves.toBeUndefined();

    expect(mockVerifyAndStore).not.toHaveBeenCalled();
    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect(mockNodeUpdateOne.mock.calls[0][1].$set.lastError).toContain('ECONNREFUSED');
  });

  it('no-ops when the user has no registered node', async () => {
    mockNodeFindOne.mockReturnValueOnce(selectLean(null));

    await ingestFromNode(OXY_USER_ID);

    expect(mockHead).not.toHaveBeenCalled();
    expect(mockNodeUpdateOne).not.toHaveBeenCalled();
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
    expect(mockWitnessCreate).not.toHaveBeenCalled();
    const update = lastUpdate(mockNodeUpdateOne);
    expect(update.$set?.lastSyncedAt).toBeInstanceOf(Date);
    expect(update.$unset).toEqual({ lastError: '' });
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
    const update = lastUpdate(mockNodeUpdateOne);
    expect(update.$set?.lastSyncedAt).toBeInstanceOf(Date);
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

    const update = lastUpdate(mockNodeUpdateOne);
    expect(update.$set).toMatchObject({ cursor: 0 });
    expect(update.$unset).toEqual({ lastError: '' });
  });
});
