/**
 * Which signed record is the CURRENT one for a key — and why `created_at` cannot
 * answer it.
 *
 * Three reads decide that question, and all three used to ask
 * `order by created_at desc limit 1`:
 *
 *  - `MentionRecordStore.latestIssuedAtForKey` — the monotonicity frontier the
 *    protocol engine compares an incoming record against (`env.issuedAt <=
 *    latestIssuedAt` ⇒ `stale_issued_at`). A replay/rollback defence, so it has
 *    to be the MAXIMUM `issuedAt` for the key, not a proxy for it.
 *  - `MentionRecordStore.materializeCurrent` — the value the key resolves to.
 *  - `MentionNodeSyncService.currentKeyValue` — the `existing` side of the
 *    last-writer-wins comparison during node ingest.
 *
 * `created_at` defaults to `now()`, i.e. `transaction_timestamp()`, so every row
 * written inside ONE transaction shares it to the microsecond — a batch import
 * of a user's chain is exactly that transaction, and the sort then decides
 * nothing. Every fixture here stages that: two records for one key, written in
 * one transaction, one carrying a pre-cutover ObjectId-shaped `id` and one a
 * uuid v7, arranged so that BOTH wrong answers (the `created_at` tie, and the
 * `desc(id)` tiebreak somebody reaches for next) pick the wrong record.
 *
 * `desc(id)` is the worse of the two and the reason the shapes are pinned:
 * `'0' < '6'` under the database's collation, so it sorts every post-cutover
 * record LAST and reliably answers with the oldest branch of the key.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

/* -------------------------------------------------------------------------- */
/*  Node-ingest mocks — the network, the Mongo-side node row, and the engine.  */
/*  The MTN chain itself is NOT mocked: "which row is the incumbent" is a      */
/*  question about a ROW, and a mock could only report that a query was built. */
/* -------------------------------------------------------------------------- */

const mockHead = vi.fn();
const mockLog = vi.fn();
const mockVerifyAndStore = vi.fn();
const mockProjectRecord = vi.fn();
const mockRepoLogHead = vi.fn();
const mockSignMessage = vi.fn();
const mockComputeRecordId = vi.fn();
const mockNodeFindOne = vi.fn();
const mockNodeUpdateOne = vi.fn();
const mockWitnessCreate = vi.fn();

vi.mock('@oxyhq/protocol/node', () => ({
  NodeClient: class {
    head = (...a: unknown[]) => mockHead(...a);
    log = (...a: unknown[]) => mockLog(...a);
    pushRecords = vi.fn();
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
  getHead: (...a: unknown[]) => mockRepoLogHead(...a),
  getPublicLogSince: vi.fn(async () => []),
}));
vi.mock('../../../models/MentionUserNode', () => ({
  __esModule: true,
  default: {
    findOne: (...a: unknown[]) => mockNodeFindOne(...a),
    updateOne: (...a: unknown[]) => mockNodeUpdateOne(...a),
  },
}));
vi.mock('../../../models/MentionNodeIngestWitness', () => ({
  __esModule: true,
  default: { create: (...a: unknown[]) => mockWitnessCreate(...a) },
}));

import { closePostgres, connectPostgres, type Database } from '../../../db/postgres';
import { mentionSignedRecords } from '../../../db/schema/mtn';
import { uuidv7 } from '../../../db/schema/columns';
import {
  MTN_CHAIN_STATUS,
  MentionRecordStoreImpl,
} from '../../../services/mtn/MentionRecordStore';
import { buildUserDid } from '../../../services/mtn/mentionDid';
import { ingestFromNode } from '../../../services/mtn/MentionNodeSyncService';

let db: Database;
const store = new MentionRecordStoreImpl();
const createdUserIds: string[] = [];

/**
 * `record_id` is a GLOBALLY unique content address and vitest runs test FILES in
 * parallel against ONE database, so every literal id here is namespaced per run —
 * a shared literal fails an insert in whichever file loses the race, with nothing
 * to do with what either file is testing.
 */
const NAMESPACE = `lww-${randomUUID().slice(0, 8)}`;
function R(name: string): string {
  return `${NAMESPACE}-${name}`;
}

const COLLECTION = 'app.mention.feed.post';
const RKEY = `${NAMESPACE}-post`;
const PUBLIC_KEY = 'ab'.repeat(33);
/** A round epoch-millisecond base every `issuedAt` below is an offset from. */
const BASE_ISSUED_AT = 1_700_000_000_000;

/** An Oxy account id unique to one test, so chains cannot leak between them. */
function chainOwner(): string {
  const id = `oxy-${NAMESPACE}-${randomUUID()}`;
  createdUserIds.push(id);
  return id;
}

/** A 24-char ObjectId hex — the shape of every id written before the cutover. */
function objectIdHex(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

function envelopeV2(
  owner: string,
  overrides: Partial<SignedRecordEnvelope> = {},
): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'app_record',
    subject: buildUserDid(owner),
    issuer: buildUserDid(owner),
    record: { text: 'hello' },
    issuedAt: BASE_ISSUED_AT,
    collection: COLLECTION,
    rkey: RKEY,
    publicKey: PUBLIC_KEY,
    alg: 'ES256K-DER-SHA256',
    signature: 'signature',
    ...overrides,
  } as SignedRecordEnvelope;
}

