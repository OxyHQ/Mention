import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The repo-wide `setup.ts` replaces `mongoose.connect` with a no-op so no test can
 * open a real connection. This one file opts out, so mongoose and everything that
 * reaches it are imported dynamically below the hoisted unmock.
 */
vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { default: Bookmark } = await import('../../models/Bookmark');
const { default: EngagementOutbox } = await import('../../models/EngagementOutbox');
const { default: Like } = await import('../../models/Like');
const { default: Post } = await import('../../models/Post');
const { enqueueEngagementOutboxEvent } = await import(
  '../../services/EngagementOutboxService'
);
const { savePostCommand, votePostCommand } = await import(
  '../../services/PostEngagementCommandService'
);

/**
 * The engagement write path, against a REAL server.
 *
 * ## Why this file exists
 *
 * `moderationOutboxWrites.test.ts` says it for the moderation outbox; this is the
 * same defect in the two places that were LIVE. `EngagementOutboxService` and the
 * bookmark upsert in `PostEngagementCommandService` both named
 * `createdAt`/`updatedAt` in `$setOnInsert` against schemas declaring
 * `{ timestamps: true }`, so Mongoose added the same paths and Mongo refused the
 * whole update — `Updating the path 'updatedAt' would create a conflict at
 * 'updatedAt'`. Inside `inIdempotentTransaction` that abort took the command with
 * it, so every like, downvote, save and unsave failed. It shipped in `ce333c92`
 * and the suite stayed green throughout, because a mocked `updateOne` accepts any
 * update document at all.
 *
 * ## Why a replica set, unlike the moderation file
 *
 * That file tests the enqueue in isolation and can use a standalone server. These
 * are the real commands — `votePostCommand` and `savePostCommand` open
 * transactions — so this pays for a single-member replica set to run the code
 * production runs rather than a reconstruction of it. That is the point: the
 * defect was invisible to every reconstruction.
 *
 * The assertions in `EngagementOutboxService.test.ts` and
 * `PostEngagementCommandService.test.ts` that read the update document are a fast
 * tripwire for the same regression, not the gate. Only this file can fail for the
 * reason production failed.
 */

let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri(), { dbName: 'engagement-writes' });
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

async function seedPost(): Promise<string> {
  const postId = new mongoose.Types.ObjectId();
  await Post.collection.insertOne({
    _id: postId,
    oxyUserId: 'oxy-author',
    authorship: [{ oxyUserId: 'oxy-author', role: 'owner', status: 'accepted' }],
    stats: { likesCount: 0, downvotesCount: 0, savesCount: 0 },
    status: 'published',
  } as never);
  return postId.toHexString();
}

