/**
 * The concrete engagement dispatcher: what each event kind actually delivers,
 * and the interval loop that drains them.
 *
 * The MTN, federation and notification effects stay mocked — they are other
 * services' contracts and are tested there. What is REAL here is Postgres,
 * because `handleEngagementOutboxEvent` now READS the post's authorship instead
 * of trusting a snapshot the event carried. `engagement_outbox.payload` used to
 * hold a `Mixed` copy of the authorship array; the column is dropped and the
 * rows in `post_authorships` are the authority, so a test that mocked that read
 * away would be asserting nothing about the only thing this port changed here.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  emitLikeCreatedStrict: vi.fn(),
  emitTombstoneStrict: vi.fn(),
  emitBookmarkCreatedStrict: vi.fn(),
  federateAsResolvedActorAndWait: vi.fn(),
  createPostAuthorNotificationsStrict: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitLikeCreatedStrict: mocks.emitLikeCreatedStrict,
  emitTombstoneStrict: mocks.emitTombstoneStrict,
  emitBookmarkCreatedStrict: mocks.emitBookmarkCreatedStrict,
  likeRecordUri: (userId: string, relationId: string) =>
    `mtn://${userId}/likes/${relationId}`,
  bookmarkRecordUri: (userId: string, relationId: string) =>
    `mtn://${userId}/bookmarks/${relationId}`,
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActorAndWait: mocks.federateAsResolvedActorAndWait,
}));

vi.mock('../../utils/notificationUtils', () => ({
  createPostAuthorNotificationsStrict: mocks.createPostAuthorNotificationsStrict,
}));

vi.mock('../../services/EngagementOutboxService', () => ({
  dispatchEngagementOutbox: vi.fn(),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.loggerInfo,
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { postAuthorships } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import {
  EngagementOutboxDispatcher,
  handleEngagementOutboxEvent,
} from '../../services/EngagementOutboxDispatcher';
import {
  dispatchEngagementOutbox,
  type EngagementOutboxEvent,
} from '../../services/EngagementOutboxService';

let db: Database;
const createdPostIds: string[] = [];

/** A post with an owner and one accepted collaborator, both notification recipients. */
async function seedCollaborativePost(): Promise<string> {
  const [post] = await db
    .insert(posts)
    .values({ oxyUserId: 'owner-1' })
    .returning({ id: posts.id });
  if (!post) throw new Error('Failed to seed a post');
  createdPostIds.push(post.id);
  await db.insert(postAuthorships).values([
    { postId: post.id, oxyUserId: 'owner-1', role: 'owner', status: 'accepted' },
    {
      postId: post.id,
      oxyUserId: 'collaborator-1',
      role: 'collaborator',
      status: 'accepted',
      invitedAt: new Date('2026-07-26T10:00:00.000Z'),
      respondedAt: new Date('2026-07-26T10:05:00.000Z'),
    },
    { postId: post.id, oxyUserId: 'invitee-1', role: 'collaborator', status: 'pending' },
  ]);
  return post.id;
}

function event(
  kind: EngagementOutboxEvent['kind'],
  postId: string,
  overrides: Partial<EngagementOutboxEvent['payload']> = {},
): EngagementOutboxEvent {
  return {
    id: `engagement:${kind}:relation-1:v1`,
    kind,
    revision: 1,
    payload: {
      actorOxyUserId: 'actor-1',
      postId,
      relationshipId: 'relation-1',
      postOwnerOxyUserId: 'owner-1',
      federationActivityId: 'https://remote.example/post/1',
      ...overrides,
    },
    attempts: 1,
    availableAt: new Date(0),
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(0),
  };
}

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitLikeCreatedStrict.mockResolvedValue(undefined);
  mocks.emitTombstoneStrict.mockResolvedValue(undefined);
  mocks.emitBookmarkCreatedStrict.mockResolvedValue(undefined);
  mocks.federateAsResolvedActorAndWait.mockResolvedValue(undefined);
  mocks.createPostAuthorNotificationsStrict.mockResolvedValue(undefined);
  vi.mocked(dispatchEngagementOutbox).mockResolvedValue({ processed: 0, failed: 0 });
});

