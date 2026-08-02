import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
} from '../../__tests__/helpers/federationFixtures';

const scope = federationScope('hydration-orphan-bridgy');

/**
 * This file's own bridged author.
 *
 * `resolveUserSummaries` / `resolveOrphanFederatedAuthors` look an actor up by
 * `oxy_user_id`, and suites share one database and run in parallel — so this
 * literal must not be one another file also seeds. It was:
 * `postHydrationFederatedRepair.test.ts` seeded a DIFFERENT actor (another
 * handle, another instance) under the same id, and whichever row the lookup
 * reached first won. That file failed roughly one run in three on its handle
 * and instance assertions, and passed in isolation every time.
 *
 * ObjectId-shaped on purpose: these are pre-cutover author ids, and the shape is
 * what the surrounding fixtures represent.
 */
const BRIDGED_OXY_ID = '6a38fbdd272930c46a785b20';

/**
 * Legacy brid.gy/Bluesky "orphan" federated posts carry no `oxyUserId` AND no
 * `federation.actorUri` — only the wrapped AP object URL
 * (`https://bsky.brid.gy/convert/ap/at://<did>/app.bsky.feed.post/<rkey>`). Their
 * author previously degraded to "Unknown user" because the FederatedActor lookup
 * keyed on the missing `actorUri`. `resolveOrphanFederatedAuthors` now DERIVES the
 * deterministic Bridgy Fed actor URI (`https://bsky.brid.gy/ap/<did>`) from the
 * object URL and (a) resolves the real handle when the actor is already synced, or
 * (b) fires a fail-soft, non-blocking on-demand actor sync and degrades with the
 * bridge origin this pass so the DTO self-heals on the next load.
 */

const { getOrFetchActor } = vi.hoisted(() => ({
  getOrFetchActor: vi.fn(),
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
    getUsersByIds: vi.fn(async () => []),
    getLinkPreviews: vi.fn(async () => ({})),
    getFileDownloadUrl: (id: string) => id,
  }),
}));
vi.mock('../../utils/privacyHelpers', () => ({
  getBlockedUserIds: vi.fn(async () => []),
  getRestrictedUserIds: vi.fn(async () => []),
  extractFollowingIds: vi.fn(() => []),
  extractFollowersIds: vi.fn(() => []),
}));

function chainable(rows: unknown[]) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.lean = async () => rows;
  return q;
}

vi.mock('../../models/Post', () => ({ Post: { find: () => chainable([]), findOne: () => chainable([]) } }));
vi.mock('../../models/Poll', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Like', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/Bookmark', () => ({ default: { find: () => chainable([]) } }));
vi.mock('../../models/StarterPack', () => ({
  StarterPack: { aggregate: async () => [] },
  default: { aggregate: async () => [] },
}));
vi.mock('../../services/userSummaryCache', () => ({
  mget: vi.fn(async () => new Map()),
  mset: vi.fn(async () => undefined),
  invalidate: vi.fn(async () => undefined),
}));

// Replace the ActivityPub actor service so importing PostHydrationService never
// loads its network/identity stack, and so the lazy on-demand sync is observable.
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
    getOrFetchActor.mockReset();
    getOrFetchActor.mockResolvedValue(null);
  });

  afterEach(async () => {
    await clearFederationScope(scope);
  });

  afterAll(async () => {
    await closePostgres();
  });

  it('resolves the real author from the DERIVED actor URI when the actor is already synced', async () => {
    await seedActor(scope, {
      uri: DERIVED_ACTOR_URI,
      username: 'americanfietser.bsky.social',
      acct: 'americanfietser.bsky.social@bsky.brid.gy',
      domain: 'bsky.brid.gy',
      avatarUrl: 'https://bsky.brid.gy/a.png',
      oxyUserId: BRIDGED_OXY_ID,
    });

    const result = await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { activityId: OBJECT_URL, url: OBJECT_URL } },
    ]);
    const user = result.get(POST_ID);

    // The row is found under the DERIVED actor URI — the whole point of the
    // derivation, and something a `toHaveBeenCalledWith` could claim without a
    // row existing at that URI at all.
    expect(user?.username).toBe('americanfietser.bsky.social');
    expect(user?.isFederated).toBe(true);
    expect(user?.instance).toBe('bsky.brid.gy');
    expect(user?.federation?.domain).toBe('bsky.brid.gy');
    expect(user?.avatar).toBe('https://bsky.brid.gy/a.png');
    // Never invent a display name — the FederatedActor has none.
    expect(user?.name.displayName).toBeUndefined();
    // The actor already exists → no on-demand sync.
    expect(getOrFetchActor).not.toHaveBeenCalled();
  });

  it('degrades with the bridge origin AND fires a fail-soft on-demand sync when the actor is not yet synced', async () => {
    // No actor row at all for the derived URI.
    const result = await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { url: OBJECT_URL } },
    ]);
    const user = result.get(POST_ID);

    // Degraded this pass, but marked federated with the bridge origin so the
    // content renders and no fabricated handle is emitted.
    expect(user?.username).toBe('');
    expect(user?.name.displayName).toBe('Unknown user');
    expect(user?.isFederated).toBe(true);
    expect(user?.instance).toBe('bsky.brid.gy');
    // The DERIVED actor URI is synced off the request path so it self-heals.
    expect(getOrFetchActor).toHaveBeenCalledTimes(1);
    expect(getOrFetchActor).toHaveBeenCalledWith(DERIVED_ACTOR_URI);
  });

  it('does NOT sync — and stays degraded — for a truly underivable orphan', async () => {
    const result = await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { url: 'https://mastodon.online/@alice/12345' } },
    ]);
    const user = result.get(POST_ID);

    expect(user?.username).toBe('');
    expect(user?.name.displayName).toBe('Unknown user');
    expect(user?.instance).toBe('mastodon.online');
    // Non-brid.gy, no derivable DID → no on-demand sync.
    expect(getOrFetchActor).not.toHaveBeenCalled();
  });

  it('leaves the actorUri-present path unchanged (no derivation, no sync)', async () => {
    const STORED_URI = 'https://mastodon.online/users/alice';
    await seedActor(scope, {
      uri: STORED_URI,
      username: 'alice',
      acct: 'alice@mastodon.online',
      domain: 'mastodon.online',
      avatarUrl: null,
      oxyUserId: 'oxy-alice',
    });

    const result = await resolveOrphanFederatedAuthors([
      { postId: POST_ID, federation: { actorUri: STORED_URI, url: 'https://mastodon.online/@alice/1' } },
    ]);
    const user = result.get(POST_ID);

    expect(user?.username).toBe('alice');
    expect(user?.instance).toBe('mastodon.online');
    expect(getOrFetchActor).not.toHaveBeenCalled();
  });
});
