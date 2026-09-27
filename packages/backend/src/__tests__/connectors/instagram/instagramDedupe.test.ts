import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One Instagram post, two roads — against REAL rows.
 *
 * The Graph API import and the kilogram.makeup bridge must never store the same
 * Instagram post twice, whichever arrives first, and the guarantee has to hold
 * at the DATABASE (`posts_source_post_key_key`), not only in a pre-read. So the
 * real `PostCreationService` writes real rows here; the Graph API, the media
 * cache and Oxy are the mocked boundaries.
 *
 * The rows use the REAL bridge host (`kilogram.makeup`), because the source key
 * is only derived for a reviewed bridge; the suite is namespaced by USERNAME and
 * by synthetic shortcodes no other file uses.
 */

const h = vi.hoisted(() => ({
  creator: null as null | { create: (params: Record<string, unknown>) => Promise<unknown> },
  fetchBusinessDiscovery: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('../../../connectors/instagram/graphClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/instagram/graphClient')>()),
  fetchBusinessDiscovery: h.fetchBusinessDiscovery,
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: h.persist,
}));
vi.mock('../../../services/mediaCache/cacheStore', () => ({ recordAccessAndMaybeEnqueue: vi.fn() }));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => {
    if (!h.creator) throw new Error('PostCreator not registered');
    return h.creator;
  },
  getPostFederator: () => ({ federateNewPost: vi.fn(async () => undefined) }),
  registerPostCreator: (instance: { create: (params: Record<string, unknown>) => Promise<unknown> }) => {
    h.creator = instance;
  },
  registerPostFederator: vi.fn(),
}));
vi.mock('../../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ users: { get: vi.fn(), getMany: vi.fn(async () => []) }, serviceRequest: vi.fn() }),
}));
vi.mock('../../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      instagramGraph: { enabled: true, businessAccountId: '17841400000000000', apiVersion: 'v23.0', followBackfillLimit: 50 },
    },
    getMetaGraphAccessToken: () => 'test-token',
  };
});

import { isUniqueViolation } from '@oxy.so/db';
import { eq, inArray, or } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { config } from '../../../config';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { federatedActors, federatedFollows } from '../../../db/schema/federation';
import { findInstagramGraphSyncCandidates, findActorByUri } from '../../../db/federation/actorRepository';
import { deletePostRecord } from '../../../db/posts/postRepository';
import '../../../services/PostCreationService';
import { buildFederatedNoteProvenance } from '../../../connectors/activitypub/apPostContent';
import { resolvePostIdFromObjectUri } from '../../../connectors/activitypub/helpers';
import { importInstagramMedia } from '../../../connectors/instagram/importer';
import { syncInstagramActor } from '../../../connectors/instagram/sync';
import { InstagramGraphError, type GraphMedia } from '../../../connectors/instagram/graphClient';
import { IMAGE, REEL_WITH_VIDEO, ZUCK_PROFILE } from './fixtures/graphSnapshot';

const SUITE = 'igdedupe';
const USERNAME = `${SUITE}.acct`;
const KILOGRAM_ACTOR = `https://kilogram.makeup/users/${USERNAME}`;
const GRAPH_ACTOR = 'instagram-graph:98765432100001';
const OWNER = `oxy-owner-${SUITE}`;
const FOLLOWER = `oxy-follower-${SUITE}`;

/** Shortcodes unique to this suite, so no parallel file can hold the same key. */
const code = (n: number) => `Dq${SUITE}${String(n).padStart(3, '0')}`;
const keyOf = (n: number) => `instagram:${code(n)}`;
const noteIdOf = (n: number) => `${KILOGRAM_ACTOR}/statuses/${code(n)}`;

function item(n: number, base: GraphMedia = IMAGE): GraphMedia {
  return { ...base, id: `1800000000${n}`, permalink: `https://www.instagram.com/p/${code(n)}/`, caption: `caption ${n}` };
}

function page(items: GraphMedia[], after?: string) {
  return { ...ZUCK_PROFILE, id: '17841401746480004', username: USERNAME, media: { data: items, after } };
}

