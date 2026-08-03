import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { AccountMember } from '@oxyhq/core';

/**
 * What `PostCreationService.create` DOES with the account it was told to publish
 * as — as distinct from whether it was allowed to, which is
 * `publishAsAccount.test.ts`.
 *
 * The rule that is easy to get wrong, and was: **`replyPermission: ['nobody']` is
 * keyed on the author being a CHANNEL, not on the post having been published as
 * somebody else.** "No replies, ever" is a property of channels — a newspaper, not
 * a group chat. An organization is an ordinary account: `utils/channelReplyGate`
 * reads the author's kind and lets replies through for one, so forcing `['nobody']`
 * on its posts would leave the persisted field and the server's own rule
 * disagreeing, and would silently close every organization's comments with no
 * setting anywhere to reopen them.
 *
 * `postData` is an explicit WHITELIST, so each of these fields is written or not
 * written by one line and a mistake there is silent.
 */

const saved: Array<Record<string, unknown>> = [];
const constructedWith: Array<Record<string, unknown>> = [];
/**
 * Rows `assertContinuesOwnThread` reads back when a continuation is claimed.
 * Empty for every other test, which is also the honest answer there: no thread
 * exists, so no continuation can be verified against one.
 */
const threadRows: Array<{ _id: string; oxyUserId?: string; threadId?: string }> = [];

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
      find: vi.fn((filter: { _id?: { $in?: Array<string | null | undefined> } }) => {
        const wanted = new Set((filter?._id?.$in ?? []).map((id) => String(id)));
        const matched = threadRows.filter((row) => wanted.has(row._id));
        return { select: () => ({ lean: async () => matched }) };
      }),
      findById: vi.fn(() => ({ select: () => ({ lean: async () => null }) })),
    }),
    POST_CLASSIFICATION_PENDING: 'pending',
  };
});

vi.mock('../../models/Lane', () => ({
  Lane: { exists: vi.fn(async () => null) },
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn(async () => undefined),
}));
vi.mock('../../services/postEnrichment', () => ({ enrichIngestedPosts: vi.fn() }));
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn(async () => undefined),
  emitRepostCreated: vi.fn(async () => undefined),
}));

const resolveUserSummaries = vi.hoisted(() => vi.fn());
vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => []) },
  resolveUserSummaries,
}));

vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn(() => ({})) }));
vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));
vi.mock('../../services/MediaMetadataService', () => ({
  mediaMetadataService: { enrichFromOxy: vi.fn(async (media: unknown[]) => media) },
  readPersistedMediaFields: vi.fn(() => ({})),
}));

import { postCreationService } from '../../services/PostCreationService';
import { PublishAsAccessError } from '../../services/publishAsAccount';

const WRITER = 'writer-1';
const CHANNEL = 'channel-account-1';
const ORGANIZATION = 'org-account-1';
const SECOND_ORG = 'org-account-2';

const ACT_AS_PERMISSIONS = ['account:read', 'account:act_as', 'members:read'];
const NO_ACT_AS_PERMISSIONS = ['account:read', 'members:read'];

function memberRow(permissions: string[]): AccountMember {
  return {
    _id: 'member-row',
    accountId: 'account',
    memberUserId: WRITER,
    role: 'editor',
    permissions,
    inherit: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const memberReader = {
  listAccountMembers: vi.fn(async (accountId: string) =>
    // A channel member with NO act_as, so the channel cases also prove the
    // permission is not being demanded where it cannot exist.
    accountId === CHANNEL ? [memberRow(NO_ACT_AS_PERMISSIONS)] : [memberRow(ACT_AS_PERMISSIONS)],
  ),
};

beforeEach(() => {
  saved.length = 0;
  constructedWith.length = 0;
  threadRows.length = 0;
  memberReader.listAccountMembers.mockClear();
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const kinds: Record<string, string> = {
      [CHANNEL]: 'channel',
      [ORGANIZATION]: 'organization',
      [SECOND_ORG]: 'organization',
    };
    const map = new Map<string, { user: { id: string; kind?: string; name: object } }>();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id], name: {} } });
    }
    return map;
  });
});

