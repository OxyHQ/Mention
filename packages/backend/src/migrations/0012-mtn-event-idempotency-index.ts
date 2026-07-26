import type mongoose from 'mongoose';
import {
  MTN_CHAIN_INTEGRITY_INDEXES,
  MTN_EVENT_IDEMPOTENCY_INDEX,
} from '../indexes/manifest';
import { MENTION_SIGNED_RECORD_COLLECTION } from '../models/MentionSignedRecord';
import { logger } from '../utils/logger';
import { MIGRATION_MTN_EVENT_IDEMPOTENCY_INDEX } from './constants';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
}

const REQUIRED_MTN_INDEXES = [
  ...MTN_CHAIN_INTEGRITY_INDEXES,
  MTN_EVENT_IDEMPOTENCY_INDEX,
] as const;

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

export const migrationMtnEventIdempotencyIndex: Migration = {
  id: MIGRATION_MTN_EVENT_IDEMPOTENCY_INDEX,

  async run(db: mongoose.mongo.Db, context): Promise<void> {
    const records = db.collection(MENTION_SIGNED_RECORD_COLLECTION);
    await context?.assertLease();
    const indexes = await readIndexes(records);

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

    logger.info('[migration] ensured MTN chain and event idempotency indexes', {
      indexes: REQUIRED_MTN_INDEXES.map((index) => index.name),
    });
  },
};
