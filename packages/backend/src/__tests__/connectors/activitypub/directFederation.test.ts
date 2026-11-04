vi.mock('../../../db/posts/postSafetyRepository', () => ({
  loadPostSafetyAssessments: async () => new Map(),
}));
import { adultSafetyFixture } from '../../helpers/adultSafety';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A private mention federates to its remote recipient and nobody else: a Note
 * addressed `to` the recipient alone (no public or followers collection, empty
 * `cc`), tagged as a Mention so Mastodon shows it as a private mention, queued
 * to the recipient's inbox only — through the delivery authorization that
 * refuses any other addressing. The author's followers are never contacted.
 */

const { enqueueDelivery, followFind } = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  followFind: vi.fn(),
}));

const BOB = 'https://remote.example/users/bob';
const BOB_INBOX = 'https://remote.example/inbox';
const DM = {
  id: 'dm1',
  oxyUserId: 'alice-oxy',
  authorship: [],
  visibility: 'direct',
  status: 'published',
  content: { variants: [{ source: 'author' as const, text: 'just us', tag: 'en' }] },
  createdAt: '2026-11-04T00:00:00.000Z',
};

vi.mock('../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/constants')>(
    '../../../connectors/activitypub/constants',
  );
  return { ...actual, FEDERATION_ENABLED: true };
});
vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: vi.fn(),
  signRequest: vi.fn(),
}));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery, enqueueInboxActivity: vi.fn() }));
vi.mock('../../../db/federation/actorRepository', () => ({
  findActorInboxesByUris: async () => [{ sharedInboxUrl: 'https://follower.example/inbox' }],
  findActorByUri: async () => null,
  findActorsByOxyUserIds: async () => [
    { oxyUserId: 'bob-oxy', uri: BOB, acct: 'bob@remote.example', inboxUrl: BOB_INBOX },
  ],
}));
vi.mock('../../../db/federation/followRepository', () => ({
  distinctRemoteActorUris: (filter: unknown) => followFind(filter),
  findFollow: async () => null,
  upsertOutboundPending: async () => undefined,
  deleteFollowById: async () => undefined,
}));
vi.mock('../../../db/federation/deliveryQueueRepository', () => ({
  insertDeliveries: vi.fn(),
  insertDelivery: vi.fn(),
}));
vi.mock('../../../db/posts/postRepository', () => ({
  loadPostRecord: async () => DM,
}));
vi.mock('../../../db/posts/postAudience', () => ({
  loadPostRecipients: async () => ['bob-oxy'],
}));
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  safeFetch: vi.fn(),
  assertSafePublicUrl: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: async () => true,
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ safety: adultSafetyFixture() }),
}));

import { followService } from '../../../connectors/activitypub/follow.service';

beforeEach(() => {
  vi.clearAllMocks();
  enqueueDelivery.mockResolvedValue(true);
  followFind.mockResolvedValue(['https://follower.example/users/f1']);
});

describe('federateNewPost — a private mention', () => {
  it('is addressed to and delivered to its recipient only', async () => {
    await followService.federateNewPost(DM, 'alice-oxy', 'alice');

    expect(followFind).not.toHaveBeenCalled();
    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    const job = enqueueDelivery.mock.calls[0][0] as {
      targetInbox: string;
      activityJson: Record<string, unknown>;
    };
    expect(job.targetInbox).toBe(BOB_INBOX);
    const note = job.activityJson.object as Record<string, unknown>;
    for (const addressed of [job.activityJson, note]) {
      expect(addressed.to).toEqual([BOB]);
      expect(addressed.cc).toEqual([]);
    }
    expect(note.tag).toEqual([{ type: 'Mention', href: BOB, name: '@bob@remote.example' }]);
  });
});