const KEYS = Array.from({ length: 20 }, (_, n) => keyOf(n));
const NOTE_IDS = Array.from({ length: 20 }, (_, n) => noteIdOf(n));

async function rowsFor(n: number) {
  return getDb()
    .select({ id: posts.id, activityId: posts.federationActivityId, sourcePostKey: posts.sourcePostKey })
    .from(posts)
    .where(or(eq(posts.sourcePostKey, keyOf(n)), eq(posts.federationActivityId, noteIdOf(n)), eq(posts.federationActivityId, keyOf(n))));
}

async function clearPosts() {
  const rows = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(or(inArray(posts.sourcePostKey, KEYS), inArray(posts.federationActivityId, [...KEYS, ...NOTE_IDS])));
  for (const row of rows) await deletePostRecord(row.id, undefined);
}

async function clearActors() {
  await getDb().delete(federatedFollows).where(inArray(federatedFollows.remoteActorUri, [KILOGRAM_ACTOR, GRAPH_ACTOR]));
  await getDb().delete(federatedActors).where(inArray(federatedActors.uri, [KILOGRAM_ACTOR, GRAPH_ACTOR]));
}

async function seedKilogramActor(extra: Partial<typeof federatedActors.$inferInsert> = {}) {
  await getDb().insert(federatedActors).values({
    protocol: 'activitypub',
    uri: KILOGRAM_ACTOR,
    username: USERNAME,
    domain: 'kilogram.makeup',
    acct: `${USERNAME}@kilogram.makeup`,
    networkAcct: `${USERNAME}@instagram.com`,
    inboxUrl: `${KILOGRAM_ACTOR}/inbox`,
    outboxUrl: `${KILOGRAM_ACTOR}/outbox`,
    type: 'Service',
    oxyUserId: OWNER,
    lastFetchedAt: new Date(),
    ...extra,
  });
}

/** What the ActivityPub ingest stores for a kilogram Note (the provenance builder's own output). */
async function ingestKilogramNote(n: number) {
  return h.creator!.create({
    oxyUserId: OWNER,
    federation: buildFederatedNoteProvenance({ activityId: noteIdOf(n), actorUri: KILOGRAM_ACTOR, noteUrl: noteIdOf(n) }),
    content: { text: `kilogram copy ${n}` },
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    skipNotifications: true,
    skipSocketEmit: true,
    skipFederationDelivery: true,
  });
}

const TARGET = { username: USERNAME, ownerOxyUserId: OWNER, actorUri: KILOGRAM_ACTOR, kilogramActorUri: KILOGRAM_ACTOR };
const ONE_SHOT = { limit: 10, stopAtKnown: false, kind: 'interactive' as const };

beforeAll(async () => {
  await connectPostgres();
  await clearPosts();
  await clearActors();
});

beforeEach(async () => {
  config.instagramGraph.enabled = true;
  h.fetchBusinessDiscovery.mockReset();
  // Media writes "unavailable right now": the remote URL is kept. Enough for
  // dedupe; the fallback case below overrides it.
  h.persist.mockReset().mockResolvedValue({ ok: false, reason: 'disabled', permanent: false });
  await clearPosts();
  await clearActors();
});

afterAll(async () => {
  await clearPosts();
  await clearActors();
  await closePostgres();
});

describe('kilogram first, then the Graph API', () => {
  it('stamps the Instagram source key on a kilogram Note', () => {
    expect(buildFederatedNoteProvenance({ activityId: noteIdOf(1), actorUri: KILOGRAM_ACTOR }).sourcePostKey).toBe(keyOf(1));
    expect(buildFederatedNoteProvenance({ activityId: 'https://mastodon.social/users/a/statuses/1', actorUri: 'https://mastodon.social/users/a' }))
      .not.toHaveProperty('sourcePostKey');
  });

  it('skips a post the bridge already delivered', async () => {
    await ingestKilogramNote(1);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(1), item(2)]));

    const result = await importInstagramMedia(TARGET, ONE_SHOT);

    expect(result).toMatchObject({ outcome: 'ok', imported: 1 });
    expect(await rowsFor(1)).toHaveLength(1);
    expect(await rowsFor(2)).toEqual([expect.objectContaining({ activityId: keyOf(2), sourcePostKey: keyOf(2) })]);
  });

  it('skips a bridge post stored BEFORE source keys existed (activity id only)', async () => {
    const legacy = await h.creator!.create({
      oxyUserId: OWNER,
      federation: { activityId: noteIdOf(3), actorUri: KILOGRAM_ACTOR, url: noteIdOf(3) },
      content: { text: 'legacy kilogram copy' },
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    }) as { id: string };
    await getDb().update(posts).set({ sourcePostKey: null }).where(eq(posts.id, legacy.id));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(3)]));

    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ imported: 0 });
    expect(await rowsFor(3)).toHaveLength(1);
  });
});

