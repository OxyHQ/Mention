import type mongoose from 'mongoose';
import {
  ENGAGEMENT_OUTBOX_COLLECTION,
} from '../models/EngagementOutbox';
import { logger } from '../utils/logger';
import { MIGRATION_ENGAGEMENT_OUTBOX_INDEXES } from './constants';
import type { Migration } from './runner';

interface MongoIndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
}

const NOTIFICATION_DEDUPE_KEY = {
  recipientId: 1,
  actorId: 1,
  type: 1,
  entityId: 1,
} as const;

function hasSameKey(
  actual: Record<string, unknown>,
  expected: Record<string, 1>,
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

async function readIndexes(
  collection: mongoose.mongo.Collection,
): Promise<MongoIndexInfo[]> {
  try {
    return (await collection.indexes()) as MongoIndexInfo[];
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (
        (error as { code?: unknown }).code === 26 ||
        (error as { codeName?: unknown }).codeName === 'NamespaceNotFound'
      )
    ) {
      return [];
    }
    throw error;
  }
}

export const migrationEngagementOutboxIndexes: Migration = {
  id: MIGRATION_ENGAGEMENT_OUTBOX_INDEXES,

  async run(db, context): Promise<void> {
    const outbox = db.collection(ENGAGEMENT_OUTBOX_COLLECTION);
    const notifications = db.collection('notifications');
    const notificationIndexes = await readIndexes(notifications);
    const notificationDedupe = notificationIndexes.find((index) =>
      hasSameKey(index.key, NOTIFICATION_DEDUPE_KEY));
    if (notificationDedupe && notificationDedupe.unique !== true) {
      throw new Error(
        `[migration] notifications index "${notificationDedupe.name}" on ` +
          `${JSON.stringify(NOTIFICATION_DEDUPE_KEY)} is non-unique; remove ` +
          'duplicates and replace the index with a unique index before retrying',
      );
    }
    await context?.assertLease();

    await outbox.createIndex(
      { status: 1, availableAt: 1, createdAt: 1 },
      { name: 'status_1_availableAt_1_createdAt_1' },
    );
    await context?.assertLease();
    await outbox.createIndex(
      { status: 1, leaseUntil: 1, createdAt: 1 },
      { name: 'status_1_leaseUntil_1_createdAt_1' },
    );
    await context?.assertLease();
    await outbox.createIndex(
      { 'payload.relationshipId': 1, revision: 1, status: 1 },
      { name: 'payload.relationshipId_1_revision_1_status_1' },
    );
    await context?.assertLease();
    await outbox.createIndex(
      { expiresAt: 1 },
      {
        name: 'expiresAt_1',
        expireAfterSeconds: 0,
      },
    );
    await context?.assertLease();

    if (!notificationDedupe) {
      await notifications.createIndex(
        NOTIFICATION_DEDUPE_KEY,
        { unique: true },
      );
      await context?.assertLease();
    }

    logger.info(
      '[migration] ensured durable engagement outbox and notification idempotency indexes',
    );
  },
};
