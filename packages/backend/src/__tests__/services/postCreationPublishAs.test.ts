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
  memberReader.listAccountMembers.mockClear();
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const kinds: Record<string, string> = { [CHANNEL]: 'channel', [ORGANIZATION]: 'organization' };
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
