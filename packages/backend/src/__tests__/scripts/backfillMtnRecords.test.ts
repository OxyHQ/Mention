import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';

/**
 * Offline, model-level tests for the MTN record backfill.
 *
 * `Post` (count/find/findById), `MentionSignedRecord` (existence checks),
 * `isMentionRecordSigningEnabled`, and `emitPostCreated` are mocked so the REAL
 * candidate selection, existence-skip, ordering, and inert-safe bail are
 * exercised WITHOUT MongoDB or a signing key. Mirrors the in-package pattern from
 * `scripts/migrateThreadFanToChain.test.ts`.
 */

interface PostRow {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
}

const h = vi.hoisted(() => {
  const state: {
    signingEnabled: boolean;
    posts: PostRow[];
    // rkeys (post id strings) that already have an app.mention.feed.post record.
    existingRecordRkeys: Set<string>;
    // post ids the emitter "wrote" a record for (so the post-emit `exists` check
    // reports success). Pre-seeded with existingRecordRkeys at run start.
    emittedFor: Set<string>;
  } = { signingEnabled: true, posts: [], existingRecordRkeys: new Set(), emittedFor: new Set() };

  const countDocuments = vi.fn(async () => state.posts.length);

  // Post.find returns the candidate page on the FIRST cursor read, then an empty
  // page so the script's `for (;;)` paging loop terminates (the real cursor
  // advances past the last (createdAt, _id) and finds nothing more). A query with
  // a `$or` cursor clause is a subsequent page → empty.
  const find = vi.fn((query: Record<string, unknown>) => ({
    sort: () => ({
      limit: () => ({
        lean: async () => (query.$or ? [] : state.posts),
      }),
    }),
  }));

  const findById = vi.fn(async (id: mongoose.Types.ObjectId) => {
    const row = state.posts.find((p) => p._id.toString() === id.toString());
    if (!row) return null;
    return {
      _id: row._id,
      oxyUserId: 'user-A',
      federation: undefined,
      parentPostId: undefined,
      threadId: undefined,
      content: { text: 'a backfilled post body long enough' },
    };
  });

  // MentionSignedRecord.find — batched existence check.
  const recordFind = vi.fn((query: { rkey?: { $in?: string[] } }) => ({
    lean: async () => {
      const ids = query?.rkey?.$in ?? [];
      return ids
        .filter((id) => state.existingRecordRkeys.has(id))
        .map((rkey) => ({ rkey }));
    },
  }));

  // MentionSignedRecord.exists — post-emit confirmation.
  const recordExists = vi.fn(async (query: { rkey?: string }) => {
    const rkey = query?.rkey;
    return rkey && state.emittedFor.has(rkey) ? { _id: rkey } : null;
  });

  const isSigningEnabled = vi.fn(() => state.signingEnabled);

  // emitPostCreated — record that a record was "written" for this post id.
  const emitPostCreated = vi.fn(async (post: { _id: mongoose.Types.ObjectId }) => {
    state.emittedFor.add(post._id.toString());
  });

  return {
    state,
    countDocuments,
    find,
    findById,
    recordFind,
    recordExists,
    isSigningEnabled,
    emitPostCreated,
  };
});

vi.mock('../../models/Post', () => ({
  Post: { countDocuments: h.countDocuments, find: h.find, findById: h.findById },
}));

vi.mock('../../models/MentionSignedRecord', () => ({
  default: { find: h.recordFind, exists: h.recordExists },
}));

vi.mock('../../services/mtn/mentionRecordEnv', () => ({
  isMentionRecordSigningEnabled: h.isSigningEnabled,
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: h.emitPostCreated,
}));

vi.mock('../../utils/database', () => ({
  connectToDatabase: vi.fn(async () => undefined),
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.spyOn(mongoose, 'disconnect').mockResolvedValue(undefined as never);

import backfillMtnRecords from '../../scripts/backfill-mtn-records';

beforeEach(() => {
  h.state.signingEnabled = true;
  h.state.posts = [];
  h.state.existingRecordRkeys = new Set();
  h.state.emittedFor = new Set();
  h.countDocuments.mockClear();
  h.find.mockClear();
  h.findById.mockClear();
  h.recordFind.mockClear();
  h.recordExists.mockClear();
  h.isSigningEnabled.mockClear();
  h.emitPostCreated.mockClear();
});

describe('backfillMtnRecords', () => {
  it('is a no-op when MTN signing is disabled (writes no records)', async () => {
    h.state.signingEnabled = false;
    h.state.posts = [{ _id: new mongoose.Types.ObjectId(), createdAt: new Date() }];

    await backfillMtnRecords();

    // Bailed before scanning — no candidate scan, no emission.
    expect(h.countDocuments).not.toHaveBeenCalled();
    expect(h.emitPostCreated).not.toHaveBeenCalled();
  });

  it('emits a genesis record for a post lacking one and skips posts that already have one', async () => {
    const needsRecord = new mongoose.Types.ObjectId();
    const hasRecord = new mongoose.Types.ObjectId();
    h.state.posts = [
      { _id: needsRecord, createdAt: new Date('2024-01-01T00:00:00Z') },
      { _id: hasRecord, createdAt: new Date('2024-01-02T00:00:00Z') },
    ];
    // The second post already has an app.mention.feed.post record.
    h.state.existingRecordRkeys = new Set([hasRecord.toString()]);

    await backfillMtnRecords();

    // Only the post lacking a record is emitted; the existing one is skipped.
    expect(h.emitPostCreated).toHaveBeenCalledTimes(1);
    const emittedPost = h.emitPostCreated.mock.calls[0][0] as { _id: mongoose.Types.ObjectId };
    expect(emittedPost._id.toString()).toBe(needsRecord.toString());
  });

  it('does nothing when there are no candidate posts', async () => {
    h.state.posts = [];

    await backfillMtnRecords();

    expect(h.emitPostCreated).not.toHaveBeenCalled();
  });
});