describe('the engagement writes are ones Mongo accepts', () => {
  it('records a like, its relation and its outbox event', async () => {
    const postId = await seedPost();

    const result = await votePostCommand({ userId: 'viewer-a', postId, value: 1 });

    expect(result.changed).toBe(true);
    expect(await Like.countDocuments({ postId })).toBe(1);
    expect(await EngagementOutbox.countDocuments({ _id: result.outboxEventId })).toBe(1);
    const post = await Post.findById(postId).lean();
    expect(post?.stats?.likesCount).toBe(1);
  });

  it('records a save, its bookmark and its outbox event', async () => {
    const postId = await seedPost();

    const result = await savePostCommand({ userId: 'viewer-a', postId });

    expect(result.changed).toBe(true);
    expect(await Bookmark.countDocuments({ postId })).toBe(1);
    expect(await EngagementOutbox.countDocuments({ _id: result.outboxEventId })).toBe(1);
  });

  it('a duplicate save writes NOTHING — not even updatedAt', async () => {
    /**
     * The assertion that separates the two candidate fixes.
     *
     * Both `timestamps: false` + explicit fields and "let Mongoose own them" clear
     * the update conflict, and both leave exactly one bookmark — a row that was
     * rewritten is still one row, so a count cannot tell them apart. Only
     * `updatedAt` moves.
     *
     * The 25 ms wait is load-bearing: without it an unchanged timestamp could be
     * same-millisecond luck, and this would pass under the wrong fix about half the
     * time.
     */
    const postId = await seedPost();
    await savePostCommand({ userId: 'viewer-a', postId });
    const before = await Bookmark.findOne({ userId: 'viewer-a', postId }).lean();

    await new Promise((resolve) => setTimeout(resolve, 25));
    const duplicate = await savePostCommand({ userId: 'viewer-a', postId });
    const after = await Bookmark.findOne({ userId: 'viewer-a', postId }).lean();

    expect(duplicate.changed).toBe(false);
    expect(await Bookmark.countDocuments({ userId: 'viewer-a', postId })).toBe(1);
    expect(before?.updatedAt).toBeInstanceOf(Date);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
  });

  it('a replayed outbox enqueue writes NOTHING — not even updatedAt', async () => {
    /**
     * The event id is derived from the relationship and revision precisely so a
     * transaction retry or two concurrent duplicate requests upsert the SAME row.
     * If the repeat is a real write it contends with whichever dispatcher is
     * leasing that row, which is the failure the id exists to prevent.
     *
     * This calls the enqueue DIRECTLY rather than voting twice, and the difference
     * is the whole test. A second `votePostCommand` with the same value returns at
     * the "already this value" branch and never reaches the enqueue at all — so the
     * version of this test that voted twice passed under the wrong fix, proving
     * only that a no-op command is a no-op. Caught by mutation, not by review.
     */
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    const session = await mongoose.startSession();
    const enqueue = async (): Promise<string> =>
      await enqueueEngagementOutboxEvent(
        {
          kind: 'post.like',
          relationshipId,
          revision: 1,
          payload: {
            actorOxyUserId: 'viewer-b',
            postId: new mongoose.Types.ObjectId().toHexString(),
            relationshipId,
          },
        },
        session,
      );

    try {
      const eventId = await enqueue();
      const before = await EngagementOutbox.findById(eventId).lean();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const replayed = await enqueue();
      const after = await EngagementOutbox.findById(eventId).lean();

      expect(replayed).toBe(eventId);
      expect(await EngagementOutbox.countDocuments({ _id: eventId })).toBe(1);
      expect(before?.updatedAt).toBeInstanceOf(Date);
      expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
      expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
    } finally {
      await session.endSession();
    }
  });

  it('a replayed enqueue does not abort a transaction racing the dispatcher', async () => {
    /**
     * The CONSEQUENCE the no-op exists for, rather than the mechanism.
     *
     * The test above proves the repeat writes nothing, by watching `updatedAt`.
     * This one proves what that buys: the dispatcher claims, renews and completes
     * leases on these same rows inside its own transactions, so if a replayed
     * enqueue were a real write it would collide with an uncommitted one and Mongo
     * would abort the transaction that got there second. That failure is silent,
     * intermittent, and only appears under concurrency — the shape that survives
     * every single-threaded test.
     *
     * Both are worth keeping. `updatedAt` discriminates the two candidate fixes
     * cheaply; this one is the reason to care which one is chosen, and it fails
     * with a write conflict rather than a moved timestamp.
     */
    const relationshipId = new mongoose.Types.ObjectId().toHexString();
    const payload = {
      actorOxyUserId: 'viewer-c',
      postId: new mongoose.Types.ObjectId().toHexString(),
      relationshipId,
    };
    const seed = await mongoose.startSession();
    let eventId = '';
    try {
      eventId = await enqueueEngagementOutboxEvent(
        { kind: 'post.like', relationshipId, revision: 1, payload },
        seed,
      );
    } finally {
      await seed.endSession();
    }

    const dispatcher = await mongoose.startSession();
    const replay = await mongoose.startSession();
    try {
      // The dispatcher holds an uncommitted write on the row, as it does whenever
      // it is claiming or renewing that event's lease.
      dispatcher.startTransaction();
      await EngagementOutbox.updateOne(
        { _id: eventId },
        { $set: { leaseOwner: 'dispatcher-1' } },
        { session: dispatcher },
      );

      // The replay lands on the same row, in its own transaction, while that write
      // is still open. It must write nothing and therefore conflict with nothing.
      replay.startTransaction();
      await expect(
        enqueueEngagementOutboxEvent(
          { kind: 'post.like', relationshipId, revision: 1, payload },
          replay,
        ),
      ).resolves.toBe(eventId);
      await expect(replay.commitTransaction()).resolves.not.toThrow();
      await dispatcher.commitTransaction();

      const stored = await EngagementOutbox.findById(eventId).lean();
      expect(stored?.leaseOwner).toBe('dispatcher-1');
      expect(await EngagementOutbox.countDocuments({ _id: eventId })).toBe(1);
    } finally {
      await dispatcher.endSession();
      await replay.endSession();
    }
  });
});
