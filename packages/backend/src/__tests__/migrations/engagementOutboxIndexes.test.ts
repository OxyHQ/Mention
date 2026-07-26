import { describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import { migrationEngagementOutboxIndexes } from '../../migrations/0011-engagement-outbox-indexes';
import { ENGAGEMENT_OUTBOX_COLLECTION } from '../../models/EngagementOutbox';

describe('migration 0011 - engagement outbox indexes', () => {
  it('creates bounded claim/reclaim scans and a hard retention ceiling', async () => {
    const outboxCreateIndex = vi.fn().mockResolvedValue('created');
    const notificationCreateIndex = vi.fn().mockResolvedValue('created');
    const db = {
      collection: vi.fn((name: string) => {
        if (name === ENGAGEMENT_OUTBOX_COLLECTION) {
          return { createIndex: outboxCreateIndex };
        }
        if (name === 'notifications') {
          return {
            indexes: vi.fn().mockResolvedValue([]),
            createIndex: notificationCreateIndex,
          };
        }
        throw new Error(`unexpected collection ${name}`);
      }),
    } as unknown as mongoose.mongo.Db;

    await migrationEngagementOutboxIndexes.run(db);

    expect(db.collection).toHaveBeenCalledWith(ENGAGEMENT_OUTBOX_COLLECTION);
    expect(outboxCreateIndex).toHaveBeenCalledWith(
      { status: 1, availableAt: 1, createdAt: 1 },
      { name: 'status_1_availableAt_1_createdAt_1' },
    );
    expect(outboxCreateIndex).toHaveBeenCalledWith(
      { status: 1, leaseUntil: 1, createdAt: 1 },
      { name: 'status_1_leaseUntil_1_createdAt_1' },
    );
    expect(outboxCreateIndex).toHaveBeenCalledWith(
      { 'payload.relationshipId': 1, revision: 1, status: 1 },
      { name: 'payload.relationshipId_1_revision_1_status_1' },
    );
    expect(outboxCreateIndex).toHaveBeenCalledWith(
      { expiresAt: 1 },
      {
        name: 'expiresAt_1',
        expireAfterSeconds: 0,
      },
    );
    expect(notificationCreateIndex).toHaveBeenCalledWith(
      { recipientId: 1, actorId: 1, type: 1, entityId: 1 },
      { unique: true },
    );
  });

  it('fails explicitly when notification dedupe has an equivalent non-unique index', async () => {
    const outboxCreateIndex = vi.fn();
    const db = {
      collection: vi.fn((name: string) => {
        if (name === ENGAGEMENT_OUTBOX_COLLECTION) {
          return { createIndex: outboxCreateIndex };
        }
        if (name === 'notifications') {
          return {
            indexes: vi.fn().mockResolvedValue([
              {
                name: 'notification_dedupe_plain',
                key: { recipientId: 1, actorId: 1, type: 1, entityId: 1 },
              },
            ]),
            createIndex: vi.fn(),
          };
        }
        throw new Error(`unexpected collection ${name}`);
      }),
    } as unknown as mongoose.mongo.Db;

    await expect(migrationEngagementOutboxIndexes.run(db)).rejects.toThrow(
      /notifications index "notification_dedupe_plain".*is non-unique/,
    );
    expect(outboxCreateIndex).not.toHaveBeenCalled();
  });
});
