import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { CHANNEL_NOTIFY_FANOUT_CAP } from '@mention/shared-types';

/**
 * `channelId` through `PostCreationService.create` — the write path, and the ONE
 * notification stage.
 *
 * `postData` is an explicit WHITELIST, not a spread of the params, so a field
 * that is not listed there vanishes with a 201 and no error anywhere.
 *
 * Four things a channel post does DIFFERENTLY, each of them a decision rather
 * than an accident, and each asserted with a control:
 *
 *  - it persists `replyPermission: ['nobody']` whatever the caller asked for —
 *    defence in depth, and it buys the client's existing reply-button suppression
 *    with no new UI;
 *  - it emits NO MTN record. The chain is per-author and author-signed, so a
 *    record would republish, under the writer's identity, the post the channel
 *    signs — and `PostMaterializer` would project it back onto that profile;
 *  - it does NOT federate. Channels have no ActivityPub surface, so an outbound
 *    `Create(Note)` could only say the AUTHOR wrote it;
 *  - its followers are UNIONED with the author's subscribers into ONE stage
 *    emitting `type: 'post'`, so a reader who is both gets exactly one row.
 */

const saved: Array<Record<string, unknown>> = [];
const constructedWith: Array<Record<string, unknown>> = [];

vi.mock('../../models/Post', () => {
  class FakePost {
    [key: string]: unknown;

    constructor(data: Record<string, unknown>) {
      constructedWith.push(data);
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
    }

    async save(): Promise<void> {
      saved.push(this as unknown as Record<string, unknown>);
    }

    toObject(): Record<string, unknown> {
      return { ...(this as unknown as Record<string, unknown>) };
    }
  }
  return {
    Post: Object.assign(FakePost, {
      find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })),
      findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    }),
    POST_CLASSIFICATION_PENDING: 'pending',
  };
});

vi.mock('../../models/Lane', () => ({
  Lane: { exists: vi.fn(async () => ({ _id: 'lane_1' })) },
}));

const channelFindById = vi.fn();
const channelUpdateOne = vi.fn();
vi.mock('../../models/Channel', () => ({
  Channel: {
    findById: (...args: unknown[]) => channelFindById(...args),
    updateOne: (...args: unknown[]) => channelUpdateOne(...args),
  },
}));

const memberExists = vi.fn();
vi.mock('../../models/ChannelMember', () => ({
  ChannelMember: { exists: (...args: unknown[]) => memberExists(...args) },
}));

let channelFollowers: Array<{ _id: mongoose.Types.ObjectId; oxyUserId: string }> = [];
const followFind = vi.fn();
vi.mock('../../models/ChannelFollow', () => ({
  default: { find: (...args: unknown[]) => followFind(...args) },
  ChannelFollow: { find: (...args: unknown[]) => followFind(...args) },
}));

let subscribers: Array<{ subscriberId: string }> = [];
vi.mock('../../models/PostSubscription', () => ({
  default: { find: vi.fn(() => ({ lean: async () => subscribers })) },
}));

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

const USER_ID = 'author-1';
const CHANNEL_ID = new mongoose.Types.ObjectId().toString();

/** The recipient ids of the ONE batch the notification stage emitted. */
function notifiedRecipients(): string[] {
  const [batch] = createBatchNotifications.mock.calls[0] ?? [];
  return ((batch ?? []) as Array<{ recipientId: string }>).map((n) => n.recipientId);
}

/** Keyset-page `ChannelFollow.find` over the fixture follower list. */
function stubFollowerPaging(): void {
  followFind.mockImplementation((filter: Record<string, unknown>) => {
    const after = (filter._id as { $gt?: mongoose.Types.ObjectId } | undefined)?.$gt;
    let rows = channelFollowers;
    if (after) {
      const index = rows.findIndex((row) => row._id.equals(after));
      rows = rows.slice(index + 1);
    }
    let taken = rows;
    const link = {
      sort: () => link,
      limit: (n: number) => {
        taken = rows.slice(0, n);
        return link;
      },
      select: () => link,
      lean: async () => taken,
    };
    return link;
  });
}

beforeEach(() => {
  saved.length = 0;
  constructedWith.length = 0;
  subscribers = [];
  channelFollowers = [];
  createBatchNotifications.mockReset();
  emitPostCreated.mockReset();
  federateNewPost.mockReset();
  channelFindById.mockReset().mockResolvedValue({ _id: CHANNEL_ID, ownerOxyUserId: USER_ID });
  channelUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  memberExists.mockReset().mockResolvedValue({ _id: 'm1' });
  followFind.mockReset();
  loggerWarn.mockReset();
  stubFollowerPaging();
});

describe('PostCreationService.create — channelId on the whitelist', () => {
  it('writes the channel onto the post when one is supplied', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
      skipNotifications: true,
    });

    expect(constructedWith[0].channelId).toBe(CHANNEL_ID);
  });

  it('omits the key entirely on an ordinary post — never a stored null', async () => {
    // A stored `null` would make every author-surface exclusion
    // (`{ channelId: { $exists: false } }`) drop the post from its OWN author's
    // profile. That is the failure this guards, not the partial index.
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'ordinary' },
      skipNotifications: true,
    });

    expect('channelId' in constructedWith[0]).toBe(false);
  });

  it('forces replyPermission to ["nobody"] over whatever the caller asked for', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
      replyPermission: ['anyone'],
      skipNotifications: true,
    });

    expect(constructedWith[0].replyPermission).toEqual(['nobody']);
  });

  it('CONTROL: an ordinary post keeps the caller\'s replyPermission', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'ordinary' },
      replyPermission: ['followers'],
      skipNotifications: true,
    });

    expect(constructedWith[0].replyPermission).toEqual(['followers']);
  });

  it('bumps the channel postCount once the post is live', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
      skipNotifications: true,
    });

    expect(channelUpdateOne).toHaveBeenCalledWith(
      { _id: CHANNEL_ID },
      { $inc: { postCount: 1 } },
    );
  });
});