interface StagedRecord {
  /** The row's PRIMARY KEY — pinned per row so both id shapes are in play. */
  id: string;
  recordId: string;
  issuedAt: number;
  /** v1 rows carry no `nsid`/`rkey`/`recordId` and are scoped by `type`. */
  legacyType?: string;
}

/**
 * Write every staged record in ONE transaction, so they share `created_at`
 * exactly — the shape a batched import of a user's chain produces, and the one
 * where a `created_at` sort stops deciding anything. Insertion order is
 * load-bearing: under a full tie the scan reaches the first row first, so the
 * WRONG record is always staged first.
 */
async function stageRecords(owner: string, records: readonly StagedRecord[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const record of records) {
      const legacy = record.legacyType !== undefined;
      // The envelope names the row it came from, so a case where two rows share
      // an `issuedAt` can still say WHICH branch the read returned. Asserting on
      // `issuedAt` alone cannot distinguish them, and asserting on a row this
      // file re-queries itself would not be testing the read at all.
      const marker = { branch: record.recordId };
      const envelope = legacy
        ? ({
            version: 1,
            type: record.legacyType,
            subject: buildUserDid(owner),
            issuer: buildUserDid(owner),
            record: marker,
            issuedAt: record.issuedAt,
            publicKey: PUBLIC_KEY,
            alg: 'ES256K-DER-SHA256',
            signature: 'signature',
          } as SignedRecordEnvelope)
        : envelopeV2(owner, { issuedAt: record.issuedAt, record: marker });
      await tx.insert(mentionSignedRecords).values({
        id: record.id,
        subjectDid: buildUserDid(owner),
        oxyUserId: owner,
        type: envelope.type,
        envelope,
        publicKey: PUBLIC_KEY,
        verified: true,
        chainStatus: MTN_CHAIN_STATUS.CANONICAL,
        ...(legacy
          ? {}
          : { recordId: record.recordId, nsid: COLLECTION, rkey: RKEY }),
      });
    }
  });
}

/** Every `created_at` this owner's rows carry, so a fixture can prove it tied. */
async function stagedCreatedAt(owner: string): Promise<number[]> {
  const rows = await db
    .select({ createdAt: mentionSignedRecords.createdAt })
    .from(mentionSignedRecords)
    .where(eq(mentionSignedRecords.oxyUserId, owner));
  return rows.map((row) => row.createdAt.getTime());
}

async function ledgerRecordIds(owner: string): Promise<(string | null)[]> {
  const rows = await db
    .select({ recordId: mentionSignedRecords.recordId })
    .from(mentionSignedRecords)
    .where(eq(mentionSignedRecords.oxyUserId, owner));
  return rows.map((row) => row.recordId);
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MENTION_PRIVATE_KEY = 'aa'.repeat(32);
  process.env.MENTION_PUBLIC_KEY = PUBLIC_KEY;
  mockRepoLogHead.mockResolvedValue(null);
  mockNodeUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mockWitnessCreate.mockResolvedValue({});
  mockSignMessage.mockResolvedValue('witness-sig');
  mockProjectRecord.mockResolvedValue({ ok: true, kind: 'post', id: 'r' });
});