afterEach(async () => {
  if (createdPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, createdPostIds));
    createdPostIds.length = 0;
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('handleEngagementOutboxEvent', () => {
  it('delivers like MTN, notification and federation effects', async () => {
    const postId = await seedCollaborativePost();
    mocks.federateAsResolvedActorAndWait.mockImplementationOnce(
      async (_actorId, _description, buildEvent) => {
        expect(buildEvent('alice')).toEqual({
          kind: 'post.like',
          like: { _id: 'relation-1', postId },
          actorOxyUserId: 'actor-1',
          actorUsername: 'alice',
        });
      },
    );

    await handleEngagementOutboxEvent(event('post.like', postId));

    expect(mocks.emitLikeCreatedStrict).toHaveBeenCalledWith({
      likerOxyUserId: 'actor-1',
      likeRkey: 'relation-1',
      likedPostId: postId,
      likedPostOwnerOxyUserId: 'owner-1',
      idempotencyKey: 'engagement:post.like:relation-1:v1',
      issuedAt: new Date(0),
    });
    expect(mocks.federateAsResolvedActorAndWait).toHaveBeenCalledOnce();
  });

  it('reads the authorship from post_authorships rather than from the event', async () => {
    /**
     * The behaviour the dropped `payload.postAuthorship` column moved. The
     * notification fan-out sees the membership as it stands NOW: owner and
     * accepted collaborator, and an invitee who has not answered yet is not one
     * of them.
     */
    const postId = await seedCollaborativePost();

    await handleEngagementOutboxEvent(event('post.like', postId));

    expect(mocks.createPostAuthorNotificationsStrict).toHaveBeenCalledWith(
      [
        { oxyUserId: 'owner-1', role: 'owner', status: 'accepted' },
        {
          oxyUserId: 'collaborator-1',
          role: 'collaborator',
          status: 'accepted',
          invitedAt: '2026-07-26T10:00:00.000Z',
          respondedAt: '2026-07-26T10:05:00.000Z',
        },
        { oxyUserId: 'invitee-1', role: 'collaborator', status: 'pending' },
      ],
      {
        actorId: 'actor-1',
        type: 'like',
        entityId: postId,
        entityType: 'post',
      },
    );
  });

  it('sees a collaborator who accepted after the event was written', async () => {
    const postId = await seedCollaborativePost();
    await db
      .update(postAuthorships)
      .set({ status: 'accepted', respondedAt: new Date('2026-07-27T00:00:00.000Z') })
      .where(eq(postAuthorships.oxyUserId, 'invitee-1'));

    await handleEngagementOutboxEvent(event('post.like', postId));

    const [authorship] = vi.mocked(mocks.createPostAuthorNotificationsStrict).mock.calls[0] ?? [];
    expect(authorship).toContainEqual(
      expect.objectContaining({ oxyUserId: 'invitee-1', status: 'accepted' }),
    );
  });

  it('answers with an empty authorship for a post that has none', async () => {
    const [post] = await db.insert(posts).values({}).returning({ id: posts.id });
    if (!post) throw new Error('Failed to seed a post');
    createdPostIds.push(post.id);

    await handleEngagementOutboxEvent(event('post.like', post.id));

    expect(mocks.createPostAuthorNotificationsStrict).toHaveBeenCalledWith(
      [],
      expect.anything(),
    );
  });

  it('surfaces a durable federation queue failure so the event remains retryable', async () => {
    const postId = await seedCollaborativePost();
    mocks.federateAsResolvedActorAndWait.mockRejectedValueOnce(
      new Error('delivery queue unavailable'),
    );

    await expect(
      handleEngagementOutboxEvent(event('post.like', postId)),
    ).rejects.toThrow('delivery queue unavailable');
  });

  it('retracts the prior like when an upvote becomes a downvote', async () => {
    const postId = await seedCollaborativePost();

    await handleEngagementOutboxEvent(
      event('post.downvote', postId, { previousValue: 1, value: -1 }),
    );

    expect(mocks.emitTombstoneStrict).toHaveBeenCalledOnce();
    expect(mocks.federateAsResolvedActorAndWait).toHaveBeenCalledOnce();
    expect(mocks.emitLikeCreatedStrict).not.toHaveBeenCalled();
  });

  it('does not publish a new downvote to MTN or federation', async () => {
    const postId = await seedCollaborativePost();

    await handleEngagementOutboxEvent(
      event('post.downvote', postId, {
        previousValue: null,
        value: -1,
        federationActivityId: undefined,
      }),
    );

    expect(mocks.emitTombstoneStrict).not.toHaveBeenCalled();
    expect(mocks.federateAsResolvedActorAndWait).not.toHaveBeenCalled();
  });

  it('does not federate a local-only like without a federation activity id', async () => {
    const postId = await seedCollaborativePost();

    await handleEngagementOutboxEvent(
      event('post.like', postId, { federationActivityId: undefined }),
    );

    expect(mocks.emitLikeCreatedStrict).toHaveBeenCalledOnce();
    expect(mocks.createPostAuthorNotificationsStrict).toHaveBeenCalledOnce();
    expect(mocks.federateAsResolvedActorAndWait).not.toHaveBeenCalled();
  });

  it('delivers unlike tombstones and treats undownvote as a local no-op', async () => {
    const postId = await seedCollaborativePost();

    await handleEngagementOutboxEvent(event('post.unlike', postId));
    await handleEngagementOutboxEvent(event('post.undownvote', postId));

    expect(mocks.emitTombstoneStrict).toHaveBeenCalledOnce();
    expect(mocks.emitTombstoneStrict).toHaveBeenCalledWith(
      expect.objectContaining({ subjectUri: 'mtn://actor-1/likes/relation-1' }),
    );
    expect(mocks.federateAsResolvedActorAndWait).toHaveBeenCalledOnce();
  });

  it('persists save and unsave records under the relationship key', async () => {
    const postId = await seedCollaborativePost();

    await handleEngagementOutboxEvent(event('post.save', postId));
    await handleEngagementOutboxEvent(event('post.unsave', postId));

    expect(mocks.emitBookmarkCreatedStrict).toHaveBeenCalledWith({
      ownerOxyUserId: 'actor-1',
      bookmarkRkey: 'relation-1',
      bookmarkedPostId: postId,
      bookmarkedPostOwnerOxyUserId: 'owner-1',
      idempotencyKey: 'engagement:post.save:relation-1:v1',
      issuedAt: new Date(0),
    });
    expect(mocks.emitTombstoneStrict).toHaveBeenCalledWith({
      authorOxyUserId: 'actor-1',
      tombstoneRkey: 'relation-1',
      subjectUri: 'mtn://actor-1/bookmarks/relation-1',
      idempotencyKey: 'engagement:post.unsave:relation-1:v1',
      issuedAt: new Date(0),
    });
    // A save is nobody else's business: no notification, no federation.
    expect(mocks.createPostAuthorNotificationsStrict).not.toHaveBeenCalled();
    expect(mocks.federateAsResolvedActorAndWait).not.toHaveBeenCalled();
  });

  it('surfaces a downstream failure so the claim is retried', async () => {
    const postId = await seedCollaborativePost();
    mocks.emitLikeCreatedStrict.mockRejectedValueOnce(new Error('MTN unavailable'));

    await expect(handleEngagementOutboxEvent(event('post.like', postId))).rejects.toThrow(
      'MTN unavailable',
    );
    expect(mocks.createPostAuthorNotificationsStrict).not.toHaveBeenCalled();
  });
});

describe('EngagementOutboxDispatcher lifecycle', () => {
  it('contains a claim failure instead of creating an unhandled timer rejection', async () => {
    vi.mocked(dispatchEngagementOutbox).mockRejectedValueOnce(
      new Error('Postgres unavailable'),
    );
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    await dispatcher.stop();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[EngagementOutbox] dispatch tick failed',
      { error: 'Postgres unavailable' },
    );
  });

  it('waits for active work and refuses queued ticks after stop', async () => {
    let resolveDispatch!: (result: { processed: number; failed: number }) => void;
    const pending = new Promise<{ processed: number; failed: number }>((resolve) => {
      resolveDispatch = resolve;
    });
    vi.mocked(dispatchEngagementOutbox).mockReturnValueOnce(pending);
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    const signal = vi.mocked(dispatchEngagementOutbox).mock.calls[0]?.[0].signal;
    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(signal?.aborted).toBe(true);

    resolveDispatch({ processed: 0, failed: 0 });
    await stopping;
    await (dispatcher as unknown as { tick: () => Promise<void> }).tick();

    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when started twice and reports non-empty batches', async () => {
    vi.mocked(dispatchEngagementOutbox).mockResolvedValueOnce({
      processed: 2,
      failed: 1,
    });
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    dispatcher.start();
    await dispatcher.stop();

    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      '[EngagementOutbox] dispatch batch complete',
      { processed: 2, failed: 1 },
    );
  });

  it('can stop before start and stringifies a non-Error dispatch failure', async () => {
    const idle = new EngagementOutboxDispatcher();
    await expect(idle.stop()).resolves.toBeUndefined();

    vi.mocked(dispatchEngagementOutbox).mockRejectedValueOnce('offline');
    const dispatcher = new EngagementOutboxDispatcher();
    dispatcher.start();
    await dispatcher.stop();

    expect(mocks.loggerError).toHaveBeenCalledWith(
      '[EngagementOutbox] dispatch tick failed',
      { error: 'offline' },
    );
  });

  it('supports timer handles without an unref method', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      .mockReturnValue({} as ReturnType<typeof setInterval>);
    const dispatcher = new EngagementOutboxDispatcher();
    try {
      dispatcher.start();
      await dispatcher.stop();
    } finally {
      setIntervalSpy.mockRestore();
    }

    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
  });

  it('does not let an older stop or completion clear a restarted dispatcher', async () => {
    let resolveFirst!: (value: { processed: number; failed: number }) => void;
    const firstDispatch = new Promise<{ processed: number; failed: number }>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    vi.mocked(dispatchEngagementOutbox)
      .mockReturnValueOnce(firstDispatch)
      .mockResolvedValueOnce({ processed: 0, failed: 0 });
    const dispatcher = new EngagementOutboxDispatcher();

    dispatcher.start();
    const firstStop = dispatcher.stop();
    dispatcher.start();
    resolveFirst({ processed: 0, failed: 0 });
    await firstStop;
    await dispatcher.stop();

    // The restart reuses the still-active dispatch rather than overlapping it.
    expect(dispatchEngagementOutbox).toHaveBeenCalledTimes(1);
  });
});
