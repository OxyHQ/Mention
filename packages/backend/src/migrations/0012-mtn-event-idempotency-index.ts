import type mongoose from 'mongoose';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import { computeRecordId } from '@oxyhq/protocol';
import {
  MTN_CHAIN_INTEGRITY_INDEXES,
  MTN_EVENT_IDEMPOTENCY_INDEX,
  MTN_REPO_HEAD_OWNER_INDEX,
  MTN_SEQUENCE_INDEX,
} from '../indexes/manifest';
import {
  MENTION_SIGNED_RECORD_COLLECTION,
  MTN_CHAIN_STATUS,
} from '../models/MentionSignedRecord';
import { MENTION_REPO_HEAD_COLLECTION } from '../models/MentionRepoHead';
import { logger } from '../utils/logger';
import { MIGRATION_MTN_EVENT_IDEMPOTENCY_INDEX } from './constants';
import type { Migration, MigrationContext } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  prepareUnique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

interface DuplicateChainOwner {
  _id: string;
}

interface ChainRow {
  _id: mongoose.mongo.BSON.ObjectId;
  oxyUserId: string;
  subjectDid: string;
  seq: number;
  prev?: string | null;
  recordId: string;
  verified?: boolean;
  chainStatus?: string;
  envelope?: SignedRecordEnvelope;
}

interface RepoHeadRow {
  _id: mongoose.mongo.BSON.ObjectId;
  oxyUserId: string;
  subjectDid: string;
  seq: number;
  headRecordId: string;
  recordCount?: number;
}

const REQUIRED_MTN_INDEXES = [
  ...MTN_CHAIN_INTEGRITY_INDEXES,
  MTN_EVENT_IDEMPOTENCY_INDEX,
] as const;
const DATA_BATCH_SIZE = 500;
const HEAD_STABILITY_RETRIES = 5;

function isNamespaceNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 26 || mongoError.codeName === 'NamespaceNotFound';
}

async function readIndexes(
  collection: mongoose.mongo.Collection,
): Promise<MongoIndexInfo[]> {
  try {
    return (await collection.indexes()) as MongoIndexInfo[];
  } catch (error) {
    if (isNamespaceNotFound(error)) return [];
    throw error;
  }
}

function sameOrderedKey(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(
      ([field, direction], position) =>
        actualEntries[position]?.[0] === field &&
        actualEntries[position]?.[1] === direction,
    )
  );
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (
    !actual ||
    !expected ||
    typeof actual !== 'object' ||
    typeof expected !== 'object' ||
    Array.isArray(actual) ||
    Array.isArray(expected)
  ) {
    return false;
  }

  const actualRecord = actual as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  const expectedKeys = Object.keys(expectedRecord);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => sameValue(actualRecord[key], expectedRecord[key]))
  );
}

function assertValidHead(
  oxyUserId: string,
  head: RepoHeadRow | null,
): asserts head is RepoHeadRow {
  if (
    !head ||
    head.oxyUserId !== oxyUserId ||
    typeof head.subjectDid !== 'string' ||
    head.subjectDid.length === 0 ||
    !Number.isSafeInteger(head.seq) ||
    head.seq < 0 ||
    typeof head.headRecordId !== 'string' ||
    head.headRecordId.length === 0
  ) {
    throw new Error(
      `[migration] MTN chain for "${oxyUserId}" has no consistent repo head`,
    );
  }
}

async function validateChainSnapshot(
  oxyUserId: string,
  head: RepoHeadRow,
  rows: ChainRow[],
): Promise<Map<string, ChainRow>> {
  const byRecordId = new Map<string, ChainRow>();
  for (const row of rows) {
    if (
      typeof row.recordId !== 'string' ||
      row.recordId.length === 0 ||
      byRecordId.has(row.recordId)
    ) {
      throw new Error(
        `[migration] MTN chain for "${oxyUserId}" has ambiguous recordIds`,
      );
    }

    const validPrev =
      row.seq === 0
        ? row.prev === null
        : typeof row.prev === 'string' && row.prev.length > 0;
    if (
      row.oxyUserId !== oxyUserId ||
      row.subjectDid !== head.subjectDid ||
      !Number.isSafeInteger(row.seq) ||
      row.seq < 0 ||
      row.verified !== true ||
      row.envelope?.version !== 2 ||
      row.envelope.subject !== head.subjectDid ||
      row.envelope.seq !== row.seq ||
      row.envelope.prev !== row.prev ||
      !validPrev
    ) {
      throw new Error(
        `[migration] MTN snapshot for "${oxyUserId}" has an inconsistent row`,
      );
    }
    const computedRecordId = await computeRecordId(row.envelope);
    if (computedRecordId !== row.recordId) {
      throw new Error(
        `[migration] MTN snapshot for "${oxyUserId}" has a mismatched recordId`,
      );
    }
    byRecordId.set(row.recordId, row);
  }
  return byRecordId;
}

