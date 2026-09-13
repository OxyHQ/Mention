import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
} from '../../__tests__/helpers/federationFixtures';

const scope = federationScope('hydration-orphan-bridgy');

const BRIDGED_OXY_ID = '6a38fbdd272930c46a785b20';

const { getOrFetchActor, getUsersByIds } = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
  getUsersByIds: vi.fn(),
}));

// PostHydrationService touches these at module load — stub them so importing the
// module never starts the server, hits the network, or opens Redis/Mongo.
vi.mock('../../runtime/oxyClient', () => ({
  getRuntimeOxyClient: () => ({
    getUserById: vi.fn(async () => ({})),
    getUserFollowing: vi.fn(async () => []),
    getUserFollowers: vi.fn(async () => []),
  }),
}));
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUsersByIds,
    getClarityDocuments: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => id,
  }),
}));
vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
}));

// Replace the ActivityPub actor service so importing PostHydrationService never
// loads its network/identity stack; any accidental read-triggered discovery fails assertions.
vi.mock('../../connectors/activitypub/actor.service', () => ({
  actorService: { getOrFetchActor: (...args: unknown[]) => getOrFetchActor(...args) },
  default: { getOrFetchActor: (...args: unknown[]) => getOrFetchActor(...args) },
}));

import { resolveOrphanFederatedAuthors } from '../../services/PostHydrationService';

const DID = 'did:plc:reu7q3altx5gsonhu5nxcfp6';
const OBJECT_URL = `https://bsky.brid.gy/convert/ap/at://${DID}/app.bsky.feed.post/3moysdeqo3c2r`;
const DERIVED_ACTOR_URI = `https://bsky.brid.gy/ap/${DID}`;
const POST_ID = '6a3c2de8002520aa8c254a7f';

describe('resolveOrphanFederatedAuthors — brid.gy derivation', () => {
  beforeAll(async () => {
    await connectPostgres();
  });

  beforeEach(async () => {
    await clearFederationScope(scope);
    getUsersByIds.mockReset();
    getUsersByIds.mockResolvedValue([]);
    getOrFetchActor.mockReset();
    getOrFetchActor.mockResolvedValue(null);
  });

  afterEach(async () => {
    await clearFederationScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  it.each([true, false])('uses only the source link to locate the Oxy profile (stored URI: %s)', async (stored) => {
    await seedActor(scope, {
      uri: DERIVED_ACTOR_URI, username: 'transport',
      acct: 'transport@bsky.brid.gy', domain: 'bsky.brid.gy',
      oxyUserId: BRIDGED_OXY_ID,
    });
    getUsersByIds.mockResolvedValue([{ id: BRIDGED_OXY_ID, username: 'alice.bsky.social',
      name: { displayName: 'Alice from Oxy' }, avatar: null, isFederated: true }]);
    const result = await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { actorUri: stored ? DERIVED_ACTOR_URI : undefined, activityId: OBJECT_URL, url: OBJECT_URL } },
    ]);
    expect(result.get(POST_ID)?.username).toBe('alice.bsky.social');
    expect(result.get(POST_ID)?.name.displayName).toBe('Alice from Oxy');
    expect(JSON.stringify(result.get(POST_ID))).not.toContain('brid.gy');
    expect(getOrFetchActor).not.toHaveBeenCalled();
  });

  it.each([true, false])('stays neutral with missing Oxy identity (source row exists: %s)', async (exists) => {
    if (exists) await seedActor(scope, {
      uri: DERIVED_ACTOR_URI, username: 'transport', acct: 'transport@bsky.brid.gy',
      domain: 'bsky.brid.gy', oxyUserId: BRIDGED_OXY_ID,
    });
    const user = (await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { url: OBJECT_URL } },
    ])).get(POST_ID);
    expect(user?.username).toBe('');
    expect(user?.name.displayName).toBe('Unknown user');
    expect(user?.instance).toBeUndefined();
    expect(user?.federation).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain('brid.gy');
    expect(getOrFetchActor).not.toHaveBeenCalled();
    if (!exists) expect(getUsersByIds).not.toHaveBeenCalled();
  });

  it('does not discover or derive a profile from an ordinary post URL', async () => {
    const user = (await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { url: 'https://mastodon.social/@alice/123' } },
    ])).get(POST_ID);
    expect(user?.username).toBe('');
    expect(user?.instance).toBeUndefined();
    expect(getOrFetchActor).not.toHaveBeenCalled();
    expect(getUsersByIds).not.toHaveBeenCalled();
  });
});