describe('PostCreationService.create — publishing as another account', () => {
  it('authors the post as the CHANNEL and records the writer outside authorship', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the channel' },
      publishAsOxyUserId: CHANNEL,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const [doc] = constructedWith;
    expect(doc.oxyUserId).toBe(CHANNEL);
    expect(doc.writtenByOxyUserId).toBe(WRITER);
    expect(doc.authorship).toEqual([expect.objectContaining({ oxyUserId: CHANNEL, role: 'owner' })]);
  });

  it('authors the post as the ORGANIZATION the same way', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const [doc] = constructedWith;
    expect(doc.oxyUserId).toBe(ORGANIZATION);
    expect(doc.writtenByOxyUserId).toBe(WRITER);
    expect(doc.authorship).toEqual([
      expect.objectContaining({ oxyUserId: ORGANIZATION, role: 'owner' }),
    ]);
  });

  it('forces replyPermission ["nobody"] on a CHANNEL post, over whatever was asked for', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the channel' },
      publishAsOxyUserId: CHANNEL,
      replyPermission: ['anyone'],
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect(constructedWith[0].replyPermission).toEqual(['nobody']);
  });

  /**
   * The regression this suite exists for. Keyed on "published as somebody" rather
   * than on the author's kind, this comes back `['nobody']` — an organization that
   * can never be replied to, with no setting anywhere that reopens it, while
   * `channelReplyGate` happily admits the replies the client has stopped offering.
   */
  it('does NOT force ["nobody"] on an ORGANIZATION post — it is an ordinary post', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      replyPermission: ['anyone'],
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect(constructedWith[0].replyPermission).toEqual(['anyone']);
  });

  it('honours a NARROWER replyPermission on an organization post too', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      replyPermission: ['followers'],
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect(constructedWith[0].replyPermission).toEqual(['followers']);
  });

  it('defaults an organization post to ["anyone"], like any other post', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'from the org' },
      publishAsOxyUserId: ORGANIZATION,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect(constructedWith[0].replyPermission).toEqual(['anyone']);
  });

  it('CONTROL: an ordinary post is unaffected and records no writer', async () => {
    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'just me' },
      replyPermission: ['anyone'],
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const [doc] = constructedWith;
    expect(doc.oxyUserId).toBe(WRITER);
    expect(doc.replyPermission).toEqual(['anyone']);
    expect('writtenByOxyUserId' in doc).toBe(false);
  });

  it('refuses an account the caller may not act as, BEFORE writing anything', async () => {
    memberReader.listAccountMembers.mockResolvedValueOnce([memberRow(NO_ACT_AS_PERMISSIONS)]);

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'not mine to sign' },
        publishAsOxyUserId: ORGANIZATION,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toBeInstanceOf(PublishAsAccessError);

    expect(constructedWith).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('still refuses a reply, a boost and a federated ingest', async () => {
    for (const extra of [
      { parentPostId: 'parent-1' },
      { boostOf: 'original-1' },
      { federation: { activityId: 'https://remote/1' } },
    ]) {
      await expect(
        postCreationService.create({
          oxyUserId: WRITER,
          content: { text: 'x' },
          publishAsOxyUserId: ORGANIZATION,
          memberReader,
          skipNotifications: true,
          ...extra,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }

    expect(constructedWith).toHaveLength(0);
  });
});

/**
 * The narrow exception, at the layer that owns it.
 *
 * `continuesOwnThread` is a SERVICE parameter — `POST /posts` builds its params
 * from an explicit body whitelist and never names it, so no request can ask for
 * it (asserted separately in `postsControllerChannelReply.test.ts`). What these
 * pin is that the parameter grants nothing by itself: every case below sets it,
 * and only the genuine continuation is written.
 */
describe('PostCreationService.create — continuing the account\'s own thread', () => {
  const ROOT = new mongoose.Types.ObjectId().toString();
  const CONTINUATION = new mongoose.Types.ObjectId().toString();
  const SOMEBODY_ELSES = new mongoose.Types.ObjectId().toString();

  function channelThreadExists(): void {
    threadRows.push(
      { _id: ROOT, oxyUserId: CHANNEL, threadId: ROOT },
      { _id: CONTINUATION, oxyUserId: CHANNEL, threadId: ROOT },
      { _id: SOMEBODY_ELSES, oxyUserId: 'someone-else', threadId: SOMEBODY_ELSES },
    );
  }

  it('writes a continuation of the channel\'s own thread, authored by the channel', async () => {
    channelThreadExists();

    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'part two' },
      publishAsOxyUserId: CHANNEL,
      parentPostId: ROOT,
      threadId: ROOT,
      continuesOwnThread: true,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const [doc] = constructedWith;
    expect(doc.oxyUserId).toBe(CHANNEL);
    expect(doc.parentPostId).toBe(ROOT);
    expect(doc.writtenByOxyUserId).toBe(WRITER);
    // Still a channel post, so still unrepliable by anybody else — the exception
    // is about who may WRITE the continuation, never about who may answer it.
    expect(doc.replyPermission).toEqual(['nobody']);
  });

  it('writes a continuation deeper in the chain too', async () => {
    channelThreadExists();

    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'part three' },
      publishAsOxyUserId: CHANNEL,
      parentPostId: CONTINUATION,
      threadId: ROOT,
      continuesOwnThread: true,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    expect(constructedWith[0].oxyUserId).toBe(CHANNEL);
  });

  /**
   * MUTATION GUARD. The exception must be the VERIFIED continuation and nothing
   * else. Replace `assertContinuesOwnThread` with "the author may act for the
   * parent's account" — the wider rule that reads as the same thing — and this
   * passes, which is a channel's replies reopened to everybody who operates it.
   */
  it('MUTATION GUARD: refuses a claimed continuation of SOMEBODY ELSE\'S post', async () => {
    channelThreadExists();

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'not a continuation' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: SOMEBODY_ELSES,
        threadId: SOMEBODY_ELSES,
        continuesOwnThread: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it('MUTATION GUARD: refuses a continuation claimed for a thread that does not exist', async () => {
    // Nothing seeded — the claim names ids with no rows behind them, which is
    // what a fabricated claim looks like.
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'invented thread' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: ROOT,
        threadId: ROOT,
        continuesOwnThread: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
  });

  it('CONTROL: the flag changes nothing for a reply that does not carry an account', async () => {
    channelThreadExists();

    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'an ordinary reply' },
      parentPostId: SOMEBODY_ELSES,
      threadId: SOMEBODY_ELSES,
      continuesOwnThread: true,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // No account named ⇒ no publish-as gate, no continuation check, and the reply
    // is the writer's own exactly as before.
    expect(constructedWith[0].oxyUserId).toBe(WRITER);
  });

  it('CONTROL: WITHOUT the flag, a reply naming an account is still refused', async () => {
    channelThreadExists();

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'part two, but unmarked' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: ROOT,
        threadId: ROOT,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
  });
});

/**
 * The SECOND exception at the service layer — `answersOperatedAccount`.
 *
 * Same discipline as `continuesOwnThread` above: the parameter grants nothing.
 * Every case here sets it, and only the ones that survive
 * {@link assertAnswersOperatedAccount}'s verification are written. Without these
 * the whole wiring is untested — mutation-testing found the branch could be
 * deleted outright with the suite still green.
 */
describe('PostCreationService.create — one operated account answering another', () => {
  const ROOT = new mongoose.Types.ObjectId().toString();
  const CHANNEL_ROOT = new mongoose.Types.ObjectId().toString();

  it('writes an organization\'s answer to another organization\'s post', async () => {
    threadRows.push({ _id: ROOT, oxyUserId: ORGANIZATION, threadId: ROOT });

    await postCreationService.create({
      oxyUserId: WRITER,
      content: { text: 'B answers A' },
      publishAsOxyUserId: SECOND_ORG,
      parentPostId: ROOT,
      threadId: ROOT,
      answersOperatedAccount: true,
      memberReader,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    const [doc] = constructedWith;
    expect(doc.oxyUserId).toBe(SECOND_ORG);
    expect(doc.parentPostId).toBe(ROOT);
    // An organization's post is ordinary in every other respect — replies
    // included. Only a channel forces `['nobody']`.
    expect(doc.replyPermission).toEqual(['anyone']);
  });

  /**
   * MUTATION GUARD. The parent belongs to a CHANNEL, and the publisher is an
   * organization the caller may act for — so every condition except the channel
   * one is satisfied. Accepting `answersOperatedAccount` without running the
   * verification writes this post, and what it writes is a reply to a channel.
   */
  it('MUTATION GUARD: refuses an organization answering a CHANNEL\'s post', async () => {
    threadRows.push({ _id: CHANNEL_ROOT, oxyUserId: CHANNEL, threadId: CHANNEL_ROOT });

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'answering the channel' },
        publishAsOxyUserId: SECOND_ORG,
        parentPostId: CHANNEL_ROOT,
        threadId: CHANNEL_ROOT,
        answersOperatedAccount: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  /**
   * MUTATION GUARD, the other end. Here the parent is a fine organization and the
   * CHANNEL is doing the answering — refused by the publishing-account half of the
   * boundary, which a parent-only check would miss.
   */
  it('MUTATION GUARD: refuses a CHANNEL answering an organization\'s post', async () => {
    threadRows.push({ _id: ROOT, oxyUserId: ORGANIZATION, threadId: ROOT });

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'the channel answers' },
        publishAsOxyUserId: CHANNEL,
        parentPostId: ROOT,
        threadId: ROOT,
        answersOperatedAccount: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
  });

  it('refuses a claimed answer to a thread that does not exist', async () => {
    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'invented' },
        publishAsOxyUserId: SECOND_ORG,
        parentPostId: ROOT,
        threadId: ROOT,
        answersOperatedAccount: true,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
  });

  it('CONTROL: WITHOUT either flag, the same reply is refused', async () => {
    threadRows.push({ _id: ROOT, oxyUserId: ORGANIZATION, threadId: ROOT });

    await expect(
      postCreationService.create({
        oxyUserId: WRITER,
        content: { text: 'unmarked' },
        publishAsOxyUserId: SECOND_ORG,
        parentPostId: ROOT,
        threadId: ROOT,
        memberReader,
        skipNotifications: true,
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(constructedWith).toHaveLength(0);
  });
});

