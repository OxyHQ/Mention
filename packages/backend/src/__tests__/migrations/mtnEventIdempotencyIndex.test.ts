import { describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { computeRecordId } from '@oxyhq/protocol';
import {
  MTN_EVENT_IDEMPOTENCY_INDEX,
  MTN_RECORD_ID_INDEX,
  MTN_REPO_HEAD_OWNER_INDEX,
  MTN_SEQUENCE_INDEX,
} from '../../indexes/manifest';
import {
  MENTION_REPO_HEAD_COLLECTION,
  MENTION_SIGNED_RECORD_COLLECTION,
  MTN_CHAIN_STATUS,
  migrationMtnEventIdempotencyIndex,
} from '../../migrations/0012-mtn-event-idempotency-index';

type TestDocument = Record<string, unknown>;

/** A `MentionSignedRecord` fixture row — mirrors the migration's own `ChainRow`. */
interface RecordFixtureRow {
  _id: string;
  oxyUserId: string;
  subjectDid: string;
  seq?: number;
  prev?: string | null;
  recordId: string;
  verified?: boolean;
  envelope: SignedRecordEnvelope;
  chainStatus?: string;
}

/** A `MentionRepoHead` fixture row — mirrors the migration's own `RepoHeadRow`. */
interface HeadFixtureRow {
  _id: string;
  oxyUserId: string;
  subjectDid: string;
  seq: number;
  headRecordId: string;
  recordCount: number;
}

/** The two `records.find(...)` filter shapes the migration actually issues. */
interface RecordFindFilter {
  oxyUserId?: string;
  seq?: { $lte?: number; $exists?: boolean; $type?: string };
  chainStatus?: { $exists?: boolean };
}

interface IndexOptions {
  name?: string;
  unique?: boolean;
}

interface CommandInput {
  collMod?: string;
  index?: { prepareUnique?: boolean; unique?: boolean };
  dryRun?: boolean;
}

interface BulkWriteOperation {
  updateOne: {
    filter: TestDocument;
    update: { $set?: TestDocument; $unset?: TestDocument };
  };
}

function cursor<T>(rows: T[]) {
  const value = {
    batchSize: vi.fn(() => value),
    toArray: vi.fn(async () => rows),
    next: vi.fn(async () => rows[0] ?? null),
    async *[Symbol.asyncIterator]() {
      for (const row of rows) yield row;
    },
  };
  return value;
}

function matchesId(document: { _id: unknown }, filter: TestDocument): boolean {
  const idFilter = filter._id;
  if (idFilter && typeof idFilter === 'object' && '$in' in idFilter) {
    const ids = (idFilter as { $in: unknown[] }).$in;
    return ids.some((id) => String(id) === String(document._id));
  }
  return filter._id === undefined || String(filter._id) === String(document._id);
}

interface HarnessOptions {
  records: RecordFixtureRow[];
  heads: HeadFixtureRow[];
  recordIndexes?: TestDocument[];
  headIndexes?: TestDocument[];
  headSnapshots?: HeadFixtureRow[];
}

function createHarness(options: HarnessOptions) {
  const records = options.records;
  const heads = options.heads;
  const recordIndexes = options.recordIndexes ?? [];
  const headIndexes = options.headIndexes ?? [];
  const headSnapshots = [...(options.headSnapshots ?? [])];
  const events: string[] = [];

  const recordCollection = {
    indexes: vi.fn(async () => recordIndexes),
    createIndex: vi.fn(async (key: TestDocument, indexOptions: IndexOptions) => {
      if (indexOptions.name === MTN_SEQUENCE_INDEX.name) {
        events.push('createSequence');
      }
      return indexOptions.name;
    }),
    dropIndex: vi.fn(async (name: string) => {
      const index = recordIndexes.findIndex((candidate) => candidate.name === name);
      if (index >= 0) recordIndexes.splice(index, 1);
      return { ok: 1 };
    }),
    aggregate: vi.fn((pipeline: { $group?: { _id?: unknown } }[]) => {
      const ownerAggregation = pipeline.some(
        (stage) => stage.$group?._id === '$_id.oxyUserId',
      );
      const counts = new Map<string, number>();
      for (const row of records) {
        if (typeof row.seq !== 'number') continue;
        const key = `${row.oxyUserId}:${row.seq}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const duplicateOwners = [
        ...new Set(
          [...counts.entries()]
            .filter(([, count]) => count > 1)
            .map(([key]) => key.slice(0, key.lastIndexOf(':'))),
        ),
      ].map((_id) => ({ _id }));
      return cursor(ownerAggregation ? duplicateOwners : duplicateOwners.slice(0, 1));
    }),
    find: vi.fn((filter: RecordFindFilter) => {
      let rows: RecordFixtureRow[];
      if (typeof filter.oxyUserId === 'string') {
        const maxSeq = filter.seq?.$lte;
        rows = records.filter(
          (row) =>
            row.oxyUserId === filter.oxyUserId &&
            typeof row.seq === 'number' &&
            typeof maxSeq === 'number' &&
            row.seq <= maxSeq,
        );
      } else if (filter.chainStatus?.$exists === false) {
        rows = records.filter((row) => {
          if (row.chainStatus !== undefined) return false;
          if (filter.seq?.$exists === false) {
            return (
              row.seq === undefined &&
              row.envelope?.version === 2 &&
              typeof row.recordId === 'string'
            );
          }
          return filter.seq?.$type === 'number' && typeof row.seq === 'number';
        });
      } else {
        rows = [];
      }
      return cursor(rows);
    }),
    bulkWrite: vi.fn(async (operations: BulkWriteOperation[]) => {
      events.push('repair');
      for (const operation of operations) {
        const target = records.find((row) =>
          matchesId(row, operation.updateOne.filter));
        if (!target) continue;
        Object.assign(target, operation.updateOne.update.$set ?? {});
        for (const field of Object.keys(operation.updateOne.update.$unset ?? {})) {
          delete (target as unknown as TestDocument)[field];
        }
      }
      return { modifiedCount: operations.length };
    }),
    updateMany: vi.fn(async (filter: TestDocument, update: { $set?: TestDocument }) => {
      let modifiedCount = 0;
      for (const row of records) {
        if (!matchesId(row, filter)) continue;
        Object.assign(row, update.$set ?? {});
        modifiedCount += 1;
      }
      return { modifiedCount };
    }),
  };

  const headCollection = {
    indexes: vi.fn(async () => headIndexes),
    createIndex: vi.fn(async (key: TestDocument, indexOptions: IndexOptions) => {
      events.push('headUnique');
      headIndexes.push({
        name: indexOptions.name,
        key,
        unique: indexOptions.unique === true,
      });
      return indexOptions.name;
    }),
    aggregate: vi.fn(() => {
      const counts = new Map<string, number>();
      for (const row of heads) {
        counts.set(row.oxyUserId, (counts.get(row.oxyUserId) ?? 0) + 1);
      }
      const duplicate = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([_id]) => ({ _id }));
      return cursor(duplicate.slice(0, 1));
    }),
    findOne: vi.fn(async (filter: TestDocument) => {
      if (headSnapshots.length > 0) return headSnapshots.shift();
      return heads.find((head) => head.oxyUserId === filter.oxyUserId) ?? null;
    }),
    find: vi.fn(() => cursor(heads)),
    updateMany: vi.fn(async (filter: TestDocument) => {
      let modifiedCount = 0;
      for (const head of heads) {
        if (!matchesId(head, filter)) continue;
        head.recordCount = head.seq + 1;
        modifiedCount += 1;
      }
      return { modifiedCount };
    }),
  };

  const command = vi.fn(async (input: CommandInput) => {
    if (input.collMod === MENTION_SIGNED_RECORD_COLLECTION) {
      if (input.index?.prepareUnique === true) events.push('prepare');
      if (input.index?.unique === true && input.dryRun === true) {
        events.push('dryRun');
      } else if (input.index?.unique === true) {
        events.push('unique');
      }
    }
    return { ok: 1 };
  });
  const db = {
    collection: vi.fn((name: string) =>
      name === MENTION_SIGNED_RECORD_COLLECTION
        ? recordCollection
        : headCollection),
    command,
  } as unknown as mongoose.mongo.Db;
  const assertLease = vi.fn(async () => undefined);

  return {
    db,
    records,
    heads,
    recordIndexes,
    headIndexes,
    recordCollection,
    headCollection,
    command,
    events,
    context: {
      signal: new AbortController().signal,
      assertLease,
    },
  };
}

function makeEnvelope(
  subject: string,
  seq: number,
  prev: string | null,
  rkey: string,
): SignedRecordEnvelope {
  return {
    version: 2,
    type: 'app_record',
    subject,
    issuer: 'did:web:mention.earth',
    record: { text: rkey },
    issuedAt: 1_000 + seq,
    seq,
    prev,
    collection: 'app.mention.feed.post',
    rkey,
    publicKey: '04abc',
    alg: 'ES256K-DER-SHA256',
    signature: `signature-${rkey}`,
  };
}

async function forkFixture() {
  const oxyUserId = 'actor-1';
  const subject = 'did:web:mention.earth:u:actor-1';
  const genesisEnvelope = makeEnvelope(subject, 0, null, 'genesis');
  const genesisId = await computeRecordId(genesisEnvelope);
  const canonicalEnvelope = makeEnvelope(subject, 1, genesisId, 'canonical');
  const canonicalId = await computeRecordId(canonicalEnvelope);
  const conflictEnvelope = makeEnvelope(subject, 1, genesisId, 'conflict');
  const conflictId = await computeRecordId(conflictEnvelope);
  const records: RecordFixtureRow[] = [
    {
      _id: 'r0',
      oxyUserId,
      subjectDid: subject,
      seq: 0,
      prev: null,
      recordId: genesisId,
      verified: true,
      envelope: genesisEnvelope,
    },
    {
      _id: 'r1',
      oxyUserId,
      subjectDid: subject,
      seq: 1,
      prev: genesisId,
      recordId: canonicalId,
      verified: true,
      envelope: canonicalEnvelope,
    },
    {
      _id: 'fork',
      oxyUserId,
      subjectDid: subject,
      seq: 1,
      prev: genesisId,
      recordId: conflictId,
      verified: true,
      envelope: conflictEnvelope,
    },
  ];
  const head: HeadFixtureRow = {
    _id: 'head-1',
    oxyUserId,
    subjectDid: subject,
    seq: 1,
    headRecordId: canonicalId,
    recordCount: 99,
  };
  return { records, head, conflictEnvelope, conflictId };
}

describe('migration 0012 - online MTN branch repair', () => {
  it('prepares uniqueness, preserves the signed loser, repairs, dry-runs, then makes the index unique', async () => {
    const fixture = await forkFixture();
    const originalEnvelope = structuredClone(fixture.conflictEnvelope);
    const harness = createHarness({
      records: fixture.records,
      heads: [fixture.head],
    });

    await migrationMtnEventIdempotencyIndex.run(harness.db, harness.context);

    expect(harness.events).toEqual([
      'createSequence',
      'prepare',
      'headUnique',
      'repair',
      'dryRun',
      'unique',
    ]);
    const loser = harness.records.find((row) => row._id === 'fork')!;
    expect(loser).toMatchObject({
      recordId: fixture.conflictId,
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
    });
    expect(loser).not.toHaveProperty('seq');
    expect(loser).not.toHaveProperty('prev');
    expect(loser.envelope).toEqual(originalEnvelope);
    expect(harness.records.find((row) => row._id === 'r1')).toMatchObject({
      seq: 1,
      chainStatus: MTN_CHAIN_STATUS.CANONICAL,
    });
    expect(harness.heads[0].recordCount).toBe(2);

    expect(harness.recordCollection.createIndex).toHaveBeenCalledWith(
      MTN_SEQUENCE_INDEX.key,
      {
        name: MTN_SEQUENCE_INDEX.name,
        partialFilterExpression: MTN_SEQUENCE_INDEX.partialFilterExpression,
      },
    );
    expect(harness.headCollection.createIndex).toHaveBeenCalledWith(
      MTN_REPO_HEAD_OWNER_INDEX.key,
      {
        name: MTN_REPO_HEAD_OWNER_INDEX.name,
        unique: true,
      },
    );
    expect(harness.recordCollection.createIndex).toHaveBeenCalledWith(
      MTN_RECORD_ID_INDEX.key,
      expect.objectContaining({ unique: true }),
    );
    expect(harness.recordCollection.createIndex).toHaveBeenCalledWith(
      MTN_EVENT_IDEMPOTENCY_INDEX.key,
      expect.objectContaining({ unique: true }),
    );
  });

  it('resumes a prepared conversion after an archive crash and repairs recordCount even without duplicate seqs', async () => {
    const fixture = await forkFixture();
    const loser = fixture.records.pop()!;
    loser.chainStatus = MTN_CHAIN_STATUS.CONFLICT;
    delete loser.seq;
    delete loser.prev;
    const harness = createHarness({
      records: fixture.records.concat(loser),
      heads: [{ ...fixture.head, recordCount: 77 }],
      recordIndexes: [
        {
          name: MTN_SEQUENCE_INDEX.name,
          key: { ...MTN_SEQUENCE_INDEX.key },
          unique: false,
          prepareUnique: true,
          partialFilterExpression: {
            ...MTN_SEQUENCE_INDEX.partialFilterExpression,
          },
        },
      ],
    });

    await migrationMtnEventIdempotencyIndex.run(harness.db, harness.context);

    expect(harness.events).toEqual(['headUnique', 'dryRun', 'unique']);
    expect(harness.heads[0].recordCount).toBe(2);
    expect(loser).toMatchObject({
      recordId: fixture.conflictId,
      envelope: fixture.conflictEnvelope,
      chainStatus: MTN_CHAIN_STATUS.CONFLICT,
    });
  });

  it('never archives a valid append that advances the head between the first head read and row scan', async () => {
    const fixture = await forkFixture();
    const nextEnvelope = makeEnvelope(
      fixture.head.subjectDid,
      2,
      fixture.head.headRecordId,
      'next',
    );
    const nextId = await computeRecordId(nextEnvelope);
    fixture.records.push({
      _id: 'r2',
      oxyUserId: fixture.head.oxyUserId,
      subjectDid: fixture.head.subjectDid,
      seq: 2,
      prev: fixture.head.headRecordId,
      recordId: nextId,
      verified: true,
      envelope: nextEnvelope,
    });
    const advancedHead = {
      ...fixture.head,
      seq: 2,
      headRecordId: nextId,
      recordCount: 3,
    };
    const harness = createHarness({
      records: fixture.records,
      heads: [advancedHead],
      headSnapshots: [
        fixture.head,
        advancedHead,
        advancedHead,
        advancedHead,
      ],
    });

    await migrationMtnEventIdempotencyIndex.run(harness.db, harness.context);

    expect(harness.recordCollection.find.mock.calls[0][0]).toMatchObject({
      oxyUserId: fixture.head.oxyUserId,
      seq: { $type: 'number', $lte: 1 },
    });
    expect(harness.recordCollection.find.mock.calls[1][0]).toMatchObject({
      oxyUserId: fixture.head.oxyUserId,
      seq: { $type: 'number', $lte: 2 },
    });
    expect(harness.records.find((row) => row._id === 'r2')).toMatchObject({
      seq: 2,
      recordId: nextId,
      chainStatus: MTN_CHAIN_STATUS.CANONICAL,
    });
  });

  it('fails closed before uniqueness finalization when the repo head lineage is inconsistent', async () => {
    const fixture = await forkFixture();
    const harness = createHarness({
      records: fixture.records,
      heads: [{ ...fixture.head, headRecordId: 'missing-record' }],
    });

    await expect(
      migrationMtnEventIdempotencyIndex.run(harness.db, harness.context),
    ).rejects.toThrow('canonical lineage');
    expect(harness.events).toEqual([
      'createSequence',
      'prepare',
      'headUnique',
    ]);
  });

  it('validates a losing fork before writing any branch status', async () => {
    const fixture = await forkFixture();
    fixture.records[2].envelope = {
      ...fixture.records[2].envelope,
      record: { text: 'tampered-after-signing' },
    };
    const harness = createHarness({
      records: fixture.records,
      heads: [fixture.head],
    });

    await expect(
      migrationMtnEventIdempotencyIndex.run(harness.db, harness.context),
    ).rejects.toThrow('snapshot');

    expect(harness.events).toEqual([
      'createSequence',
      'prepare',
      'headUnique',
    ]);
    expect(harness.recordCollection.bulkWrite).not.toHaveBeenCalled();
    expect(harness.recordCollection.updateMany).not.toHaveBeenCalled();
    expect(fixture.records.every((row) => row.chainStatus === undefined)).toBe(
      true,
    );
  });

  it('fails closed on duplicate repo heads instead of selecting an arbitrary branch', async () => {
    const fixture = await forkFixture();
    const harness = createHarness({
      records: fixture.records,
      heads: [fixture.head, { ...fixture.head, _id: 'head-2' }],
    });

    await expect(
      migrationMtnEventIdempotencyIndex.run(harness.db, harness.context),
    ).rejects.toThrow('duplicate MentionRepoHead owners');
    expect(harness.events).toEqual(['createSequence', 'prepare']);
  });

  it('does not drop or replace an unknown sequence-index definition', async () => {
    const fixture = await forkFixture();
    const harness = createHarness({
      records: fixture.records,
      heads: [fixture.head],
      recordIndexes: [
        {
          name: MTN_SEQUENCE_INDEX.name,
          key: { ...MTN_SEQUENCE_INDEX.key },
          unique: true,
          partialFilterExpression: {
            seq: { $type: 'number' },
            chainStatus: MTN_CHAIN_STATUS.CANONICAL,
          },
        },
      ],
    });

    await expect(
      migrationMtnEventIdempotencyIndex.run(harness.db, harness.context),
    ).rejects.toThrow('unknown partial filter');
    expect(harness.recordCollection.dropIndex).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });
});
