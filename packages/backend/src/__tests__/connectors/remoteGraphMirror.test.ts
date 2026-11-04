import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like, or } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { likes } from '../../db/schema/engagement';
import { remoteActorRefs, remoteFollowEdges, remoteGraphCrawls } from '../../db/schema/federation';
import { upsertRemoteFollowEdges } from '../../db/federation/remoteGraphRepository';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedPost,
} from '../helpers/federationFixtures';

/**
 * The remote follow-graph mirror and the Bluesky engagement import, against real
 * rows: one test per behaviour. The network (XRPC, signed ActivityPub GETs) and
 * Oxy (its follow lists, user summaries, the viewer's blocks) are mocked.
 */

const scope = federationScope('remote-graph-mirror');

const mocks = vi.hoisted(() => ({
  xrpcGet: vi.fn(),
  fetchAp: vi.fn(),
  excluded: new Set<string>(),
}));

vi.mock('../../connectors/atproto/xrpcClient', () => ({ xrpcGet: mocks.xrpcGet }));
vi.mock('../../connectors/activitypub/helpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchActivityPubObjectAs: mocks.fetchAp,
}));
vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServiceOxyClient: () => ({
    follows: {
      followers: async () => ({ followers: [], total: 0, hasMore: false }),
      following: async () => ({ following: [], total: 0, hasMore: false }),
    },
  }),
}));
vi.mock('../../services/PostHydrationService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveUserSummaries: async (ids: string[]) =>
    new Map(ids.map((id) => [id, { user: { id, username: `${id}@example.test`, name: {} } }])),
}));
vi.mock('../../mtn/UserPrivacyManager', () => ({
  UserPrivacyManager: {
    loadPrivacyState: async () => ({ excludedUserIds: mocks.excluded }),
  },
}));

import { crawlRemoteGraph, syncRemoteGraphMirror } from '../../connectors/remoteGraphMirror';
import { importAtprotoEngagement } from '../../connectors/atproto/engagementImport';
import { loadProfileConnections } from '../../services/federation/remoteConnections';

const ALICE = 'did:plc:remotegraphalice';
const BOB = 'did:plc:remotegraphbob';
const CAROL = 'did:plc:remotegraphcarol';
const DIDS = [ALICE, BOB, CAROL];

async function seedBlueskyAccount(did: string, name: string) {
  return seedActor(scope, {
    protocol: 'atproto',
    uri: did,
    username: name,
    oxyUserId: scope.user(name),
    inboxUrl: null,
    outboxUrl: null,
  });
}

/** Alice's AppView graph: she follows Bob and Carol. */
function serveAliceFollows() {
  mocks.xrpcGet.mockImplementation(async (_host: string, nsid: string) =>
    nsid === 'app.bsky.graph.getFollows' ? { follows: [{ did: BOB }, { did: CAROL }] } : {},
  );
}

async function listed(profile: string, kind: 'followers' | 'following', viewerId?: string) {
  const page = await loadProfileConnections({ profileUserId: profile, kind, viewerId, limit: 50 });
  return page.users.map((user) => user.id);
}

describe('remote follow-graph mirror', () => {
  it('lists an edge stored between two known accounts', async () => {
    await seedBlueskyAccount(ALICE, 'alice');
    await seedBlueskyAccount(BOB, 'bob');
    serveAliceFollows();

    await crawlRemoteGraph({ uri: ALICE, protocol: 'atproto' });

    expect(await listed(scope.user('alice'), 'following')).toEqual([scope.user('bob')]);
    expect(await listed(scope.user('bob'), 'followers')).toEqual([scope.user('alice')]);
  });

  it('lists the other end once it is synced later, with no re-crawl', async () => {
    await seedBlueskyAccount(ALICE, 'alice');
    serveAliceFollows();
    await crawlRemoteGraph({ uri: ALICE, protocol: 'atproto' });
    expect(await listed(scope.user('alice'), 'following')).toEqual([]);

    await seedBlueskyAccount(CAROL, 'carol');

    expect(await listed(scope.user('alice'), 'following')).toEqual([scope.user('carol')]);
  });

  it('never renders a hidden ActivityPub collection', async () => {
    const dana = await seedActor(scope, {
      username: 'dana',
      oxyUserId: scope.user('dana'),
      followingUrl: `${scope.origin}/users/dana/following`,
      followersUrl: `${scope.origin}/users/dana/followers`,
      followersCount: 1,
    });
    const erin = await seedActor(scope, { username: 'erin', oxyUserId: scope.user('erin') });
    // Mastodon's "hide your network": the totals stay, the items do not.
    mocks.fetchAp.mockResolvedValue({
      kind: 'object',
      object: { type: 'OrderedCollection', totalItems: 1 },
    });
    // Stored before the crawl learned the collection is hidden.
    await upsertRemoteFollowEdges([{ sourceUri: dana.uri, targetUri: erin.uri }], new Date());

    await crawlRemoteGraph({ ...dana, followersCount: 1 });
    expect(await edgeCount()).toBe(0);

    // Erin's own PUBLIC following names Dana; Dana's hidden followers still list nobody.
    await upsertRemoteFollowEdges([{ sourceUri: erin.uri, targetUri: dana.uri }], new Date());
    expect(await listed(scope.user('dana'), 'followers')).toEqual([]);
  });

  it('removes the accounts the viewer blocked or muted', async () => {
    await seedBlueskyAccount(ALICE, 'alice');
    await seedBlueskyAccount(BOB, 'bob');
    await seedBlueskyAccount(CAROL, 'carol');
    serveAliceFollows();
    await crawlRemoteGraph({ uri: ALICE, protocol: 'atproto' });
    mocks.excluded.add(scope.user('bob'));

    expect(await listed(scope.user('alice'), 'following', scope.user('viewer'))).toEqual([
      scope.user('carol'),
    ]);
  });
});