function selectCanonicalLineage(
  oxyUserId: string,
  head: RepoHeadRow,
  byRecordId: Map<string, ChainRow>,
): Set<string> {
  const canonicalIds = new Set<string>();
  let expectedRecordId = head.headRecordId;
  for (let expectedSeq = head.seq; expectedSeq >= 0; expectedSeq -= 1) {
    const row = byRecordId.get(expectedRecordId);
    if (
      !row ||
      row.seq !== expectedSeq ||
      row.chainStatus === MTN_CHAIN_STATUS.CONFLICT
    ) {
      throw new Error(
        `[migration] MTN canonical lineage for "${oxyUserId}" is inconsistent at seq ${expectedSeq}`,
      );
    }
    if (canonicalIds.has(String(row._id))) {
      throw new Error(
        `[migration] MTN canonical lineage for "${oxyUserId}" contains a cycle`,
      );
    }
    canonicalIds.add(String(row._id));

    if (expectedSeq === 0) {
      if (row.prev !== null) {
        throw new Error(
          `[migration] MTN genesis for "${oxyUserId}" has a non-null prev`,
        );
      }
    } else if (typeof row.prev !== 'string' || row.prev.length === 0) {
      throw new Error(
        `[migration] MTN canonical lineage for "${oxyUserId}" has no predecessor at seq ${expectedSeq}`,
      );
    } else {
      expectedRecordId = row.prev;
    }
  }

  if (canonicalIds.size !== head.seq + 1) {
    throw new Error(
      `[migration] MTN canonical lineage for "${oxyUserId}" has the wrong length`,
    );
  }
  return canonicalIds;
}

async function writeStatuses(
  records: mongoose.mongo.Collection,
  rows: ChainRow[],
  canonicalIds: Set<string>,
  context?: MigrationContext,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += DATA_BATCH_SIZE) {
    await context?.assertLease();
    const chunk = rows.slice(offset, offset + DATA_BATCH_SIZE);
    await records.bulkWrite(
      chunk.map((row) => {
        const canonical = canonicalIds.has(String(row._id));
        return {
          updateOne: {
            filter: { _id: row._id },
            update: canonical
              ? {
                  $set: {
                    chainStatus: MTN_CHAIN_STATUS.CANONICAL,
                  },
                }
              : {
                  $set: {
                    chainStatus: MTN_CHAIN_STATUS.CONFLICT,
                  },
                  $unset: {
                    seq: '',
                    prev: '',
                  },
                },
          },
        };
      }),
      { ordered: true },
    );
  }
}

