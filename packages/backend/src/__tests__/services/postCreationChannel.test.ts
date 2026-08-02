import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_NOTIFY_FANOUT_CAP } from '@mention/shared-types';

/**
 * `channelId` through `PostCreationService.create`, asserted on STORED ROWS.
 *
 * Three things change when a post is published to a channel, and all three live
 * in `create()` rather than in its callers so no future caller can route around
 * them: `replyPermission` is forced to `['nobody']`, the MTN dual-write is
 * skipped, and outbound federation is skipped. The last two are the consequential
 * ones — both would republish, under the WRITER's identity and signature, a post
 * the CHANNEL signs.
 *
 * The membership gate and the counters run against real `channels` /
 * `channel_members` / `channel_follows` rows. That matters here specifically:
 * `canPublishToChannel` carried an `ObjectId.isValid` short-circuit that answered
 * `false` for every uuid v7 channel id, so it refused every publish while looking
 * present — and a mocked `ChannelMember.exists` answers whatever it was told,
 * without the id ever reaching the check that was wrong.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { channelFollows, channelMembers, channels } from '../../db/schema/channels';
import { postSubscriptions } from '../../db/schema/engagement';
import {
  clearPostScope,
  postScope,
  readPostRow,
  seedChannel,
  track,
} from '../helpers/postFixtures';

const createBatchNotifications = vi.fn();
vi.mock('../../utils/notificationUtils', () => ({
  createMentionNotifications: vi.fn(async () => undefined),
  createBatchNotifications: (...args: unknown[]) => createBatchNotifications(...args),
  createPostAuthorNotifications: vi.fn(async () => undefined),
}));

const emitPostCreated = vi.fn();
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: (...args: unknown[]) => emitPostCreated(...args),
  emitRepostCreated: vi.fn(async () => undefined),
}));

const federateNewPost = vi.fn();
vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost }),
  registerPostCreator: vi.fn(),
  registerPostFederator: vi.fn(),
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn(async () => undefined),
}));
vi.mock('../../services/postEnrichment', () => ({ enrichIngestedPosts: vi.fn() }));
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(() => ({ getUserById: vi.fn(async () => ({ username: 'nate' })) })),
}));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: { enrichFromOxy: vi.fn(async (media: unknown[]) => media) },
  readPersistedMediaFields: vi.fn(() => ({})),
}));

const loggerWarn = vi.fn();
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), error: vi.fn() },
}));

import { postCreationService } from '../../services/PostCreationService';
import { ChannelAccessError } from '../../services/channelAccess';

const scope = postScope('post-creation-channel');
const USER_ID = scope.user('author');
const subscriberIds: string[] = [];

/** A channel this author is an ACCEPTED member of — the publish gate's subject. */
async function joinableChannel(): Promise<string> {
  const channelId = await seedChannel(scope, { ownerOxyUserId: USER_ID });
  await getDb()
    .insert(channelMembers)
    .values({ channelId, oxyUserId: USER_ID, role: 'owner', status: 'accepted' });
  return channelId;
}

/** Followers of `channelId`, in insertion order. */
async function follow(channelId: string, oxyUserIds: string[]): Promise<void> {
  if (oxyUserIds.length === 0) return;
  await getDb()
    .insert(channelFollows)
    .values(oxyUserIds.map((oxyUserId) => ({ channelId, oxyUserId })));
}

/** People subscribed to the AUTHOR, who get the post whatever channel it is in. */
async function subscribe(oxyUserIds: string[]): Promise<void> {
  if (oxyUserIds.length === 0) return;
  await getDb()
    .insert(postSubscriptions)
    .values(oxyUserIds.map((subscriberId) => ({ subscriberId, authorId: USER_ID })));
  subscriberIds.push(...oxyUserIds);
}

/** Create through the real service, tracking the row for teardown. */
async function create(params: Record<string, unknown>) {
  const post = await postCreationService.create({
    oxyUserId: USER_ID,
    content: { text: 'a post' },
    ...params,
  } as Parameters<typeof postCreationService.create>[0]);
  track(scope, post.id);
  return post;
}