afterEach(async () => {
  while (createdUserIds.length > 0) {
    const owner = createdUserIds.pop();
    if (owner) {
      await db.delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, owner));
    }
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the fixture really stages the ambiguity', () => {
  it('gives two records written in one transaction the same created_at', async () => {
    /**
     * The vacuity floor for every case below. They are all about what happens
     * when `created_at` cannot separate two rows; if that column ever stopped
     * collapsing inside a transaction they would keep passing while proving
     * nothing, and this one goes red instead.
     */
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: R('a'), issuedAt: BASE_ISSUED_AT + 1_000 },
      { id: uuidv7(), recordId: R('b'), issuedAt: BASE_ISSUED_AT + 9_000 },
    ]);

    const stamps = await stagedCreatedAt(owner);
    expect(stamps).toHaveLength(2);
    expect(stamps[0]).toBe(stamps[1]);
  });
});

describe('latestIssuedAtForKey — the frontier is the maximum, not a proxy for it', () => {
  it('reports the highest issuedAt of the key, whatever order the rows were written in', async () => {
    /**
     * A frontier that under-reports accepts exactly the record it exists to
     * reject: the engine's step 5 is `env.issuedAt <= latestIssuedAt`, so a
     * frontier of `+1_000` waves through a rolled-back `+5_000` revision of a
     * post the user already superseded at `+9_000`. Worse, the accepted rollback
     * is then stored with a LATER `created_at` than the record it replaced — so
     * from the first tie onward the two columns disagree permanently for that
     * key and every subsequent rollback is accepted too.
     */
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: R('stale'), issuedAt: BASE_ISSUED_AT + 1_000 },
      { id: uuidv7(), recordId: R('current'), issuedAt: BASE_ISSUED_AT + 9_000 },
    ]);

    await expect(
      store.latestIssuedAtForKey(buildUserDid(owner), envelopeV2(owner)),
    ).resolves.toBe(BASE_ISSUED_AT + 9_000);
  });

  it('reports the highest issuedAt of a v1 singleton, which is scoped by type', async () => {
    /**
     * The legacy branch takes the same order, and it is the one where the
     * `recordId` tiebreak is NULL for every candidate — so `desc nulls last` has
     * to leave the `issuedAt` key in charge rather than letting a NULL win.
     */
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: '', issuedAt: BASE_ISSUED_AT + 2_000, legacyType: 'profile' },
      { id: uuidv7(), recordId: '', issuedAt: BASE_ISSUED_AT + 8_000, legacyType: 'profile' },
    ]);

    const v1 = {
      version: 1,
      type: 'profile',
      subject: buildUserDid(owner),
      issuer: buildUserDid(owner),
      record: {},
      issuedAt: BASE_ISSUED_AT,
      publicKey: PUBLIC_KEY,
      alg: 'ES256K-DER-SHA256',
      signature: 'signature',
    } as SignedRecordEnvelope;

    await expect(store.latestIssuedAtForKey(buildUserDid(owner), v1)).resolves.toBe(
      BASE_ISSUED_AT + 8_000,
    );
  });
});

describe('materializeCurrent — the key resolves to its last writer', () => {
  it('returns the newest revision rather than whichever row was written first', async () => {
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: R('superseded'), issuedAt: BASE_ISSUED_AT + 1_000 },
      { id: uuidv7(), recordId: R('newest'), issuedAt: BASE_ISSUED_AT + 9_000 },
    ]);

    const current = await store.materializeCurrent(buildUserDid(owner), COLLECTION, RKEY);
    expect(current?.issuedAt).toBe(BASE_ISSUED_AT + 9_000);
    expect(current?.record).toEqual({ branch: R('newest') });
  });

  it('breaks an exact issuedAt tie on the higher recordId, the way LWW says', async () => {
    /**
     * `incomingWinsLww` in `MentionNodeSyncService` resolves an exact `issuedAt`
     * tie by string-comparing `recordId`, and a fork archive is written on the
     * strength of that rule — so the read has to apply the SAME rule, or the
     * branch the writer declared the winner is not the one the key resolves to.
     */
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: R('aaa-loser'), issuedAt: BASE_ISSUED_AT + 5_000 },
      { id: uuidv7(), recordId: R('zzz-winner'), issuedAt: BASE_ISSUED_AT + 5_000 },
    ]);

    const current = await store.materializeCurrent(buildUserDid(owner), COLLECTION, RKEY);
    // `issuedAt` is equal on both rows, so it cannot say which branch came back;
    // the envelope's own marker can.
    expect(current?.record).toEqual({ branch: R('zzz-winner') });
  });
});