describe('PostCreationService.create — the membership gate runs before any write', () => {
  it('403s a non-member and writes nothing', async () => {
    memberExists.mockResolvedValue(null);

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId: CHANNEL_ID,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 403 });

    expect(constructedWith).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('404s an unknown channel', async () => {
    channelFindById.mockResolvedValue(null);

    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId: CHANNEL_ID,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ['a reply', { parentPostId: 'p1' }],
    ['a boost', { boostOf: 'p1' }],
  ])('400s %s carrying a channelId, before touching the database', async (_label, extra) => {
    const error = await postCreationService
      .create({
        oxyUserId: USER_ID,
        content: { text: 'nope' },
        channelId: CHANNEL_ID,
        skipNotifications: true,
        ...extra,
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ChannelAccessError);
    expect(error).toMatchObject({ status: 400 });
    expect(channelFindById).not.toHaveBeenCalled();
  });

  it('400s a FEDERATED post carrying a channelId — the ingest invariant', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: USER_ID,
        content: { text: 'from elsewhere' },
        channelId: CHANNEL_ID,
        federation: { activityId: 'https://remote.example/1', actorUri: 'https://remote.example/u' },
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('PostCreationService.create — a channel post emits no MTN record and does not federate', () => {
  it('skips both for a channel post', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
      senderUsername: 'nate',
    });

    expect(emitPostCreated).not.toHaveBeenCalled();
    expect(federateNewPost).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary post does both', async () => {
    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'ordinary' },
      senderUsername: 'nate',
    });

    expect(emitPostCreated).toHaveBeenCalledTimes(1);
    expect(federateNewPost).toHaveBeenCalledTimes(1);
  });
});

describe('PostCreationService — the ONE notification stage', () => {
  const followerId = (n: number) => `follower-${n}`;

  function followers(count: number) {
    return Array.from({ length: count }, (_unused, i) => ({
      _id: new mongoose.Types.ObjectId(),
      oxyUserId: followerId(i),
    }));
  }

  it('unions channel followers with the author\'s subscribers into ONE batch', async () => {
    subscribers = [{ subscriberId: 'sub-1' }];
    channelFollowers = followers(2);

    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
    });

    expect(createBatchNotifications).toHaveBeenCalledTimes(1);
    expect(notifiedRecipients().sort()).toEqual(['follower-0', 'follower-1', 'sub-1']);
  });

  it('DEDUPES a reader who both follows the channel and subscribes to the author', async () => {
    // This is the whole reason the two recipient sets are unioned before the
    // write rather than emitted by two concurrent stages: `createNotification` is
    // check-then-act, and the unique index's E11000 is swallowed by its own catch.
    subscribers = [{ subscriberId: 'both-1' }];
    channelFollowers = [{ _id: new mongoose.Types.ObjectId(), oxyUserId: 'both-1' }];

    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
    });

    expect(notifiedRecipients()).toEqual(['both-1']);
  });

  it('emits type "post" — a new type would produce TWO rows for one post', async () => {
    channelFollowers = followers(1);

    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
    });

    const [batch] = createBatchNotifications.mock.calls[0];
    expect(batch).toEqual([
      expect.objectContaining({ type: 'post', entityType: 'post', actorId: USER_ID }),
    ]);
  });

  it('never notifies the writer, even when they follow their own channel', async () => {
    channelFollowers = [{ _id: new mongoose.Types.ObjectId(), oxyUserId: USER_ID }];

    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
    });

    expect(createBatchNotifications).not.toHaveBeenCalled();
  });

  it('truncates at the fan-out cap and LOGS it at warn', async () => {
    // A limit nobody can see is a limit that gets blamed on something else.
    channelFollowers = followers(CHANNEL_NOTIFY_FANOUT_CAP + 10);

    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'in the channel' },
      channelId: CHANNEL_ID,
    });

    expect(notifiedRecipients()).toHaveLength(CHANNEL_NOTIFY_FANOUT_CAP);
    expect(loggerWarn).toHaveBeenCalledWith(
      'PostCreationService: channel notification fan-out truncated',
      expect.objectContaining({ cap: CHANNEL_NOTIFY_FANOUT_CAP }),
    );
  });

  it('CONTROL: an ordinary post still notifies its subscribers and reads no followers', async () => {
    subscribers = [{ subscriberId: 'sub-1' }];

    await postCreationService.create({ oxyUserId: USER_ID, content: { text: 'ordinary' } });

    expect(notifiedRecipients()).toEqual(['sub-1']);
    expect(followFind).not.toHaveBeenCalled();
  });

  it('CONTROL: a REPLY notifies no subscribers at all', async () => {
    subscribers = [{ subscriberId: 'sub-1' }];

    await postCreationService.create({
      oxyUserId: USER_ID,
      content: { text: 'a reply' },
      parentPostId: 'p1',
    });

    expect(createBatchNotifications).not.toHaveBeenCalled();
  });
});