/** The recipient ids of the ONE batch the notification stage emitted. */
function notifiedRecipients(): string[] {
  const [batch] = createBatchNotifications.mock.calls[0] ?? [];
  return ((batch ?? []) as Array<{ recipientId: string }>).map((n) => n.recipientId);
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  createBatchNotifications.mockReset();
  emitPostCreated.mockReset();
  federateNewPost.mockReset();
  loggerWarn.mockReset();
});

afterEach(async () => {
  await clearPostScope(scope);
  const subs = subscriberIds.splice(0);
  if (subs.length > 0) {
    await getDb()
      .delete(postSubscriptions)
      .where(
        and(inArray(postSubscriptions.subscriberId, subs), eq(postSubscriptions.authorId, USER_ID)),
      );
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('PostCreationService.create — channelId reaches the row', () => {
  it('writes the channel onto the post when one is supplied', async () => {
    const channelId = await joinableChannel();
    const post = await create({ content: { text: 'in the channel' }, channelId, skipNotifications: true });

    expect((await readPostRow(post.id))?.channelId).toBe(channelId);
  });

  it('stores NULL on an ordinary post, which the author exclusion depends on', async () => {
    const post = await create({ content: { text: 'ordinary' }, skipNotifications: true });

    // The exclusion in `authorFeedSql` is a flat `channel_id is null`, which is
    // TOTAL: it matches every post written before channels existed as well as
    // every ordinary one. Mongo had to forbid storing an explicit null, because
    // one satisfied `$exists` and would have dropped the post from its OWN
    // author's profile; here null IS "no channel", so the two cannot diverge.
    expect((await readPostRow(post.id))?.channelId).toBeNull();
  });

  it('forces replyPermission to ["nobody"] over whatever the caller asked for', async () => {
    const channelId = await joinableChannel();
    const post = await create({
      content: { text: 'in the channel' },
      channelId,
      replyPermission: ['anyone'],
      skipNotifications: true,
    });

    expect((await readPostRow(post.id))?.replyPermission).toEqual(['nobody']);
  });

  it('CONTROL: an ordinary post keeps the caller\'s replyPermission', async () => {
    const post = await create({
      content: { text: 'ordinary' },
      replyPermission: ['followers'],
      skipNotifications: true,
    });

    expect((await readPostRow(post.id))?.replyPermission).toEqual(['followers']);
  });

  it('bumps the channel postCount once the post is live', async () => {
    const channelId = await joinableChannel();
    await create({ content: { text: 'in the channel' }, channelId, skipNotifications: true });

    const [row] = await getDb()
      .select({ postCount: channels.postCount })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(row?.postCount).toBe(1);
  });
});

describe('PostCreationService.create — the membership gate runs before any write', () => {
  it('403s a non-member and writes nothing', async () => {
    // A real channel, with NO accepted membership for this author.
    const channelId = await seedChannel(scope, { ownerOxyUserId: scope.user('somebody-else') });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 403 });

    const [row] = await getDb()
      .select({ postCount: channels.postCount })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(row?.postCount).toBe(0);
  });

  it('403s a member whose invite is still PENDING', async () => {
    // The gate is an ACCEPTED row and nothing else — an invitee has a row too.
    const channelId = await seedChannel(scope, { ownerOxyUserId: scope.user('somebody-else') });
    await getDb()
      .insert(channelMembers)
      .values({ channelId, oxyUserId: USER_ID, role: 'publisher', status: 'pending' });

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('404s an unknown channel', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId: 'post-creation-channel-no-such-channel',
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['a reply', { parentPostId: 'p1' }],
    ['a boost', { boostOf: 'p1' }],
  ])('400s %s carrying a channelId, before touching the database', async (_label, extra) => {
    const channelId = await joinableChannel();
    const error = await postCreationService
      .create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId,
        skipNotifications: true,
        ...extra,
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ChannelAccessError);
    expect(error).toMatchObject({ status: 400 });
  });

  it('400s a FEDERATED post carrying a channelId — the ingest invariant', async () => {
    const channelId = await joinableChannel();
    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'from elsewhere' },
        channelId,
        federation: { activityId: 'https://remote.example/1', actorUri: 'https://remote.example/u' },
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('PostCreationService.create — a channel post emits no MTN record and does not federate', () => {
  it('skips both for a channel post', async () => {
    const channelId = await joinableChannel();
    await create({ content: { text: 'in the channel' }, channelId, senderUsername: 'nate' });

    expect(emitPostCreated).not.toHaveBeenCalled();
    expect(federateNewPost).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary post does both', async () => {
    await create({ content: { text: 'ordinary' }, senderUsername: 'nate' });

    expect(emitPostCreated).toHaveBeenCalledTimes(1);
    expect(federateNewPost).toHaveBeenCalledTimes(1);
  });
});

describe('PostCreationService — the ONE notification stage', () => {
  const followerId = (n: number) => `${scope.name}-follower-${n}`;

  it('unions channel followers with the author\'s subscribers into ONE batch', async () => {
    const channelId = await joinableChannel();
    await subscribe([`${scope.name}-sub-1`]);
    await follow(channelId, [followerId(0), followerId(1)]);

    await create({ content: { text: 'in the channel' }, channelId });

    expect(createBatchNotifications).toHaveBeenCalledTimes(1);
    expect(notifiedRecipients().sort()).toEqual(
      [followerId(0), followerId(1), `${scope.name}-sub-1`].sort(),
    );
  });

  it('DEDUPES a reader who both follows the channel and subscribes to the author', async () => {
    // This is the whole reason the two recipient sets are unioned before the
    // write rather than emitted by two concurrent stages: `createNotification` is
    // check-then-act, and the unique index's E11000 is swallowed by its own catch.
    const channelId = await joinableChannel();
    const both = `${scope.name}-both-1`;
    await subscribe([both]);
    await follow(channelId, [both]);

    await create({ content: { text: 'in the channel' }, channelId });

    expect(notifiedRecipients()).toEqual([both]);
  });

  it('emits type "post" — a new type would produce TWO rows for one post', async () => {
    const channelId = await joinableChannel();
    await follow(channelId, [followerId(0)]);

    await create({ content: { text: 'in the channel' }, channelId });

    const [batch] = createBatchNotifications.mock.calls[0];
    expect(batch).toEqual([
      expect.objectContaining({ type: 'post', entityType: 'post', actorId: USER_ID }),
    ]);
  });

  it('never notifies the writer, even when they follow their own channel', async () => {
    const channelId = await joinableChannel();
    await follow(channelId, [USER_ID]);

    await create({ content: { text: 'in the channel' }, channelId });

    expect(createBatchNotifications).not.toHaveBeenCalled();
  });

  it('truncates at the fan-out cap and LOGS it at warn', async () => {
    // A limit nobody can see is a limit that gets blamed on something else.
    const channelId = await joinableChannel();
    await follow(
      channelId,
      Array.from({ length: CHANNEL_NOTIFY_FANOUT_CAP + 10 }, (_u, i) => followerId(i)),
    );

    await create({ content: { text: 'in the channel' }, channelId });

    expect(notifiedRecipients()).toHaveLength(CHANNEL_NOTIFY_FANOUT_CAP);
    expect(loggerWarn).toHaveBeenCalledWith(
      'PostCreationService: channel notification fan-out truncated',
      expect.objectContaining({ cap: CHANNEL_NOTIFY_FANOUT_CAP }),
    );
  });

  it('CONTROL: an ordinary post still notifies its subscribers', async () => {
    await subscribe([`${scope.name}-sub-1`]);

    await create({ content: { text: 'ordinary' } });

    expect(notifiedRecipients()).toEqual([`${scope.name}-sub-1`]);
  });
});
