import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { like } from 'drizzle-orm';

/**
 * A community (an ActivityPub `Group`, FEP-1b12) relays its members' posts as
 * `Announce { Create { Page } }`. The inner `Create` is processed as its member's
 * own delivery — once it is verified — and never as a boost by the community.
 *
 * The REAL `PostCreationService` writes real rows; the network is the boundary.
 */

const h = vi.hoisted(() => ({
  creator: null as null | { create: (params: Record<string, unknown>) => Promise<unknown> },
  fetchUpstreamSingleHop: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: vi.fn(async () => ({ keyId: 'https://mention.earth/ap/users/instance#main-key' })),
  signViaOxy: vi.fn(async () => 'signature'),
  signRequest: vi.fn(async () => ({ Signature: 'signature' })),
}));
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  assertSafePublicUrl: vi.fn(async () => ({ ok: true, ip: '93.184.216.34', family: 4 })),
}));
vi.mock('../../../utils/safeUpstreamFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/safeUpstreamFetch')>()),
  fetchUpstreamSingleHop: h.fetchUpstreamSingleHop,
}));
vi.mock('../../../utils/oxyHelpers', () => ({ getServiceOxyClient: vi.fn() }));
vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => {
    if (!h.creator) throw new Error('PostCreator not registered');
    return h.creator;
  },
  getPostFederator: () => ({ federateNewPost: vi.fn() }),
  registerPostCreator: (instance: typeof h.creator) => {
    h.creator = instance;
  },
  registerPostFederator: vi.fn(),
}));
vi.mock('../../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
} from '../../helpers/federationFixtures';
import { withDeadlockRetry } from '../../helpers/serviceFixtures';
// Importing the service is what registers it with the (mocked) registry above.
import '../../../services/PostCreationService';
import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

const scope = federationScope('group-relay');
const COMMUNITY_URI = `${scope.origin}/c/technology`;
const MEMBER_URI = `${scope.origin}/u/alice`;
const COMMUNITY_OXY = scope.user('technology');
const MEMBER_OXY = scope.user('alice');
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
/** A known account on ANOTHER origin than the community's. */
const OUTSIDER_URI = `https://outsider.${scope.domain}/u/mallory`;

/** A member's post, as Lemmy relays it through its community. */
function relayedPage(actorUri: string, postId: string) {
  const origin = new URL(actorUri).origin;
  return {
    id: `${COMMUNITY_URI}/activities/announce/${postId}`,
    type: 'Announce',
    actor: COMMUNITY_URI,
    to: [PUBLIC],
    cc: [`${COMMUNITY_URI}/followers`],
    object: {
      id: `${origin}/activities/create/${postId}`,
      type: 'Create',
      actor: actorUri,
      to: [COMMUNITY_URI, PUBLIC],
      object: {
        id: `${origin}/post/${postId}`,
        type: 'Page',
        attributedTo: actorUri,
        name: 'A new open-source release',
        content: '<p>Release notes inside.</p>',
        attachment: [{ type: 'Link', href: 'https://example.org/release' }],
        audience: COMMUNITY_URI,
        language: { identifier: 'en', name: 'English' },
        to: [COMMUNITY_URI, PUBLIC],
        published: '2026-10-20T10:00:00Z',
      },
    },
  };
}

async function storedPosts() {
  return getDb()
    .select({
      oxyUserId: posts.oxyUserId,
      type: posts.type,
      boostOf: posts.boostOf,
      actorUri: posts.federationActorUri,
      communityOxyUserId: posts.communityOxyUserId,
      title: posts.contentTitle,
      linkUrl: posts.contentLinkUrl,
    })
    .from(posts)
    .where(like(posts.federationActivityId, `%${scope.domain}%`));
}

async function clearScopePosts(): Promise<void> {
  await withDeadlockRetry(() =>
    getDb()
      .delete(posts)
      .where(like(posts.federationActivityId, `%${scope.domain}%`)),
  );
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  await clearScopePosts();
  await clearFederationScope(scope);
  h.fetchUpstreamSingleHop.mockReset();
  await seedActor(scope, {
    username: 'technology',
    uri: COMMUNITY_URI,
    type: 'Group',
    oxyUserId: COMMUNITY_OXY,
  });
  await seedActor(scope, { username: 'alice', uri: MEMBER_URI, oxyUserId: MEMBER_OXY });
  await seedActor(scope, {
    username: 'mallory',
    uri: OUTSIDER_URI,
    domain: `outsider.${scope.domain}`,
    acct: `mallory@outsider.${scope.domain}`,
    oxyUserId: scope.user('mallory'),
  });
  // Someone here follows the COMMUNITY, not its member.
  await seedFollow(scope, {
    remoteActorUri: COMMUNITY_URI,
    direction: 'outbound',
    status: 'accepted',
  });
});

afterEach(async () => {
  await clearScopePosts();
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('a community relaying a member', () => {
  it("stores the inner Page as the member's post, with its title, link and community", async () => {
    await inboxProcessingService.processInboxActivity(relayedPage(MEMBER_URI, '1'), COMMUNITY_URI);

    expect(await storedPosts()).toEqual([
      {
        oxyUserId: MEMBER_OXY,
        type: 'text',
        boostOf: null,
        actorUri: MEMBER_URI,
        communityOxyUserId: COMMUNITY_OXY,
        title: 'A new open-source release',
        linkUrl: 'https://example.org/release',
      },
    ]);
    // Same origin as the community that signed the delivery: nothing to fetch.
    expect(h.fetchUpstreamSingleHop).not.toHaveBeenCalled();
  });

  it('refuses a relayed activity its own origin does not confirm', async () => {
    // An account of ANOTHER instance: the embedded copy is only the community's
    // claim about it, so the activity is fetched from its origin — which does
    // not have it.
    h.fetchUpstreamSingleHop.mockImplementation(async () => {
      const stream = new PassThrough();
      stream.end('{}');
      return { response: stream, status: 404, headers: {} };
    });
    const forged = relayedPage(OUTSIDER_URI, '2');

    await inboxProcessingService.processInboxActivity(forged, COMMUNITY_URI);

    expect(h.fetchUpstreamSingleHop).toHaveBeenCalledWith(forged.object.id, expect.anything());
    expect(await storedPosts()).toEqual([]);
  });
});
