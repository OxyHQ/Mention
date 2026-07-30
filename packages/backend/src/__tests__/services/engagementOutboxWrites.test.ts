import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The repo-wide `setup.ts` replaces `mongoose.connect` with a no-op so no test
 * can open a real connection. That is the right default and it is exactly why
 * this class of defect was invisible: with it in force, every query buffers and
 * nothing a real server would reject is ever sent to one.
 *
 * This one file opts out. The unmock is hoisted above the imports, so mongoose
 * and everything that reaches it are loaded dynamically below.
 */
vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { default: Bookmark } = await import('../../models/Bookmark');
const { default: EngagementOutbox } = await import('../../models/EngagementOutbox');
const { default: Post } = await import('../../models/Post');
const { enqueueEngagementOutboxEvent } = await import(
  '../../services/EngagementOutboxService'
);
const { savePostCommand } = await import('../../services/PostEngagementCommandService');

/**
 * The engagement writes, against a REAL server.
 *
 * ## Why this file exists
 *
 * Every other engagement test mocks `EngagementOutbox` and `Bookmark`, and a
 * mocked `updateOne` accepts any update document at all. That made a whole class
 * of defect invisible: an update Mongo itself rejects passes a mocked suite
 * unanimously.
 *
 * It shipped one. `enqueueEngagementOutboxEvent` and `savePostCommand` both named
 * `createdAt`/`updatedAt` in `$setOnInsert` while their schemas declare
 * `{ timestamps: true }`, so Mongoose added `updatedAt` to `$set` itself and Mongo
 * refused the whole write with `Updating the path 'updatedAt' would create a
 * conflict at 'updatedAt'`. Both writes happen inside the transaction that owns
 * the relationship and the counter, so the abort took the domain write with it —
 * every like, downvote, save and unsave failed in production, in a tree whose
 * suite was green.
 *
 * This is the shape `~/Oxy/AGENTS.md` calls a check that cannot distinguish
 * success from failure. The fix is not a better assertion against the mock; it is
 * one test that lets the database answer.
 *
 * ## Why a replica set
 *
 * Unlike the moderation outbox, the engagement commands open a REAL transaction
 * themselves (`savePostCommand` → `session.withTransaction`), and it is the abort
 * of that transaction that turned a rejected outbox row into a lost save. A
 * standalone server cannot start one, so the production path could only be
 * reconstructed rather than run. A single-member replica set runs it.
 */

let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri(), { dbName: 'engagement-outbox-writes' });
}, 240_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

/** Run `operation` inside a real transaction, exactly as the commands do. */
async function inTransaction(
  operation: (session: mongoose.ClientSession) => Promise<void>,
): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await operation(session);
    });
  } finally {
    await session.endSession();
  }
}

async function createPostFixture(): Promise<string> {
  const post = await Post.create({
    oxyUserId: 'author-1',
    authorship: [{ oxyUserId: 'author-1', role: 'owner', status: 'accepted' }],
    content: { text: 'engagement fixture' },
  });
  return String(post._id);
}

