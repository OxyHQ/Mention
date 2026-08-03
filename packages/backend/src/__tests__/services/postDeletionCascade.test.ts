import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postFind: vi.fn(),
  postDeleteMany: vi.fn(),
  postUpdateOne: vi.fn(),
  deleteMany: {} as Record<string, ReturnType<typeof vi.fn>>,
  residue: vi.fn(),
  error: vi.fn(),
  /** Successive `Post.find` results, one per boost-closure round. */
  boostRounds: [] as Array<Array<Record<string, unknown>>>,
}));

function deleteManyMock(name: string) {
  const fn = vi.fn(() => ({ exec: async () => ({ deletedCount: 1 }) }));
  mocks.deleteMany[name] = fn;
  return fn;
}

vi.mock('../../models/Post', () => ({
  Post: {
    find: (...args: unknown[]) => mocks.postFind(...args),
    deleteMany: (...args: unknown[]) => mocks.postDeleteMany(...args),
    updateOne: (...args: unknown[]) => mocks.postUpdateOne(...args),
  },
}));
vi.mock('../../models/Like', () => ({ default: { deleteMany: deleteManyMock('Like') } }));
vi.mock('../../models/Bookmark', () => ({ default: { deleteMany: deleteManyMock('Bookmark') } }));
vi.mock('../../models/Notification', () => ({
  default: { deleteMany: deleteManyMock('Notification') },
}));
vi.mock('../../models/Poll', () => ({ default: { deleteMany: deleteManyMock('Poll') } }));
vi.mock('../../models/Article', () => ({ default: { deleteMany: deleteManyMock('Article') } }));
vi.mock('../../models/Postgate', () => ({ Postgate: { deleteMany: deleteManyMock('Postgate') } }));
vi.mock('../../models/Threadgate', () => ({
  Threadgate: { deleteMany: deleteManyMock('Threadgate') },
}));
vi.mock('../../models/PostRecentReplier', () => ({
  PostRecentReplier: { deleteMany: deleteManyMock('PostRecentReplier') },
}));
vi.mock('../../models/EngagementOutbox', () => ({
  default: { deleteMany: deleteManyMock('EngagementOutbox') },
}));
vi.mock('../../models/ContentLabel', () => ({
  default: { deleteMany: deleteManyMock('ContentLabel') },
}));
vi.mock('../../models/FeedInteraction', () => ({
  FeedInteraction: { deleteMany: deleteManyMock('FeedInteraction') },
}));
vi.mock('../../models/FederationDeliveryQueue', () => ({
  default: { deleteMany: deleteManyMock('FederationDeliveryQueue') },
}));

vi.mock('../../scripts/lib/adminDeletionPreflight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scripts/lib/adminDeletionPreflight')>()),
  collectPostCascadeResidue: (...args: unknown[]) => mocks.residue(...args),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    error: (...args: unknown[]) => mocks.error(...args),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import mongoose from 'mongoose';
import { cascadeDeletedPost, collectBoostClosure } from '../../services/PostDeletionCascade';
import { POST_REFERENCE_PROBE_NAMES } from '../../scripts/lib/adminDeletionPreflight';

const CASCADE_SOURCE = readFileSync(
  path.resolve(__dirname, '../../services/PostDeletionCascade.ts'),
  'utf8',
);

const POST_ID = new mongoose.Types.ObjectId();

function filterOf(name: string): Record<string, unknown> {
  const call = mocks.deleteMany[name]?.mock.calls[0];
  if (!call) throw new Error(`${name}.deleteMany was never called`);
  return call[0] as Record<string, unknown>;
}

