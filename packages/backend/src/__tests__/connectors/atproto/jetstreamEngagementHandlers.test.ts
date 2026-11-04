import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostType } from '@mention/shared-types';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * The Jetstream like, repost and follow handlers against real rows, one test
 * each: a known account's record is applied and its delete undone; a
 * stranger's is ignored; a follow is mirrored only from a crawled account to a
 * known one.
 */

// The post creator is registered at boot; a boost here stores a real row.
vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({
    create: (params: {
      oxyUserId: string;
      boostOf: string;
      federation: { activityId: string; actorUri: string };
    }) =>
      seedPost(scope, {
        oxyUserId: params.oxyUserId,
        type: PostType.BOOST,
        boostOf: params.boostOf,
        federation: params.federation,
      }),
  }),
  registerPostCreator: vi.fn(),
  registerPostFederator: vi.fn(),
  getPostFederator: vi.fn(),
}));

import {
  createFollowJetstreamHandler,
  createKnownBlueskyAccounts,
  createLikeJetstreamHandler,
  createRepostJetstreamHandler,
} from '../../../connectors/atproto/jetstream/engagementHandlers';
import type { JetstreamCommit } from '../../../connectors/atproto/jetstream/protocol';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { likes } from '../../../db/schema/engagement';
import {
  remoteActorRefs,
  remoteFollowEdges,
  remoteGraphCrawls,
} from '../../../db/schema/federation';
import { posts } from '../../../db/schema/posts';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedPost,
} from '../../helpers/federationFixtures';

const scope = federationScope('jetstream-engagement');
const ALICE = 'did:plc:jetstreamengagementalice0';
const BOB = 'did:plc:jetstreamengagementbob000';
const STRANGER = 'did:plc:jetstreamengagementnobody';
const DIDS = [ALICE, BOB, STRANGER];
const POST_URI = `at://${BOB}/app.bsky.feed.post/original`;

function commit(
  did: string,
  collection: string,
  operation: 'create' | 'delete',
  rkey: string,
  record?: unknown,
): JetstreamCommit {
  return {
    did,
    collection,
    rkey,
    operation,
    record,
    uri: `at://${did}/${collection}/${rkey}`,
    cursor: 1,
  };
}

async function seedAccounts() {
  for (const [did, name] of [
    [ALICE, 'alice'],
    [BOB, 'bob'],
  ]) {
    await seedActor(scope, {
      protocol: 'atproto',
      uri: did,
      username: name,
      oxyUserId: scope.user(name),
      inboxUrl: null,
      outboxUrl: null,
    });
  }
  return seedPost(scope, {
    oxyUserId: scope.user('bob'),
    federation: { activityId: POST_URI, actorUri: BOB },
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  const db = getDb();
  await db.delete(posts).where(eq(posts.federationActorUri, ALICE));
  await db.delete(remoteActorRefs).where(inArray(remoteActorRefs.uri, DIDS));
  await db.delete(remoteGraphCrawls).where(inArray(remoteGraphCrawls.actorUri, DIDS));
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('Jetstream engagement handlers', () => {
  it('materializes a known account’s like and removes it on unlike', async () => {
    const post = await seedAccounts();
    const handler = createLikeJetstreamHandler(createKnownBlueskyAccounts());
    const subject = { subject: { uri: POST_URI, cid: 'bafy' } };
    const likeRows = () =>
      getDb()
        .select({ id: likes.id, userId: likes.userId })
        .from(likes)
        .where(eq(likes.postId, post.id));

    await handler.handle([
      commit(ALICE, 'app.bsky.feed.like', 'create', 'l1', subject),
      commit(STRANGER, 'app.bsky.feed.like', 'create', 'l2', subject),
    ]);
    expect(await likeRows()).toEqual([
      { id: `at://${ALICE}/app.bsky.feed.like/l1`, userId: scope.user('alice') },
    ]);

    await handler.handle([commit(ALICE, 'app.bsky.feed.like', 'delete', 'l1')]);
    expect(await likeRows()).toEqual([]);
  });

  it('boosts a known account’s repost under its AT-URI and deletes it on unrepost', async () => {
    const post = await seedAccounts();
    const handler = createRepostJetstreamHandler(createKnownBlueskyAccounts());
    const repost = commit(ALICE, 'app.bsky.feed.repost', 'create', 'r1', {
      subject: { uri: POST_URI, cid: 'bafy' },
    });
    const boosts = () =>
      getDb()
        .select({ activityId: posts.federationActivityId })
        .from(posts)
        .where(and(eq(posts.boostOf, post.id), eq(posts.oxyUserId, scope.user('alice'))));

    await handler.handle([repost]);
    expect(await boosts()).toEqual([{ activityId: repost.uri }]);

    await handler.handle([commit(ALICE, 'app.bsky.feed.repost', 'delete', 'r1')]);
    expect(await boosts()).toEqual([]);
  });

  it('mirrors a follow from a crawled account to a known one, and unmirrors it', async () => {
    await seedAccounts();
    await getDb().insert(remoteGraphCrawls).values({ actorUri: ALICE, followingState: 'visible' });
    const handler = createFollowJetstreamHandler(createKnownBlueskyAccounts());
    const edges = () =>
      getDb()
        .select({ recordKey: remoteFollowEdges.recordKey })
        .from(remoteFollowEdges)
        .innerJoin(remoteActorRefs, eq(remoteActorRefs.id, remoteFollowEdges.sourceId))
        .where(inArray(remoteActorRefs.uri, DIDS));

    await handler.handle([
      commit(ALICE, 'app.bsky.graph.follow', 'create', 'f1', { subject: BOB }),
      // Bob's following is not crawled, and the stranger is not known here.
      commit(BOB, 'app.bsky.graph.follow', 'create', 'f2', { subject: ALICE }),
      commit(ALICE, 'app.bsky.graph.follow', 'create', 'f3', { subject: STRANGER }),
    ]);
    expect(await edges()).toEqual([{ recordKey: 'f1' }]);

    await handler.handle([commit(ALICE, 'app.bsky.graph.follow', 'delete', 'f1')]);
    expect(await edges()).toEqual([]);
  });
});