async function classifyDuplicateChains(
  records: mongoose.mongo.Collection,
  heads: mongoose.mongo.Collection,
  context?: MigrationContext,
): Promise<number> {
  const duplicateOwners = records.aggregate<DuplicateChainOwner>(
    [
      { $match: { seq: { $type: 'number' } } },
      {
        $group: {
          _id: { oxyUserId: '$oxyUserId', seq: '$seq' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $group: { _id: '$_id.oxyUserId' } },
      { $sort: { _id: 1 } },
    ],
    { allowDiskUse: true, batchSize: DATA_BATCH_SIZE },
  );

  let classifiedOwners = 0;
  for await (const owner of duplicateOwners) {
    await context?.assertLease();
    const oxyUserId = owner._id;
    if (typeof oxyUserId !== 'string' || oxyUserId.length === 0) {
      throw new Error('[migration] MTN duplicate sequence has no valid owner');
    }

    let classified = false;
    for (let attempt = 0; attempt < HEAD_STABILITY_RETRIES; attempt += 1) {
      const headProjection = {
        oxyUserId: 1,
        subjectDid: 1,
        seq: 1,
        headRecordId: 1,
        recordCount: 1,
      };
      const head = await heads.findOne<RepoHeadRow>(
        { oxyUserId },
        { projection: headProjection },
      );
      assertValidHead(oxyUserId, head);

      const rows = await records
        .find<ChainRow>(
          {
            oxyUserId,
            seq: { $type: 'number', $lte: head.seq },
          },
          {
            projection: {
              oxyUserId: 1,
              subjectDid: 1,
              seq: 1,
              prev: 1,
              recordId: 1,
              verified: 1,
              chainStatus: 1,
              envelope: 1,
            },
          },
        )
        .batchSize(DATA_BATCH_SIZE)
        .toArray();

      // A live writer may advance the head while the migration scans. Only
      // classify against a stable snapshot; prepareUnique already prevents it
      // from creating another duplicate key.
      const stableHead = await heads.findOne<RepoHeadRow>(
        { oxyUserId },
        { projection: headProjection },
      );
      assertValidHead(oxyUserId, stableHead);
      if (
        String(stableHead._id) !== String(head._id) ||
        stableHead.seq !== head.seq ||
        stableHead.headRecordId !== head.headRecordId
      ) {
        continue;
      }

      // Validate every numeric row in the stable snapshot before mutating any
      // branch metadata. Conflict rows remain eligible for per-key LWW reads,
      // so a malformed losing fork must fail the migration closed too.
      const byRecordId = await validateChainSnapshot(
        oxyUserId,
        stableHead,
        rows,
      );
      const canonicalIds = selectCanonicalLineage(
        oxyUserId,
        stableHead,
        byRecordId,
      );
      await writeStatuses(records, rows, canonicalIds, context);
      classified = true;
      break;
    }
    if (!classified) {
      throw new Error(
        `[migration] MTN repo head for "${oxyUserId}" did not stabilize during branch selection`,
      );
    }
    classifiedOwners += 1;
  }
  return classifiedOwners;
}

async function markRowsInBatches(
  records: mongoose.mongo.Collection,
  filter: Record<string, unknown>,
  chainStatus: string,
  context?: MigrationContext,
): Promise<number> {
  const cursor = records
    .find<{ _id: mongoose.mongo.BSON.ObjectId }>(filter, {
      projection: { _id: 1 },
    })
    .batchSize(DATA_BATCH_SIZE);
  let ids: mongoose.mongo.BSON.ObjectId[] = [];
  let updated = 0;

  const flush = async (): Promise<void> => {
    if (ids.length === 0) return;
    await context?.assertLease();
    const result = await records.updateMany(
      { _id: { $in: ids } },
      { $set: { chainStatus } },
    );
    updated += result.modifiedCount;
    ids = [];
  };

  for await (const row of cursor) {
    ids.push(row._id);
    if (ids.length >= DATA_BATCH_SIZE) await flush();
  }
  await flush();
  return updated;
}

async function normalizeRepoHeadCounts(
  heads: mongoose.mongo.Collection,
  context?: MigrationContext,
): Promise<number> {
  const cursor = heads
    .find<{ _id: mongoose.mongo.BSON.ObjectId; seq: number }>(
      {},
      { projection: { _id: 1, seq: 1 } },
    )
    .batchSize(DATA_BATCH_SIZE);
  let ids: mongoose.mongo.BSON.ObjectId[] = [];
  let modified = 0;

  const flush = async (): Promise<void> => {
    if (ids.length === 0) return;
    await context?.assertLease();
    const result = await heads.updateMany(
      { _id: { $in: ids } },
      [{ $set: { recordCount: { $add: ['$seq', 1] } } }],
    );
    modified += result.modifiedCount;
    ids = [];
  };

  for await (const head of cursor) {
    if (!Number.isSafeInteger(head.seq) || head.seq < 0) {
      throw new Error(
        `[migration] MTN repo head "${String(head._id)}" has an invalid seq`,
      );
    }
    ids.push(head._id);
    if (ids.length >= DATA_BATCH_SIZE) await flush();
  }
  await flush();
  return modified;
}

async function assertSequencesUnique(
  records: mongoose.mongo.Collection,
): Promise<void> {
  const duplicate = await records
    .aggregate(
      [
        {
          $match: {
            seq: { $type: 'number' },
          },
        },
        {
          $group: {
            _id: { oxyUserId: '$oxyUserId', seq: '$seq' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ],
      { allowDiskUse: true, batchSize: 1 },
    )
    .next();
  if (duplicate) {
    throw new Error(
      '[migration] MTN sequence classification still contains duplicates',
    );
  }
}

interface SequenceIndexConversion {
  index: MongoIndexInfo;
  needsFinalize: boolean;
}

async function prepareSequenceIndex(
  db: mongoose.mongo.Db,
  records: mongoose.mongo.Collection,
  indexes: MongoIndexInfo[],
  context?: MigrationContext,
): Promise<SequenceIndexConversion> {
  const sameKeyIndexes = indexes.filter((index) =>
    sameOrderedKey(index.key, { ...MTN_SEQUENCE_INDEX.key }));
  if (sameKeyIndexes.length > 1) {
    throw new Error(
      '[migration] multiple MTN sequence indexes exist; refusing online conversion',
    );
  }

  let sequenceIndex: MongoIndexInfo | undefined = sameKeyIndexes[0];
  if (
    sequenceIndex &&
    !sameValue(
      sequenceIndex.partialFilterExpression,
      MTN_SEQUENCE_INDEX.partialFilterExpression,
    )
  ) {
    throw new Error(
      `[migration] MTN index "${sequenceIndex.name}" on ` +
        `${JSON.stringify(MTN_SEQUENCE_INDEX.key)} has an unknown partial filter; refusing to replace it`,
    );
  }

  if (!sequenceIndex) {
    const conflictingName = indexes.find(
      (index) => index.name === MTN_SEQUENCE_INDEX.name,
    );
    if (conflictingName) {
      throw new Error(
        `[migration] MTN index name "${MTN_SEQUENCE_INDEX.name}" already exists with key ` +
          `${JSON.stringify(conflictingName.key)}; refusing to replace it`,
      );
    }
    await context?.assertLease();
    await records.createIndex(
      { ...MTN_SEQUENCE_INDEX.key },
      {
        name: MTN_SEQUENCE_INDEX.name,
        partialFilterExpression: {
          ...MTN_SEQUENCE_INDEX.partialFilterExpression,
        },
      },
    );
    sequenceIndex = {
      name: MTN_SEQUENCE_INDEX.name,
      key: { ...MTN_SEQUENCE_INDEX.key },
      unique: false,
      prepareUnique: false,
      partialFilterExpression: {
        ...MTN_SEQUENCE_INDEX.partialFilterExpression,
      },
    };
    indexes.push(sequenceIndex);
  }

  if (sequenceIndex.unique === true) {
    return { index: sequenceIndex, needsFinalize: false };
  }

  if (sequenceIndex.prepareUnique !== true) {
    await context?.assertLease();
    await db.command({
      collMod: MENTION_SIGNED_RECORD_COLLECTION,
      index: {
        name: sequenceIndex.name,
        prepareUnique: true,
      },
    });
    sequenceIndex.prepareUnique = true;
  }
  return { index: sequenceIndex, needsFinalize: true };
}

async function finalizeSequenceIndex(
  db: mongoose.mongo.Db,
  conversion: SequenceIndexConversion,
  context?: MigrationContext,
): Promise<void> {
  if (!conversion.needsFinalize) return;

  await context?.assertLease();
  await db.command({
    collMod: MENTION_SIGNED_RECORD_COLLECTION,
    index: {
      name: conversion.index.name,
      unique: true,
    },
    dryRun: true,
  });
  await context?.assertLease();
  await db.command({
    collMod: MENTION_SIGNED_RECORD_COLLECTION,
    index: {
      name: conversion.index.name,
      unique: true,
    },
  });
  conversion.index.unique = true;
  conversion.index.prepareUnique = false;
}

async function ensureRepoHeadOwnerIndex(
  db: mongoose.mongo.Db,
  heads: mongoose.mongo.Collection,
  context?: MigrationContext,
): Promise<void> {
  const indexes = await readIndexes(heads);
  const sameKeyIndexes = indexes.filter((index) =>
    sameOrderedKey(index.key, { ...MTN_REPO_HEAD_OWNER_INDEX.key }));
  if (sameKeyIndexes.length > 1) {
    throw new Error(
      '[migration] multiple MTN repo-head owner indexes exist; refusing conversion',
    );
  }
  const sameKey = sameKeyIndexes[0];
  if (
    sameKey?.partialFilterExpression &&
    Object.keys(sameKey.partialFilterExpression).length > 0
  ) {
    throw new Error(
      `[migration] MTN repo-head index "${sameKey.name}" is partial; refusing conversion`,
    );
  }

  if (sameKey && sameKey.unique !== true && sameKey.prepareUnique !== true) {
    await context?.assertLease();
    await db.command({
      collMod: MENTION_REPO_HEAD_COLLECTION,
      index: {
        name: sameKey.name,
        prepareUnique: true,
      },
    });
    sameKey.prepareUnique = true;
  }

  const duplicateHead = await heads
    .aggregate(
      [
        { $group: { _id: '$oxyUserId', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 1 },
      ],
      { allowDiskUse: true, batchSize: 1 },
    )
    .next();
  if (duplicateHead) {
    throw new Error(
      '[migration] duplicate MentionRepoHead owners make canonical selection ambiguous',
    );
  }

  if (!sameKey) {
    const conflictingName = indexes.find(
      (index) => index.name === MTN_REPO_HEAD_OWNER_INDEX.name,
    );
    if (conflictingName) {
      throw new Error(
        `[migration] MTN repo-head index name "${MTN_REPO_HEAD_OWNER_INDEX.name}" already exists with another key`,
      );
    }
    await context?.assertLease();
    await heads.createIndex(
      { ...MTN_REPO_HEAD_OWNER_INDEX.key },
      {
        name: MTN_REPO_HEAD_OWNER_INDEX.name,
        unique: true,
      },
    );
    return;
  }

  if (sameKey.unique !== true) {
    await context?.assertLease();
    await db.command({
      collMod: MENTION_REPO_HEAD_COLLECTION,
      index: { name: sameKey.name, unique: true },
      dryRun: true,
    });
    await context?.assertLease();
    await db.command({
      collMod: MENTION_REPO_HEAD_COLLECTION,
      index: { name: sameKey.name, unique: true },
    });
  }
}

async function ensureRequiredIndexes(
  records: mongoose.mongo.Collection,
  indexes: MongoIndexInfo[],
  context?: MigrationContext,
): Promise<void> {
  for (const required of REQUIRED_MTN_INDEXES) {
    const sameKey = indexes.find((index) =>
      sameOrderedKey(index.key, { ...required.key }));
    if (sameKey) {
      if (
        sameKey.unique !== true ||
        !sameValue(
          sameKey.partialFilterExpression,
          required.partialFilterExpression,
        )
      ) {
        throw new Error(
          `[migration] MTN index "${sameKey.name}" on ` +
            `${JSON.stringify(required.key)} does not enforce the required ` +
            'unique partial constraint',
        );
      }
      continue;
    }

    const conflictingName = indexes.find((index) => index.name === required.name);
    if (conflictingName) {
      throw new Error(
        `[migration] MTN index name "${required.name}" already exists with key ` +
          `${JSON.stringify(conflictingName.key)}; refusing to replace it`,
      );
    }

    await context?.assertLease();
    await records.createIndex(
      { ...required.key },
      {
        name: required.name,
        unique: true,
        partialFilterExpression: {
          ...required.partialFilterExpression,
        },
      },
    );
    await context?.assertLease();
    indexes.push({
      name: required.name,
      key: { ...required.key },
      unique: true,
      partialFilterExpression: {
        ...required.partialFilterExpression,
      },
    });
  }
}

export const migrationMtnEventIdempotencyIndex: Migration = {
  id: MIGRATION_MTN_EVENT_IDEMPOTENCY_INDEX,

  async run(db: mongoose.mongo.Db, context): Promise<void> {
    const records = db.collection(MENTION_SIGNED_RECORD_COLLECTION);
    const heads = db.collection(MENTION_REPO_HEAD_COLLECTION);
    await context?.assertLease();
    const indexes = await readIndexes(records);
    const sequenceConversion = await prepareSequenceIndex(
      db,
      records,
      indexes,
      context,
    );
    await ensureRepoHeadOwnerIndex(db, heads, context);

    const classifiedOwners = await classifyDuplicateChains(
      records,
      heads,
      context,
    );

    // Existing v2 fork mirrors have no seq by design. Preserve them but make
    // their non-authoritative status explicit before generic canonical backfill.
    const archivedForks = await markRowsInBatches(
      records,
      {
        chainStatus: { $exists: false },
        'envelope.version': 2,
        recordId: { $type: 'string' },
        seq: { $exists: false },
      },
      MTN_CHAIN_STATUS.CONFLICT,
      context,
    );

    // Every remaining chained v2 row is unambiguous. Missing status remains
    // readable during rolling deployment, then becomes explicitly canonical.
    const canonicalBackfill = await markRowsInBatches(
      records,
      {
        chainStatus: { $exists: false },
        seq: { $type: 'number' },
      },
      MTN_CHAIN_STATUS.CANONICAL,
      context,
    );
    const repairedHeadCounts = await normalizeRepoHeadCounts(heads, context);

    await context?.assertLease();
    await assertSequencesUnique(records);
    await finalizeSequenceIndex(db, sequenceConversion, context);
    await ensureRequiredIndexes(records, indexes, context);

    logger.info('[migration] ensured MTN branch metadata and indexes', {
      indexes: REQUIRED_MTN_INDEXES.map((index) => index.name),
      classifiedOwners,
      archivedForks,
      canonicalBackfill,
      repairedHeadCounts,
    });
  },
};