describe('node ingest — LWW compares against the incumbent that is really current', () => {
  it('does not let a superseded revision from a node overwrite the live post', async () => {
    /**
     * The user-visible one. `currentKeyValue` supplies the `existing` side of
     * `incomingWinsLww`; read the wrong incumbent and a record the user ALREADY
     * superseded looks newer than what Mention holds, so it is archived as a
     * fork, materialized, and the post silently reverts to older text — an edit
     * undoing itself, with `projectRecord` reporting success.
     *
     * Staged as the engine would produce it: the incoming record is rejected
     * upstream as `stale_issued_at` (it IS stale against the true incumbent),
     * and `+5_000` sits between the two rows on purpose — it beats the stale one
     * and loses to the live one, so the answer depends entirely on which row the
     * read returns.
     */
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: R('inc-stale'), issuedAt: BASE_ISSUED_AT + 1_000 },
      { id: uuidv7(), recordId: R('inc-live'), issuedAt: BASE_ISSUED_AT + 9_000 },
    ]);

    const incoming = { ...envelopeV2(owner, { issuedAt: BASE_ISSUED_AT + 5_000 }), seq: 1, prev: null };
    mockNodeFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ endpoint: 'https://node.example.com' }) }),
    });
    mockHead.mockResolvedValue({ seq: 1, headRecordId: 'h', recordCount: 2 });
    mockLog.mockResolvedValue({ records: [incoming], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValue({ ok: false, reason: 'stale_issued_at' });
    mockComputeRecordId.mockResolvedValue(R('inc-incoming'));

    await ingestFromNode(owner);

    // No third row: the loser was not archived as a fork…
    expect((await ledgerRecordIds(owner)).sort()).toEqual([R('inc-live'), R('inc-stale')]);
    // …and nothing re-rendered the post from it, or counter-signed it.
    expect(mockProjectRecord).not.toHaveBeenCalled();
    expect(mockWitnessCreate).not.toHaveBeenCalled();
  });

  it('still adopts a record that genuinely beats the live incumbent', async () => {
    /**
     * The counterpart that stops the case above from passing vacuously: fixing
     * the read must not turn LWW into "never adopt anything". Same fixture, an
     * incoming `issuedAt` above BOTH rows.
     */
    const owner = chainOwner();
    await stageRecords(owner, [
      { id: objectIdHex(), recordId: R('adopt-stale'), issuedAt: BASE_ISSUED_AT + 1_000 },
      { id: uuidv7(), recordId: R('adopt-live'), issuedAt: BASE_ISSUED_AT + 9_000 },
    ]);

    const incoming = {
      ...envelopeV2(owner, { issuedAt: BASE_ISSUED_AT + 20_000 }),
      seq: 1,
      prev: null,
    };
    mockNodeFindOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ endpoint: 'https://node.example.com' }) }),
    });
    mockHead.mockResolvedValue({ seq: 1, headRecordId: 'h', recordCount: 2 });
    mockLog.mockResolvedValue({ records: [incoming], count: 1, head: null });
    mockVerifyAndStore.mockResolvedValue({ ok: false, reason: 'stale_issued_at' });
    mockComputeRecordId.mockResolvedValue(R('adopt-incoming'));

    await ingestFromNode(owner);

    expect((await ledgerRecordIds(owner)).sort()).toEqual([
      R('adopt-incoming'),
      R('adopt-live'),
      R('adopt-stale'),
    ]);
    expect(mockProjectRecord).toHaveBeenCalledTimes(1);
    expect(mockWitnessCreate).toHaveBeenCalledTimes(1);
  });
});