describe('the engagement outbox write is one Mongo accepts', () => {
  it('enqueues a first event', async () => {
    const relationshipId = new mongoose.Types.ObjectId().toString();
    let returnedId: string | undefined;

    await inTransaction(async (session) => {
      returnedId = await enqueueEngagementOutboxEvent(
        {
          kind: 'post.like',
          relationshipId,
          revision: 1,
          payload: {
            actorOxyUserId: 'viewer-a',
            postId: 'post-1',
            relationshipId,
          },
        },
        session,
      );
    });

    expect(returnedId).toBe(`engagement:post.like:${relationshipId}:v1`);
    const stored = await EngagementOutbox.findById(returnedId).lean();
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('pending');
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(stored?.updatedAt).toBeInstanceOf(Date);
  });

  it('a repeated enqueue writes NOTHING — not even updatedAt', async () => {
    /**
     * The assertion that DISTINGUISHES the two candidate fixes, and the reason it
     * exists as its own test.
     *
     * Both `timestamps: false` + explicit fields and "let Mongoose own them" clear
     * the update-conflict, so both satisfy every other assertion in this file —
     * including the row-count one below, because a row that was rewritten is still
     * one row. Only `updatedAt` moves, so only `updatedAt` tells them apart.
     *
     * The 25 ms wait is load-bearing: without it an unchanged timestamp could be
     * same-millisecond luck on a fast machine, and the test would pass under the
     * wrong fix about half the time.
     */
    const relationshipId = new mongoose.Types.ObjectId().toString();
    const eventId = `engagement:post.save:${relationshipId}:v1`;
    const enqueue = async (): Promise<void> => {
      await inTransaction(async (session) => {
        await enqueueEngagementOutboxEvent(
          {
            kind: 'post.save',
            relationshipId,
            revision: 1,
            payload: {
              actorOxyUserId: 'viewer-b',
              postId: 'post-2',
              relationshipId,
            },
          },
          session,
        );
      });
    };

    await enqueue();
    const before = await EngagementOutbox.findById(eventId).lean();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await enqueue();
    const after = await EngagementOutbox.findById(eventId).lean();

    expect(before?.updatedAt).toBeInstanceOf(Date);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
  });

  it('is idempotent — a replayed enqueue writes one row, not two', async () => {
    const relationshipId = new mongoose.Types.ObjectId().toString();
    const eventId = `engagement:post.downvote:${relationshipId}:v3`;
    const enqueue = async (): Promise<void> => {
      await inTransaction(async (session) => {
        await enqueueEngagementOutboxEvent(
          {
            kind: 'post.downvote',
            relationshipId,
            revision: 3,
            payload: {
              actorOxyUserId: 'viewer-c',
              postId: 'post-3',
              relationshipId,
            },
          },
          session,
        );
      });
    };

    await enqueue();
    await enqueue();

    expect(await EngagementOutbox.countDocuments({ _id: eventId })).toBe(1);
  });
});

describe('savePostCommand commits the bookmark, the counter and the event together', () => {
  it('saves a post', async () => {
    const postId = await createPostFixture();

    const result = await savePostCommand({ userId: 'viewer-d', postId });

    expect(result.changed).toBe(true);
    expect(result.post.stats?.savesCount).toBe(1);
    const bookmark = await Bookmark.findById(result.bookmarkId).lean();
    expect(bookmark).not.toBeNull();
    expect(bookmark?.createdAt).toBeInstanceOf(Date);
    expect(bookmark?.updatedAt).toBeInstanceOf(Date);
    expect(await EngagementOutbox.countDocuments({ _id: result.outboxEventId })).toBe(1);
  });

  it('a repeated save writes NOTHING — not even the bookmark updatedAt', async () => {
    // Same discriminator as the outbox one above, on the write that made the
    // whole command fail first: `Bookmark` also declares `{ timestamps: true }`,
    // and the upsert runs before the outbox enqueue is ever reached.
    const postId = await createPostFixture();
    const first = await savePostCommand({ userId: 'viewer-e', postId });
    const before = await Bookmark.findById(first.bookmarkId).lean();

    await new Promise((resolve) => setTimeout(resolve, 25));
    const repeated = await savePostCommand({ userId: 'viewer-e', postId });
    const after = await Bookmark.findById(first.bookmarkId).lean();

    expect(repeated.changed).toBe(false);
    expect(before?.updatedAt).toBeInstanceOf(Date);
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(after?.createdAt?.getTime()).toBe(before?.createdAt?.getTime());
    // The counter must not move either — a second save is not a second save.
    expect(repeated.post.stats?.savesCount).toBe(1);
    expect(await Bookmark.countDocuments({ userId: 'viewer-e', postId })).toBe(1);
  });
});