describe('the Graph API first, then kilogram', () => {
  it('links the bridge Note to the imported post instead of storing it again', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(4)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const [imported] = await rowsFor(4);

    // Every "is this object already here?" gate on the AP side resolves the
    // kilogram Note id to the Graph-imported row.
    expect(await resolvePostIdFromObjectUri(noteIdOf(4))).toBe(imported.id);
  });

  it('is enforced by the DATABASE: a racing kilogram insert collides', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(5)]));
    await importInstagramMedia(TARGET, ONE_SHOT);

    const error = await ingestKilogramNote(5).catch((err: unknown) => err);
    expect(isUniqueViolation(error)).toBe(true);
    expect(await rowsFor(5)).toHaveLength(1);
  });

  it('a second Graph import of the same page is a no-op', async () => {
    h.fetchBusinessDiscovery.mockResolvedValue(page([item(6), item(7)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ imported: 2 });
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ imported: 0 });
  });
});

describe('what an import stores', () => {
  it('stores the Graph post under the kilogram actor, with the permalink and original date', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(8)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const [row] = await getDb()
      .select({ actorUri: posts.federationActorUri, url: posts.federationUrl, createdAt: posts.createdAt, oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(eq(posts.sourcePostKey, keyOf(8)));
    expect(row).toEqual({
      actorUri: KILOGRAM_ACTOR,
      url: `https://www.instagram.com/p/${code(8)}/`,
      createdAt: new Date(IMAGE.timestamp!),
      oxyUserId: OWNER,
    });
  });

  it('falls back to the poster image when the video itself is permanently unavailable', async () => {
    h.persist.mockImplementation(async (url: string) => (url === REEL_WITH_VIDEO.media_url
      ? { ok: false, reason: 'too_large', permanent: true }
      : { ok: false, reason: 'disabled', permanent: false }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(9, REEL_WITH_VIDEO)]));
    const result = await importInstagramMedia(TARGET, ONE_SHOT);

    expect(result.imported).toBe(1);
    expect(result.posts[0].media?.[0].type).toBe('video');
    expect(h.persist.mock.calls.map(([url]) => url)).toEqual([REEL_WITH_VIDEO.media_url, REEL_WITH_VIDEO.thumbnail_url]);
  });

  it('stops at the first known post when asked (the periodic "what is new" sync)', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(10)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(11), item(10), item(12)]));

    const result = await importInstagramMedia(TARGET, { limit: 10, stopAtKnown: true, kind: 'background' });
    expect(result.imported).toBe(1);
    expect(await rowsFor(12)).toHaveLength(0);
  });

  it('refuses to import when the username now names a different account', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(13)]));
    const result = await importInstagramMedia({ ...TARGET, expectedIgUserId: '1' }, ONE_SHOT);
    expect(result.outcome).toBe('identity_mismatch');
    expect(await rowsFor(13)).toHaveLength(0);
  });
});

