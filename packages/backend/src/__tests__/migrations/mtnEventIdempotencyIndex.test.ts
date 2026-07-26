import { describe, expect, it, vi } from 'vitest';
import type mongoose from 'mongoose';
import {
  MTN_CHAIN_INTEGRITY_INDEXES,
  MTN_EVENT_IDEMPOTENCY_INDEX,
} from '../../indexes/manifest';
import { migrationMtnEventIdempotencyIndex } from '../../migrations/0012-mtn-event-idempotency-index';
import { MENTION_SIGNED_RECORD_COLLECTION } from '../../models/MentionSignedRecord';

describe('migration 0012 - MTN event idempotency index', () => {
  it('creates the two chain backstops and partial unique event key before workers start', async () => {
    const createIndex = vi.fn().mockResolvedValue('created');
    const assertLease = vi.fn().mockResolvedValue(undefined);
    const db = {
      collection: vi.fn(() => ({
        createIndex,
        indexes: vi.fn().mockResolvedValue([]),
      })),
    } as unknown as mongoose.mongo.Db;

    await migrationMtnEventIdempotencyIndex.run(db, {
      signal: new AbortController().signal,
      assertLease,
    });

    expect(db.collection).toHaveBeenCalledWith(MENTION_SIGNED_RECORD_COLLECTION);
    for (const index of [
      ...MTN_CHAIN_INTEGRITY_INDEXES,
      MTN_EVENT_IDEMPOTENCY_INDEX,
    ]) {
      expect(createIndex).toHaveBeenCalledWith(
        index.key,
        {
          name: index.name,
          unique: true,
          partialFilterExpression: index.partialFilterExpression,
        },
      );
    }
    expect(createIndex).toHaveBeenCalledTimes(3);
    expect(assertLease).toHaveBeenCalledTimes(7);
  });

  it('accepts equivalent existing unique chain indexes regardless of their names', async () => {
    const createIndex = vi.fn().mockResolvedValue(MTN_EVENT_IDEMPOTENCY_INDEX.name);
    const indexes = MTN_CHAIN_INTEGRITY_INDEXES.map((index) => ({
      name: `legacy_${index.name}`,
      key: { ...index.key },
      unique: true,
      partialFilterExpression: { ...index.partialFilterExpression },
    }));
    const db = {
      collection: vi.fn(() => ({
        createIndex,
        indexes: vi.fn().mockResolvedValue(indexes),
      })),
    } as unknown as mongoose.mongo.Db;

    await migrationMtnEventIdempotencyIndex.run(db);

    expect(createIndex).toHaveBeenCalledTimes(1);
    expect(createIndex).toHaveBeenCalledWith(
      MTN_EVENT_IDEMPOTENCY_INDEX.key,
      expect.objectContaining({ name: MTN_EVENT_IDEMPOTENCY_INDEX.name }),
    );
  });

  it('fails closed when an equivalent chain index is not unique', async () => {
    const createIndex = vi.fn();
    const [recordIdIndex] = MTN_CHAIN_INTEGRITY_INDEXES;
    const db = {
      collection: vi.fn(() => ({
        createIndex,
        indexes: vi.fn().mockResolvedValue([
          {
            name: recordIdIndex.name,
            key: { ...recordIdIndex.key },
            unique: false,
            partialFilterExpression: {
              ...recordIdIndex.partialFilterExpression,
            },
          },
        ]),
      })),
    } as unknown as mongoose.mongo.Db;

    await expect(migrationMtnEventIdempotencyIndex.run(db)).rejects.toThrow(
      'does not enforce the required unique partial constraint',
    );
    expect(createIndex).not.toHaveBeenCalled();
  });
});