describe('remote follow-graph bounds', () => {
  it('expires an edge whose end stayed unknown, and keeps one between known accounts', async () => {
    await seedBlueskyAccount(ALICE, 'alice');
    await seedBlueskyAccount(BOB, 'bob');
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await upsertRemoteFollowEdges(
      [
        { sourceUri: ALICE, targetUri: BOB },
        { sourceUri: ALICE, targetUri: CAROL },
      ],
      longAgo,
    );

    const { expired } = await syncRemoteGraphMirror();

    expect(expired).toBe(1);
    expect(await listed(scope.user('alice'), 'following')).toEqual([scope.user('bob')]);
    // Carol's node went with the last edge that used it.
    const refs = await getDb()
      .select({ uri: remoteActorRefs.uri })
      .from(remoteActorRefs)
      .where(inArray(remoteActorRefs.uri, DIDS));
    expect(refs.map((ref) => ref.uri).sort()).toEqual([ALICE, BOB].sort());
  });

  it('stores a Bridgy Fed actor as its DID, so one person is one node', async () => {
    // Bob is known here only through his Bridgy Fed actor.
    await seedBlueskyAccount(ALICE, 'alice');
    await seedActor(scope, {
      uri: `https://bsky.brid.gy/ap/${BOB}`,
      username: 'bob',
      domain: 'bsky.brid.gy',
      oxyUserId: scope.user('bob'),
    });
    const frank = await seedActor(scope, {
      username: 'frank',
      oxyUserId: scope.user('frank'),
      followingUrl: `${scope.origin}/users/frank/following`,
    });
    serveAliceFollows();
    mocks.fetchAp.mockResolvedValue({
      kind: 'object',
      object: { type: 'OrderedCollection', orderedItems: [`https://bsky.brid.gy/ap/${BOB}`] },
    });

    await crawlRemoteGraph({ uri: ALICE, protocol: 'atproto' });
    await crawlRemoteGraph({ ...frank, followersCount: undefined });

    // Alice named Bob by DID, Frank by his bridge URI: one node, one follower list.
    const nodes = await getDb()
      .select({ uri: remoteActorRefs.uri })
      .from(remoteActorRefs)
      .where(like(remoteActorRefs.uri, `%${BOB}`));
    expect(nodes).toEqual([{ uri: BOB }]);
    expect((await listed(scope.user('bob'), 'followers')).sort()).toEqual(
      [scope.user('alice'), scope.user('frank')].sort(),
    );
  });
});

describe('Bluesky engagement import', () => {
  it('materializes a like only from an account known here', async () => {
    const author = await seedBlueskyAccount(ALICE, 'alice');
    await seedBlueskyAccount(BOB, 'bob');
    const postUri = `at://${ALICE}/app.bsky.feed.post/3kremotegraph`;
    const post = await seedPost(scope, {
      oxyUserId: author.oxyUserId,
      authorship: [{ oxyUserId: author.oxyUserId as string, role: 'owner', status: 'accepted' }],
      federation: { activityId: postUri },
    });
    mocks.xrpcGet.mockImplementation(async (_host: string, nsid: string) =>
      nsid === 'app.bsky.feed.getLikes'
        ? { likes: [{ actor: { did: BOB } }, { actor: { did: CAROL } }] }
        : {},
    );

    await importAtprotoEngagement(post.id, postUri);

    const rows = await getDb()
      .select({ userId: likes.userId })
      .from(likes)
      .where(eq(likes.postId, post.id));
    expect(rows).toEqual([{ userId: scope.user('bob') }]);
  });
});

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  mocks.xrpcGet.mockReset();
  mocks.fetchAp.mockReset();
  mocks.excluded.clear();
});

/** Edges among this suite's nodes. */
async function edgeCount(): Promise<number> {
  const rows = await getDb()
    .select({ id: remoteActorRefs.id })
    .from(remoteFollowEdges)
    .innerJoin(remoteActorRefs, eq(remoteActorRefs.id, remoteFollowEdges.sourceId))
    .where(or(inArray(remoteActorRefs.uri, DIDS), like(remoteActorRefs.uri, `${scope.origin}%`)));
  return rows.length;
}

afterEach(async () => {
  const db = getDb();
  // Deleting the suite's nodes cascades to every edge that names them.
  await db
    .delete(remoteActorRefs)
    .where(or(inArray(remoteActorRefs.uri, DIDS), like(remoteActorRefs.uri, `${scope.origin}%`)));
  await db
    .delete(remoteGraphCrawls)
    .where(
      or(
        inArray(remoteGraphCrawls.actorUri, DIDS),
        like(remoteGraphCrawls.actorUri, `${scope.origin}%`),
      ),
    );
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});