describe('the leased sync', () => {
  it('runs once for concurrent triggers and stamps the result', async () => {
    await seedKilogramActor();
    const actor = (await findActorByUri(KILOGRAM_ACTOR))!;
    h.fetchBusinessDiscovery.mockResolvedValue(page([item(14)]));

    const results = await Promise.all([syncInstagramActor(actor, 'profile_view'), syncInstagramActor(actor, 'profile_view')]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.fetchBusinessDiscovery).toHaveBeenCalledTimes(1);
    expect(await findActorByUri(KILOGRAM_ACTOR)).toMatchObject({ instagramGraphLastResult: 'ok', instagramGraphSyncedAt: expect.any(Date) });
    // The cooldown now holds a profile view back.
    expect(await syncInstagramActor(actor, 'profile_view')).toBeNull();
  });

  it('remembers "not a business account" and does not re-ask on the next view', async () => {
    await seedKilogramActor();
    const actor = (await findActorByUri(KILOGRAM_ACTOR))!;
    h.fetchBusinessDiscovery.mockRejectedValue(new InstagramGraphError('not_business', 'nope'));

    expect(await syncInstagramActor(actor, 'follow')).toMatchObject({ outcome: 'not_business' });
    expect(await syncInstagramActor(actor, 'follow')).toBeNull();
    expect(h.fetchBusinessDiscovery).toHaveBeenCalledTimes(1);
  });

  it('does not stamp a call it withheld (budget), so the next trigger retries', async () => {
    await seedKilogramActor();
    const actor = (await findActorByUri(KILOGRAM_ACTOR))!;
    h.fetchBusinessDiscovery.mockRejectedValueOnce(new InstagramGraphError('budget', 'withheld'));
    expect(await syncInstagramActor(actor, 'periodic')).toMatchObject({ outcome: 'budget' });
    expect((await findActorByUri(KILOGRAM_ACTOR))?.instagramGraphSyncedAt).toBeUndefined();
  });

  it('is inert with the flag off', async () => {
    await seedKilogramActor();
    config.instagramGraph.enabled = false;
    expect(await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'follow')).toBeNull();
    expect(h.fetchBusinessDiscovery).not.toHaveBeenCalled();
  });
});

describe('periodic job selection', () => {
  const now = () => new Date();
  const candidates = async () => (await findInstagramGraphSyncCandidates(now(), new Date(Date.now() - 7 * 86_400_000), 500))
    .map((candidate) => candidate.uri)
    .filter((uri) => uri === KILOGRAM_ACTOR || uri === GRAPH_ACTOR);

  async function follow(uri: string, status: 'accepted' | 'pending' = 'accepted', network: 'activitypub' | 'instagram-graph' = 'activitypub') {
    await getDb().insert(federatedFollows).values({ localUserId: FOLLOWER, remoteActorUri: uri, direction: 'outbound', status, network });
  }

  it('picks an Instagram-identity actor with an accepted local follower', async () => {
    await seedKilogramActor();
    expect(await candidates()).toEqual([]);
    await follow(KILOGRAM_ACTOR, 'pending');
    expect(await candidates()).toEqual([]);
    await getDb().update(federatedFollows).set({ status: 'accepted' }).where(eq(federatedFollows.remoteActorUri, KILOGRAM_ACTOR));
    expect(await candidates()).toEqual([KILOGRAM_ACTOR]);
  });

  it('picks an instagram-graph actor too, and never a recently not-business one', async () => {
    await getDb().insert(federatedActors).values({
      protocol: 'instagram-graph',
      uri: GRAPH_ACTOR,
      username: `${SUITE}.graph`,
      domain: 'instagram.com',
      acct: `${SUITE}.graph@instagram.com`,
      networkAcct: `${SUITE}.graph@instagram.com`,
      oxyUserId: `${OWNER}-graph`,
      lastFetchedAt: new Date(),
    });
    await follow(GRAPH_ACTOR, 'accepted', 'instagram-graph');
    expect(await candidates()).toEqual([GRAPH_ACTOR]);

    await getDb().update(federatedActors)
      .set({ instagramGraphSyncedAt: new Date(Date.now() - 86_400_000), instagramGraphLastResult: 'not_business' })
      .where(eq(federatedActors.uri, GRAPH_ACTOR));
    expect(await candidates()).toEqual([]);
  });

  it('ignores an ordinary fediverse actor', async () => {
    await seedKilogramActor({ networkAcct: null });
    await follow(KILOGRAM_ACTOR);
    expect(await candidates()).toEqual([]);
  });
});