describe('post deletion cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boostRounds.length = 0;
    mocks.postFind.mockImplementation(() => ({
      lean: async () => mocks.boostRounds.shift() ?? [],
    }));
    mocks.postDeleteMany.mockReturnValue({ exec: async () => ({ deletedCount: 0 }) });
    mocks.postUpdateOne.mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) });
    mocks.residue.mockResolvedValue([]);
  });

  it('decides a disposition for every reference the preflight knows about', () => {
    // The compiler already enforces this (the table is a `Record` over the
    // probe union), but a runtime check carries the vacuity floor: an empty or
    // truncated probe list would satisfy the type and prove nothing.
    expect(POST_REFERENCE_PROBE_NAMES.length).toBeGreaterThanOrEqual(13);
    for (const name of POST_REFERENCE_PROBE_NAMES) {
      expect(CASCADE_SOURCE).toContain(`'${name}':`);
    }
  });

  it('deletes reply notifications, not only post ones', async () => {
    await cascadeDeletedPost({ post: { _id: POST_ID } });

    // `entityType` has three values and two of them name a post row. Filtering
    // on `'post'` alone left every reply notification behind — the shape the
    // route shipped with.
    expect(filterOf('Notification')).toEqual({
      entityType: { $in: ['post', 'reply'] },
      entityId: { $in: [POST_ID] },
    });
  });

  it('matches side tables by post id AND by the ActivityPub identifiers', async () => {
    await cascadeDeletedPost({
      post: {
        _id: POST_ID,
        federation: { activityId: 'https://remote/notes/1', url: 'https://remote/@a/1' },
      },
    });

    expect(filterOf('FeedInteraction')).toEqual({
      postUri: {
        $in: [String(POST_ID), 'https://remote/notes/1', 'https://remote/@a/1'],
      },
    });
    const keys = [String(POST_ID), 'https://remote/notes/1', 'https://remote/@a/1'];
    expect(filterOf('FederationDeliveryQueue')).toEqual({
      status: 'pending',
      $or: [
        { 'activityJson.id': { $in: keys } },
        { 'activityJson.object.id': { $in: keys } },
        { 'activityJson.object': { $in: keys } },
      ],
    });
  });

  it('cancels only the queue rows that can still act, through an indexed prefix', async () => {
    await cascadeDeletedPost({ post: { _id: POST_ID } });

    // Neither collection is indexed on the field the post is named by, and one
    // of them is never pruned at all — so an unscoped delete here is a
    // collection scan on the route every user hits. `status` is an index prefix
    // on both, and a completed row is a log entry rather than a live pointer.
    expect(filterOf('EngagementOutbox')).toEqual({
      status: 'pending',
      'payload.postId': { $in: [String(POST_ID)] },
    });
    expect(filterOf('FederationDeliveryQueue')).toMatchObject({ status: 'pending' });
  });

  it('never claims the queues it only partly clears', async () => {
    // Claiming them would make the residue check verify something the cascade
    // does not do, and report the shortfall it finds as satisfied.
    expect(CASCADE_SOURCE).toContain("'EngagementOutbox.payload.postId': 'cancel-pending'");
    expect(CASCADE_SOURCE).toContain("'FederationDeliveryQueue.activityJson': 'cancel-pending'");

    await cascadeDeletedPost({ post: { _id: POST_ID } });

    const [, claimed] = mocks.residue.mock.calls.at(-1) ?? [];
    expect(claimed).toEqual(
      expect.not.arrayContaining([
        'EngagementOutbox.payload.postId',
        'FederationDeliveryQueue.activityJson',
      ]),
    );
    expect(claimed).toEqual(expect.arrayContaining(['Like.postId', 'Bookmark.postId']));
  });

  it('cleans the references of replies the caller already deleted', async () => {
    const replyId = new mongoose.Types.ObjectId();

    await cascadeDeletedPost({
      post: { _id: POST_ID },
      alsoDeleted: [{ _id: replyId }],
    });

    expect(filterOf('Like')).toEqual({ postId: { $in: [POST_ID, replyId] } });
    expect(filterOf('Bookmark')).toEqual({ postId: { $in: [POST_ID, replyId] } });
  });

  it('decrements the parent reply counter, guarded so it cannot go negative', async () => {
    const parentId = new mongoose.Types.ObjectId();

    await cascadeDeletedPost({ post: { _id: POST_ID, parentPostId: String(parentId) } });

    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: String(parentId), 'stats.commentsCount': { $gt: 0 } },
      { $inc: { 'stats.commentsCount': -1 } },
    );
  });

  it('leaves the boost counter alone when the boosted post is being deleted too', async () => {
    const boostId = new mongoose.Types.ObjectId();
    mocks.boostRounds.push([{ _id: boostId, boostOf: String(POST_ID) }]);

    await cascadeDeletedPost({ post: { _id: POST_ID } });

    // The boost's target IS the deleted post, so decrementing its counter would
    // be writing to a row that no longer exists.
    expect(mocks.postUpdateOne).not.toHaveBeenCalled();
  });

  it('repairs the boost counters of a surviving original when a boost is deleted', async () => {
    const originalId = new mongoose.Types.ObjectId();

    await cascadeDeletedPost({
      post: {
        _id: POST_ID,
        boostOf: String(originalId),
        federation: { activityId: 'https://remote/announce/1' },
      },
    });

    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: String(originalId), 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: String(originalId), 'stats.federatedBoostsCount': { $gt: 0 } },
      { $inc: { 'stats.federatedBoostsCount': -1 } },
    );
  });

  it('does not touch the federated boost counter for a native boost', async () => {
    const originalId = new mongoose.Types.ObjectId();

    await cascadeDeletedPost({ post: { _id: POST_ID, boostOf: String(originalId) } });

    expect(mocks.postUpdateOne).toHaveBeenCalledTimes(1);
    expect(mocks.postUpdateOne).toHaveBeenCalledWith(
      { _id: String(originalId), 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
  });

  it('follows the boost graph transitively and deletes the rows last', async () => {
    const boostId = new mongoose.Types.ObjectId();
    const nestedId = new mongoose.Types.ObjectId();
    mocks.boostRounds.push(
      [{ _id: boostId, boostOf: String(POST_ID) }],
      [{ _id: nestedId, boostOf: String(boostId) }],
    );

    await cascadeDeletedPost({ post: { _id: POST_ID } });

    // A boost of a boost would otherwise be left rendering the same blank card
    // the expansion exists to prevent.
    expect(mocks.postDeleteMany).toHaveBeenCalledWith({ _id: { $in: [boostId, nestedId] } });
    // Their own references go first, so a run that dies midway leaves boosts
    // pointing at nothing rather than boost references pointing at nothing.
    expect(filterOf('Like')).toEqual({ postId: { $in: [POST_ID, boostId, nestedId] } });
  });

  it('refuses to expand an oversized boost closure instead of deleting a prefix', async () => {
    mocks.boostRounds.push(
      Array.from({ length: 501 }, () => ({
        _id: new mongoose.Types.ObjectId(),
        boostOf: String(POST_ID),
      })),
    );

    await expect(collectBoostClosure([String(POST_ID)])).resolves.toBeNull();
  });

  it('deletes nothing at all when the boost closure is refused', async () => {
    mocks.boostRounds.push(
      Array.from({ length: 501 }, () => ({
        _id: new mongoose.Types.ObjectId(),
        boostOf: String(POST_ID),
      })),
    );

    await cascadeDeletedPost({ post: { _id: POST_ID } });

    expect(mocks.deleteMany.Like).not.toHaveBeenCalled();
    expect(mocks.postDeleteMany).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(
      'Post deletion cascade refused to expand an oversized boost closure',
      expect.objectContaining({ postId: String(POST_ID) }),
    );
  });

  it('names the leg that failed instead of swallowing it', async () => {
    mocks.deleteMany.Like.mockReturnValueOnce({
      exec: async () => {
        throw new Error('index build in progress');
      },
    });

    await cascadeDeletedPost({ post: { _id: POST_ID } });

    // `Promise.allSettled` never rejects, so the previous shape could not tell a
    // leg that threw from one that deleted nothing.
    expect(mocks.error).toHaveBeenCalledWith(
      'Post deletion cascade leg failed',
      expect.objectContaining({ reference: 'Like.postId' }),
    );
    expect(mocks.error).toHaveBeenCalledWith(
      'Post deletion cascade left references behind',
      expect.objectContaining({ failedLegs: ['Like.postId'] }),
    );
  });

  it('reports residue found by re-running the probes it claimed', async () => {
    mocks.residue.mockResolvedValue(['Bookmark.postId']);

    await cascadeDeletedPost({ post: { _id: POST_ID } });

    expect(mocks.error).toHaveBeenCalledWith(
      'Post deletion cascade left references behind',
      expect.objectContaining({ residue: ['Bookmark.postId'] }),
    );
  });

  it('stays silent when the cascade is clean', async () => {
    await cascadeDeletedPost({ post: { _id: POST_ID } });

    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('never reports a delete the user asked for as a failure', async () => {
    mocks.postFind.mockImplementation(() => ({
      lean: async () => {
        throw new Error('Mongo unavailable');
      },
    }));

    await expect(cascadeDeletedPost({ post: { _id: POST_ID } })).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith(
      'Post deletion cascade failed',
      expect.objectContaining({ postId: String(POST_ID) }),
    );
  });

  it('keeps moderation reports, which are not the deleting user’s to erase', () => {
    // Deleting the row would strand an inbound CrowdSource decision:
    // `ModerationDecisionWorker` resolves a case through
    // `Report.crowdSourceCaseId` and treats "no local report" as retryable.
    expect(CASCADE_SOURCE).toContain("'Report.reportedId(post)': 'retain'");
    expect(mocks.deleteMany.Report).toBeUndefined();
  });
});
