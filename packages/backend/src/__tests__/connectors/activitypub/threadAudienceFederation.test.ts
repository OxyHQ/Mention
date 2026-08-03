import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A cross-account thread's entries reach the OTHER participating accounts'
 * remote followers as well as the author's own
 * (`FollowService.federateNewPost`'s `extraAudienceOxyUserIds`).
 *
 * **What this buys is completeness, not reach.** Mastodon inserts a status into
 * home timelines from the STATUS AUTHOR's own followers on that instance, so
 * delivering B's entry to an instance because somebody there follows A does not
 * put it in that person's timeline — it makes the instance HOLD the whole
 * conversation, so opening the thread shows every part instead of a chain with
 * holes.
 *
 * The two follower sets are kept distinguishable throughout: the author's
 * followers and the extra account's followers live on different instances, so an
 * implementation that resolved the wrong account (or resolved one twice) reaches
 * a different set of inboxes rather than the same one by coincidence.
 */

const {
  enqueueDelivery,
  isFediverseSharingEnabled,
  getUserById,
  followFind,
  actorFind,
  actorFindOneLean,
  postFindByIdLean,
} = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getUserById: vi.fn(),
  followFind: vi.fn(),
  actorFind: vi.fn(),
  actorFindOneLean: vi.fn(),
  postFindByIdLean: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/constants')>(
    '../../../connectors/activitypub/constants',
  );
  return { ...actual, FEDERATION_ENABLED: true };
});
vi.mock('../../../connectors/activitypub/actor.service', () => ({ actorService: {} }));
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../queue/producers', () => ({ enqueueDelivery, enqueueInboxActivity: vi.fn() }));
vi.mock('../../../models/FederatedActor', () => ({
  default: {
    find: (query: Record<string, unknown>) => ({ lean: () => actorFind(query) }),
    findOne: () => ({ lean: () => actorFindOneLean() }),
  },
}));
vi.mock('../../../models/FederatedFollow', () => ({
  default: { find: (query: Record<string, unknown>) => ({ lean: () => followFind(query) }) },
}));
vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: { insertMany: vi.fn(), create: vi.fn() },
}));
vi.mock('../../../models/Post', () => ({
  Post: { findById: () => ({ select: () => ({ lean: () => postFindByIdLean() }) }) },
}));
vi.mock('../../../utils/safeUpstreamFetch', () => ({ fetchUpstreamSingleHop: vi.fn() }));
vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../utils/mediaResolver', () => ({
  resolveMediaRef: (ref: string) => ({ url: `https://cloud.oxy.so/${ref}` }),
}));
vi.mock('../../../services/fediverseSharing', () => ({ isFediverseSharingEnabled }));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: () => ({ getUserById }) }));

import { followService } from '../../../connectors/activitypub/follow.service';

const ALICE_FOLLOWER = 'https://alice-side.example/users/f1';
const ORG_FOLLOWER = 'https://org-side.example/users/f2';
const ALICE_INBOX = 'https://alice-side.example/inbox';
const ORG_INBOX = 'https://org-side.example/inbox';

/** A thread continuation exactly as the batch path hands it over. */
const ENTRY = {
  _id: 'entry2',
  parentPostId: 'entry1',
  content: { variants: [{ source: 'author' as const, text: 'the second voice', tag: 'en' }] },
  createdAt: '2024-05-06T07:08:09.000Z',
  visibility: 'public',
};

/** Every inbox `enqueueDelivery` was asked to deliver to, deduped by the engine. */
function deliveredInboxes(): string[] {
  return enqueueDelivery.mock.calls.map((c) => (c[0] as { targetInbox: string }).targetInbox);
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueDelivery.mockResolvedValue(true);
  isFediverseSharingEnabled.mockResolvedValue(true);
  actorFindOneLean.mockResolvedValue(null);
  postFindByIdLean.mockResolvedValue(null);
  getUserById.mockResolvedValue({ id: 'u', username: 'alice' });

  // The follow store answers per ACCOUNT: the sender is looked up by a bare id
  // (the delivery engine's own query) and the extra audiences by `$in` (the
  // resolver added for a cross-account thread). Keeping the two sets on
  // different instances is what makes a wrong lookup visible.
  followFind.mockImplementation(async (query: Record<string, unknown>) => {
    const requested = query.localUserId;
    const ids =
      typeof requested === 'string'
        ? [requested]
        : ((requested as { $in?: string[] })?.$in ?? []);
    const rows: Array<{ remoteActorUri: string }> = [];
    if (ids.includes('alice-oxy')) rows.push({ remoteActorUri: ALICE_FOLLOWER });
    if (ids.includes('org-oxy')) rows.push({ remoteActorUri: ORG_FOLLOWER });
    return rows;
  });

  actorFind.mockImplementation(async (query: Record<string, unknown>) => {
    const uris = (query.uri as { $in?: string[] })?.$in ?? [];
    return uris.map((uri) =>
      uri === ALICE_FOLLOWER ? { sharedInboxUrl: ALICE_INBOX } : { sharedInboxUrl: ORG_INBOX },
    );
  });
});

describe('federateNewPost — extra audiences', () => {
  it('delivers to the author\'s followers only when no audience is named', async () => {
    await followService.federateNewPost(ENTRY, 'alice-oxy', 'alice');

    expect(deliveredInboxes()).toEqual([ALICE_INBOX]);
  });

  it('adds the named account\'s followers to the author\'s own', async () => {
    await followService.federateNewPost(ENTRY, 'alice-oxy', 'alice', {
      extraAudienceOxyUserIds: ['org-oxy'],
    });

    expect(deliveredInboxes().sort()).toEqual([ALICE_INBOX, ORG_INBOX].sort());
  });

  it('delivers to a shared inbox once when both accounts are followed from it', async () => {
    // Both accounts' followers live on the SAME instance. The delivery engine
    // dedupes by inbox, so a duplicate here would be a real second POST of the
    // same activity to the same server.
    actorFind.mockImplementation(async () => [{ sharedInboxUrl: ALICE_INBOX }]);

    await followService.federateNewPost(ENTRY, 'alice-oxy', 'alice', {
      extraAudienceOxyUserIds: ['org-oxy'],
    });

    expect(deliveredInboxes()).toEqual([ALICE_INBOX]);
  });

  it('is unaffected by an empty audience list', async () => {
    await followService.federateNewPost(ENTRY, 'alice-oxy', 'alice', {
      extraAudienceOxyUserIds: [],
    });

    expect(deliveredInboxes()).toEqual([ALICE_INBOX]);
    // With nothing to resolve, the extra lookup must not be made at all.
    expect(followFind).toHaveBeenCalledTimes(1);
  });

  it('still delivers to the author\'s own followers when the audience lookup fails', async () => {
    // Fail-soft: the acting account's fan-out is the part that matters, so a
    // broken read of somebody else's followers must not take it down.
    followFind.mockImplementation(async (query: Record<string, unknown>) => {
      if (typeof query.localUserId !== 'string') throw new Error('follow store unavailable');
      return [{ remoteActorUri: ALICE_FOLLOWER }];
    });

    await followService.federateNewPost(ENTRY, 'alice-oxy', 'alice', {
      extraAudienceOxyUserIds: ['org-oxy'],
    });

    expect(deliveredInboxes()).toEqual([ALICE_INBOX]);
  });
});
