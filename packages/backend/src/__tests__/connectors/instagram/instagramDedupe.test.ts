import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One Instagram post, two roads — against REAL rows.
 *
 * The Graph API import and the kilogram.makeup bridge must never store the same
 * Instagram post twice, whichever arrives first, and the guarantee has to hold
 * at the DATABASE (`post_source_keys_source_key_key`), not only in a pre-read.
 * So the real `PostCreationService` writes real rows here; the Graph API, the
 * media cache and Oxy are the mocked boundaries.
 *
 * Also against real rows: a bridge Delete/Update reaching the Graph-imported
 * copy, posts deleted on Instagram being removed, the pinned Instagram user id,
 * the follow cooldown, the source-key claim that keeps a racing upload from
 * being orphaned, and media that is re-hosted or not imported at all.
 *
 * The rows use the REAL bridge host (`kilogram.makeup`), because the source key
 * is only derived for a reviewed bridge; the suite is namespaced by USERNAME and
 * by synthetic shortcodes no other file uses.
 */

const h = vi.hoisted(() => ({
  creator: null as null | { create: (params: Record<string, unknown>) => Promise<unknown> },
  fetchBusinessDiscovery: vi.fn(),
  persist: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock('../../../connectors/instagram/graphClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../connectors/instagram/graphClient')>()),
  fetchBusinessDiscovery: h.fetchBusinessDiscovery,
}));
vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: h.persist,
}));
vi.mock('../../../services/mediaCache/cacheStore', () => ({ recordAccessAndMaybeEnqueue: vi.fn() }));
vi.mock('../../../services/mediaMetadataEnrichJob', () => ({ enqueueMediaMetadataEnrich: vi.fn(async () => true) }));
vi.mock('../../../queue/producers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../queue/producers')>()),
  enqueueInstagramGraphSync: h.enqueue,
}));
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
vi.mock('../../../connectors/activitypub/crypto', () => ({ getPublicKey: vi.fn(), signViaOxy: vi.fn(), signRequest: vi.fn() }));
vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: vi.fn(async () => true),
  invalidateFediverseSharing: vi.fn(),
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
import { eq, inArray, or, sql } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { config } from '../../../config';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { posts } from '../../../db/schema/posts';
import { postMedia, postSourceKeys } from '../../../db/schema/postContent';
import { federatedActors, federatedFollows, federatedMediaDeletions } from '../../../db/schema/federation';
import { findInstagramGraphSyncCandidates, findActorByUri } from '../../../db/federation/actorRepository';
import { claimSourceKey, findFilledSourceKeys } from '../../../db/posts/postSourceKeyRepository';
import { deletePostRecord } from '../../../db/posts/postRepository';
import '../../../services/PostCreationService';
import { buildFederatedNoteProvenance } from '../../../connectors/activitypub/apPostContent';
import { resolvePostIdFromObjectUri } from '../../../connectors/activitypub/helpers';
import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';
import { importInstagramMedia } from '../../../connectors/instagram/importer';
import { repairInstagramReelPosters } from '../../../scripts/repairInstagramReelPosters';
import { optionsFor, requestInstagramSync, syncInstagramActor, syncResultFor } from '../../../connectors/instagram/sync';
import { InstagramGraphError, type GraphMedia } from '../../../connectors/instagram/graphClient';
import { BIG_IMAGE_CAROUSEL, IMAGE, REEL_WITH_VIDEO, REEL_WITHOUT_VIDEO, ZUCK_PROFILE } from './fixtures/graphSnapshot';

const SUITE = 'igdedupe';
const USERNAME = `${SUITE}.acct`;
const KILOGRAM_ACTOR = `https://kilogram.makeup/users/${USERNAME}`;
const GRAPH_ACTOR = 'instagram-graph:98765432100001';
const IG_USER_ID = '17841401746480004';
const OWNER = `oxy-owner-${SUITE}`;
const FOLLOWER = `oxy-follower-${SUITE}`;

/** Shortcodes unique to this suite, so no parallel file can hold the same key. */
const code = (n: number) => `Dq${SUITE}${String(n).padStart(3, '0')}`;
const keyOf = (n: number) => `instagram:${code(n)}`;
const noteIdOf = (n: number) => `${KILOGRAM_ACTOR}/statuses/${code(n)}`;
const KEYS = Array.from({ length: 40 }, (_, n) => keyOf(n));
const NOTE_IDS = Array.from({ length: 40 }, (_, n) => noteIdOf(n));

/** A Graph media item for shortcode `n`, `n` minutes before a fixed base time (newest first = lowest n). */
const BASE = Date.parse('2026-09-01T12:00:00Z');
function item(n: number, base: GraphMedia = IMAGE): GraphMedia {
  return {
    ...base,
    id: `1800000000${n}`,
    permalink: `https://www.instagram.com/p/${code(n)}/`,
    caption: `caption ${n}`,
    timestamp: new Date(BASE - n * 60_000).toISOString().replace('Z', '+0000'),
  };
}

function page(items: GraphMedia[], after?: string, id = IG_USER_ID) {
  return { ...ZUCK_PROFILE, id, username: USERNAME, media: { data: items, after } };
}

/** Every stored copy of shortcode `n`, by either road. */
async function rowsFor(n: number) {
  const byKey = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(postSourceKeys, eq(postSourceKeys.postId, posts.id))
    .where(eq(postSourceKeys.sourceKey, keyOf(n)));
  const byActivity = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .where(or(eq(posts.federationActivityId, noteIdOf(n)), eq(posts.federationActivityId, keyOf(n))));
  return [...new Set([...byKey, ...byActivity].map((row) => row.id))];
}

async function mediaOf(postId: string): Promise<string[]> {
  const rows = await getDb().select({ id: postMedia.mediaId }).from(postMedia).where(eq(postMedia.postId, postId));
  return rows.map((row) => row.id).sort();
}

async function queuedDeletions(fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const rows = await getDb().select({ id: federatedMediaDeletions.oxyFileId }).from(federatedMediaDeletions)
    .where(inArray(federatedMediaDeletions.oxyFileId, fileIds));
  return rows.map((row) => row.id).sort();
}

async function clearPosts() {
  const keyed = await getDb().select({ id: postSourceKeys.postId }).from(postSourceKeys).where(inArray(postSourceKeys.sourceKey, KEYS));
  const byActivity = await getDb().select({ id: posts.id }).from(posts).where(inArray(posts.federationActivityId, [...KEYS, ...NOTE_IDS]));
  const ids = new Set([...keyed, ...byActivity].map((row) => row.id).filter((id): id is string => Boolean(id)));
  for (const id of ids) await deletePostRecord(id, undefined);
  await getDb().delete(postSourceKeys).where(inArray(postSourceKeys.sourceKey, KEYS));
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
  return (await findActorByUri(KILOGRAM_ACTOR))!;
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
  }) as Promise<{ id: string }>;
}

const TARGET = { username: USERNAME, ownerOxyUserId: OWNER, actorUri: KILOGRAM_ACTOR, kilogramActorUri: KILOGRAM_ACTOR };
const ONE_SHOT = { limit: 10, stopAtKnown: false, kind: 'interactive' as const };

let fileSeq = 0;
beforeAll(async () => {
  await connectPostgres();
  await clearPosts();
  await clearActors();
});

beforeEach(async () => {
  config.instagramGraph.enabled = true;
  h.fetchBusinessDiscovery.mockReset();
  h.enqueue.mockReset().mockResolvedValue(false);
  // Every file stores: a re-hosted Oxy id per remote URL.
  h.persist.mockReset().mockImplementation(async () => ({
    ok: true,
    media: { oxyFileId: `oxyfile-${SUITE}-${(fileSeq += 1)}`, contentType: 'image/jpeg', sizeBytes: 10 },
  }));
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

  it('skips a post the bridge already delivered — and re-hosts nothing for it', async () => {
    await ingestKilogramNote(1);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(1), item(2)]));

    const result = await importInstagramMedia(TARGET, ONE_SHOT);

    expect(result).toMatchObject({ outcome: 'ok', imported: 1 });
    expect(await rowsFor(1)).toHaveLength(1);
    expect(await rowsFor(2)).toHaveLength(1);
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it('skips a bridge post stored BEFORE source keys existed (activity id only)', async () => {
    const legacy = await ingestKilogramNote(3);
    await getDb().delete(postSourceKeys).where(eq(postSourceKeys.postId, legacy.id));
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
    expect(await resolvePostIdFromObjectUri(noteIdOf(4))).toBe(imported);
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

describe('the source-key claim (no upload for a post the other road wins)', () => {
  it('a live claim held by another writer keeps the import from downloading anything', async () => {
    expect(await claimSourceKey(keyOf(8), 'someone-else', new Date(Date.now() + 60_000))).toBe(true);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(8)]));

    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ imported: 0 });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('a bridge insert racing a live Graph claim collides instead of both uploading', async () => {
    expect(await claimSourceKey(keyOf(9), 'graph-import', new Date(Date.now() + 60_000))).toBe(true);
    const error = await ingestKilogramNote(9).catch((err: unknown) => err);
    expect(isUniqueViolation(error)).toBe(true);
    expect(await rowsFor(9)).toHaveLength(0);
  });

  it('a claimed-but-unfilled key is not "known": it cannot stop the walk as imported history', async () => {
    // A FULL first page (the Graph page size), every key claimed by someone else.
    const claimedPage = Array.from({ length: 25 }, (_, n) => item(n));
    for (let n = 0; n < 25; n += 1) {
      expect(await claimSourceKey(keyOf(n), 'someone-else', new Date(Date.now() + 60_000))).toBe(true);
    }
    expect(await findFilledSourceKeys([keyOf(0)])).toEqual(new Set());
    // With stopAtKnown the walk must go on past a page of mere claims.
    h.fetchBusinessDiscovery
      .mockResolvedValueOnce(page(claimedPage, 'next'))
      .mockResolvedValueOnce(page([item(29)]));
    const result = await importInstagramMedia(TARGET, { limit: 30, stopAtKnown: true, kind: 'background' });
    expect(h.fetchBusinessDiscovery).toHaveBeenCalledTimes(2);
    expect(result.imported).toBe(1);
  });

  it('an expired claim (dead worker) is taken over', async () => {
    expect(await claimSourceKey(keyOf(10), 'dead-worker', new Date(Date.now() - 1_000))).toBe(true);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(10)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ imported: 1 });
  });
});

describe('media is re-hosted, or the post is not imported yet', () => {
  it('stores the Graph post under the kilogram actor, with Oxy media, the permalink and original date', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(11)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const [id] = await rowsFor(11);
    const [row] = await getDb()
      .select({ actorUri: posts.federationActorUri, url: posts.federationUrl, createdAt: posts.createdAt, oxyUserId: posts.oxyUserId })
      .from(posts)
      .where(eq(posts.id, id));
    expect(row).toEqual({
      actorUri: KILOGRAM_ACTOR,
      url: `https://www.instagram.com/p/${code(11)}/`,
      createdAt: new Date(BASE - 11 * 60_000),
      oxyUserId: OWNER,
    });
    const media = await getDb().select({ mediaId: postMedia.mediaId }).from(postMedia).where(eq(postMedia.postId, id));
    expect(media.map((m) => m.mediaId)).toEqual([expect.stringMatching(/^oxyfile-/)]);
  });

  it.each([
    ['too large', { ok: false, reason: 'too-large', permanent: false }],
    ['not media', { ok: false, reason: 'not-media', permanent: true }],
    ['gone at the source', { ok: false, reason: 'upstream-error', status: 404, permanent: true }],
  ])('falls back to the poster image ONLY when the video can never be stored (%s)', async (_case, failure) => {
    h.persist.mockImplementation(async (url: string) => (url === REEL_WITH_VIDEO.media_url
      ? failure
      : { ok: true, media: { oxyFileId: `oxyfile-poster-${(fileSeq += 1)}`, contentType: 'image/jpeg', sizeBytes: 10 } }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(12, REEL_WITH_VIDEO)]));

    const result = await importInstagramMedia(TARGET, ONE_SHOT);

    expect(result.imported).toBe(1);
    const [id] = await rowsFor(12);
    const media = await getDb().select({ mediaId: postMedia.mediaId, type: postMedia.type }).from(postMedia).where(eq(postMedia.postId, id));
    expect(media).toEqual([{ mediaId: expect.stringMatching(/^oxyfile-poster-/), type: 'image' }]);
  });

  /**
   * Production, 2026-09-27: Reels imported while Oxy's media-write budget was
   * spent ("Oxy media store upload budget is spent for this window") were
   * stored as their cover image — for good, because the next sync saw the post
   * as imported. A video that may still be stored makes the post WAIT; the
   * next sync imports it WITH its video.
   */
  it.each([
    ['the upload budget spent', { ok: false, reason: 'upload-failed', permanent: false }],
    ['the store unavailable', { ok: false, reason: 'store-unavailable', permanent: false }],
    ['a dropped connection', { ok: false, reason: 'upstream-error', permanent: false }],
  ])('never degrades a Reel to its poster on a failure that may pass (%s): the post waits, then gets its video', async (_case, failure) => {
    h.persist.mockImplementation(async (url: string) => (url === REEL_WITH_VIDEO.media_url
      ? failure
      : { ok: true, media: { oxyFileId: `oxyfile-poster-${(fileSeq += 1)}`, contentType: 'image/jpeg', sizeBytes: 10 } }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16, REEL_WITH_VIDEO)]));

    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ outcome: 'partial', imported: 0 });
    expect(await rowsFor(16)).toHaveLength(0);

    // The budget refills: the next sync stores the Reel as a VIDEO.
    h.persist.mockImplementation(async () => ({
      ok: true,
      media: { oxyFileId: `oxyfile-${SUITE}-video-${(fileSeq += 1)}`, contentType: 'video/mp4', sizeBytes: 10 },
    }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16, REEL_WITH_VIDEO)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ outcome: 'ok', imported: 1 });
    const [id] = await rowsFor(16);
    expect(await getDb().select({ type: postMedia.type }).from(postMedia).where(eq(postMedia.postId, id))).toEqual([{ type: 'video' }]);
  });

  it('bytes Oxy holds for another owner (409 owned elsewhere) fall back to the poster, then are dropped — never an fbcdn URL', async () => {
    const ownedElsewhere = { ok: false, reason: 'owned-elsewhere', permanent: true };
    h.persist.mockImplementation(async (url: string) => (url === REEL_WITH_VIDEO.media_url
      ? ownedElsewhere
      : { ok: true, media: { oxyFileId: `oxyfile-poster-${(fileSeq += 1)}`, contentType: 'image/jpeg', sizeBytes: 10 } }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(38, REEL_WITH_VIDEO)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const [withPoster] = await rowsFor(38);
    expect(await getDb().select({ type: postMedia.type }).from(postMedia).where(eq(postMedia.postId, withPoster))).toEqual([{ type: 'image' }]);

    // The poster is someone else's too: the slot is dropped, the caption stays.
    h.persist.mockResolvedValue(ownedElsewhere);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(37, REEL_WITH_VIDEO)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ outcome: 'ok', imported: 1 });
    const [bare] = await rowsFor(37);
    expect(await getDb().select().from(postMedia).where(eq(postMedia.postId, bare))).toEqual([]);
  });

  it('an over-cap image with no poster to fall back to is dropped for good, not retried forever', async () => {
    h.persist.mockResolvedValue({ ok: false, reason: 'too-large', permanent: false });
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(39)]));

    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ outcome: 'ok', imported: 1 });
    const [id] = await rowsFor(39);
    expect(await getDb().select().from(postMedia).where(eq(postMedia.postId, id))).toEqual([]);
  });

  it('a carousel that must WAIT queues the slots it already uploaded (nothing references them meanwhile)', async () => {
    let calls = 0;
    h.persist.mockImplementation(async () => ((calls += 1) === 1
      ? { ok: true, media: { oxyFileId: `oxyfile-${SUITE}-slot1-${(fileSeq += 1)}`, contentType: 'image/jpeg', sizeBytes: 10 } }
      : { ok: false, reason: 'store-unavailable', permanent: false }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(14, BIG_IMAGE_CAROUSEL)]));

    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ outcome: 'partial', imported: 0 });

    const uploaded = `oxyfile-${SUITE}-slot1-${fileSeq}`;
    expect(await rowsFor(14)).toHaveLength(0);
    expect(await queuedDeletions([uploaded])).toEqual([uploaded]);
  });

  it('an insert that fails queues every file uploaded for it; a file mid-deletion makes the post wait', async () => {
    const gone = `oxyfile-${SUITE}-gone-${(fileSeq += 1)}`;
    const fresh = `oxyfile-${SUITE}-fresh-${(fileSeq += 1)}`;
    await getDb().insert(federatedMediaDeletions).values({ oxyFileId: gone, state: 'deleted', settledAt: new Date() });
    let calls = 0;
    h.persist.mockImplementation(async () => ({
      ok: true,
      media: { oxyFileId: (calls += 1) === 1 ? fresh : gone, contentType: 'image/jpeg', sizeBytes: 10 },
    }));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(15, { ...BIG_IMAGE_CAROUSEL, children: { data: BIG_IMAGE_CAROUSEL.children!.data.slice(0, 2) } })]));

    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ outcome: 'partial', imported: 0 });

    expect(await rowsFor(15)).toHaveLength(0);
    expect(await queuedDeletions([fresh, gone])).toEqual([fresh, gone].sort());
    // The tombstone is untouched (never re-armed, never reused).
    const [row] = await getDb().select({ state: federatedMediaDeletions.state }).from(federatedMediaDeletions).where(eq(federatedMediaDeletions.oxyFileId, gone));
    expect(row.state).toBe('deleted');
  });

  it('never stores an expiring CDN URL: with media writes off, the post waits for the next sync', async () => {
    h.persist.mockResolvedValue({ ok: false, reason: 'disabled', permanent: false });
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(13)]));

    const result = await importInstagramMedia(TARGET, ONE_SHOT);

    expect(result).toMatchObject({ outcome: 'partial', imported: 0 });
    expect(await rowsFor(13)).toHaveLength(0);
    // Its claim is released, so the other road (or the next sync) can take the key.
    expect(await getDb().select().from(postSourceKeys).where(eq(postSourceKeys.sourceKey, keyOf(13)))).toEqual([]);
    expect(syncResultFor('partial')).toBe('error');
  });
});

describe('repairInstagramReelPosters: Reels stored as their poster get their video', () => {
  const videoFile = () => ({ ok: true, media: { oxyFileId: `oxyfile-${SUITE}-video-${(fileSeq += 1)}`, contentType: 'video/mp4', sizeBytes: 10 } });
  const posterFile = () => ({ ok: true, media: { oxyFileId: `oxyfile-poster-${(fileSeq += 1)}`, contentType: 'image/jpeg', sizeBytes: 10 } });

  /** The production shape: a Reel whose video slot was stored as its poster image. */
  async function importReelAsPoster(n: number) {
    h.persist.mockImplementation(async (url: string) => (url === REEL_WITH_VIDEO.media_url
      ? { ok: false, reason: 'too-large', permanent: false }
      : posterFile()));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(n, REEL_WITH_VIDEO), item(n + 1)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const [id] = await rowsFor(n);
    const [poster] = await getDb().select({ id: postMedia.mediaId, type: postMedia.type }).from(postMedia).where(eq(postMedia.postId, id));
    expect(poster.type).toBe('image');
    return { id, poster: poster.id };
  }

  beforeEach(async () => {
    await seedKilogramActor({ instagramGraphSyncedAt: new Date(), instagramGraphUserId: IG_USER_ID });
  });

  it('a dry run lists the Reel (and not the image post beside it) and changes nothing', async () => {
    const { id, poster } = await importReelAsPoster(20);
    h.persist.mockReset();
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(20, REEL_WITH_VIDEO), item(21)]));

    const result = await repairInstagramReelPosters({ dryRun: true });

    expect(result.candidates).toEqual([{ postId: id, sourceKey: keyOf(20), slots: [0] }]);
    expect(result.checked).toBe(2);
    expect(h.persist).not.toHaveBeenCalled();
    expect(await mediaOf(id)).toEqual([poster]);
  });

  it('a mutating run swaps the video in, queues the poster file, and is idempotent', async () => {
    const { id, poster } = await importReelAsPoster(22);
    h.persist.mockReset().mockImplementation(async () => videoFile());
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(22, REEL_WITH_VIDEO), item(23)]));

    const result = await repairInstagramReelPosters({ dryRun: false });

    expect(result).toMatchObject({ repaired: 1, waiting: 0, gone: 0 });
    expect(h.persist).toHaveBeenCalledWith(REEL_WITH_VIDEO.media_url, OWNER, expect.objectContaining({ mediaType: 'video' }));
    const media = await getDb().select({ id: postMedia.mediaId, type: postMedia.type }).from(postMedia).where(eq(postMedia.postId, id));
    expect(media).toEqual([{ id: expect.stringMatching(/-video-/), type: 'video' }]);
    expect(await queuedDeletions([poster])).toEqual([poster]);

    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(22, REEL_WITH_VIDEO), item(23)]));
    expect((await repairInstagramReelPosters({ dryRun: false })).candidates).toEqual([]);
  });

  it('a video that still cannot be stored leaves the post as it is (re-run later)', async () => {
    const { id, poster } = await importReelAsPoster(24);
    h.persist.mockReset().mockResolvedValue({ ok: false, reason: 'upload-failed', permanent: false });
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(24, REEL_WITH_VIDEO)]));

    expect(await repairInstagramReelPosters({ dryRun: false })).toMatchObject({ repaired: 0, waiting: 1 });
    expect(await mediaOf(id)).toEqual([poster]);
  });

  it('never touches a Reel Meta lists WITHOUT a video (its thumbnail is the right shape)', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(25, REEL_WITHOUT_VIDEO)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(25, REEL_WITHOUT_VIDEO)]));
    expect((await repairInstagramReelPosters({ dryRun: true })).candidates).toEqual([]);
  });
});

describe('a bridge Delete / Update reaches the Graph-imported copy', () => {
  it('deletes the Graph-imported post when the bridge deletes the Note', async () => {
    await seedKilogramActor();
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(14)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    expect(await rowsFor(14)).toHaveLength(1);
    const files = await mediaOf((await rowsFor(14))[0]);

    await inboxProcessingService.onContentActivity(
      { id: `${noteIdOf(14)}#delete`, type: 'Delete', actor: KILOGRAM_ACTOR, object: noteIdOf(14) },
      KILOGRAM_ACTOR,
    );

    expect(await rowsFor(14)).toHaveLength(0);
    // Its re-hosted media is queued for deletion from Oxy, in that transaction.
    expect(files.length).toBeGreaterThan(0);
    expect(await queuedDeletions(files)).toEqual(files);
  });

  it('applies a bridge edit to the Graph-imported post instead of creating a second one', async () => {
    await seedKilogramActor();
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(39)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const before = await rowsFor(39);
    expect(before).toHaveLength(1);

    await inboxProcessingService.onContentActivity(
      {
        id: `${noteIdOf(39)}#update`,
        type: 'Update',
        actor: KILOGRAM_ACTOR,
        object: {
          id: noteIdOf(39),
          type: 'Note',
          attributedTo: KILOGRAM_ACTOR,
          content: '<p>edited on Instagram</p>',
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      },
      KILOGRAM_ACTOR,
    );

    expect(await rowsFor(39)).toEqual(before);
    const [variant] = await getDb().execute<{ body: string }>(sql`
      select body from post_content_variants where post_id = ${before[0]} order by position limit 1
    `);
    expect(variant?.body).toContain('edited on Instagram');
  });

  it('still refuses a Delete signed by a different actor', async () => {
    await seedKilogramActor();
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(15)]));
    await importInstagramMedia(TARGET, ONE_SHOT);

    await inboxProcessingService.onContentActivity(
      { id: 'https://kilogram.makeup/users/someone-else/x#delete', type: 'Delete', actor: 'https://kilogram.makeup/users/someone-else', object: noteIdOf(15) },
      'https://kilogram.makeup/users/someone-else',
    );

    expect(await rowsFor(15)).toHaveLength(1);
  });
});

describe('posts deleted on Instagram are removed — on the SECOND observation', () => {
  it('marks a post the listing no longer has, and removes it only when the next sync still lacks it', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(17), item(18), item(19)]));
    await importInstagramMedia(TARGET, ONE_SHOT);

    // 17 was deleted on Instagram; 19 is older than this listing's window.
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(18)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ deleted: 0, markedMissing: 1 });
    expect(await rowsFor(17)).toHaveLength(1);

    const files = await mediaOf((await rowsFor(17))[0]);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(18)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ deleted: 1 });
    expect(await rowsFor(17)).toHaveLength(0);
    expect(files.length).toBeGreaterThan(0);
    expect(await queuedDeletions(files)).toEqual(files);
    expect(await rowsFor(16)).toHaveLength(1);
    expect(await rowsFor(18)).toHaveLength(1);
    expect(await rowsFor(19)).toHaveLength(1);
  });

  it('clears the mark when the post is listed again (a transient gap is not a deletion)', async () => {
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(17), item(18)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(18)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(17), item(18)]));
    await importInstagramMedia(TARGET, ONE_SHOT);

    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(16), item(18)]));
    expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ deleted: 0, markedMissing: 1 });
    expect(await rowsFor(17)).toHaveLength(1);
  });

  it('never treats a listed item that maps to no importable post as deleted', async () => {
    // Stored (from the bridge); on Instagram it is now listed with nothing the
    // mapper can import — still listed, so still there.
    await ingestKilogramNote(20);
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(19)]));
    await importInstagramMedia(TARGET, ONE_SHOT);
    const bare: GraphMedia = { ...item(20), caption: undefined, media_url: undefined, thumbnail_url: undefined, media_type: 'IMAGE' };
    await getDb().update(posts).set({ createdAt: new Date(BASE - 20 * 60_000) }).where(eq(posts.federationActivityId, noteIdOf(20)));

    for (let i = 0; i < 2; i += 1) {
      h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(19), bare, item(21)]));
      expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ deleted: 0, markedMissing: 0 });
    }
    expect(await rowsFor(20)).toHaveLength(1);
  });

  it('does not judge a post that shares the listing tail\'s timestamp (the lower bound is exclusive)', async () => {
    const tail = item(24);
    const sameSecond: GraphMedia = { ...item(25), timestamp: tail.timestamp };
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(22), item(23), tail, sameSecond]));
    await importInstagramMedia(TARGET, ONE_SHOT);

    for (let i = 0; i < 2; i += 1) {
      h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(22), item(23), tail]));
      await importInstagramMedia(TARGET, ONE_SHOT);
    }
    expect(await rowsFor(25)).toHaveLength(1);
  });

  it('refuses an implausible mass deletion (a listing anomaly)', async () => {
    const many = Array.from({ length: 14 }, (_, n) => item(20 + n));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page(many));
    await importInstagramMedia(TARGET, { ...ONE_SHOT, limit: 20 });

    for (let i = 0; i < 2; i += 1) {
      h.fetchBusinessDiscovery.mockResolvedValueOnce(page([many[0], many[many.length - 1]]));
      expect(await importInstagramMedia(TARGET, ONE_SHOT)).toMatchObject({ deleted: 0, markedMissing: 0 });
    }
    expect(await rowsFor(21)).toHaveLength(1);
  });
});

describe('the leased sync', () => {
  it('runs once for concurrent triggers and stamps the result', async () => {
    const actor = await seedKilogramActor();
    h.fetchBusinessDiscovery.mockResolvedValue(page([item(34)]));

    const results = await Promise.all([syncInstagramActor(actor, 'profile_view'), syncInstagramActor(actor, 'profile_view')]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(h.fetchBusinessDiscovery).toHaveBeenCalledTimes(1);
    expect(await findActorByUri(KILOGRAM_ACTOR)).toMatchObject({ instagramGraphLastResult: 'ok', instagramGraphSyncedAt: expect.any(Date) });
    expect(await syncInstagramActor(actor, 'profile_view')).toBeNull();
  });

  it('pins the Instagram user id, then refuses a recycled username with a long cooldown', async () => {
    const actor = await seedKilogramActor();
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(35)]));
    await syncInstagramActor(actor, 'follow');
    const pinned = (await findActorByUri(KILOGRAM_ACTOR))!;
    expect(pinned.instagramGraphUserId).toBe(IG_USER_ID);

    // The username now names someone else. Force the cooldown open.
    await getDb().update(federatedActors).set({ instagramGraphSyncedAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(federatedActors.uri, KILOGRAM_ACTOR));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(36)], undefined, '999'));
    expect(await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'follow')).toMatchObject({ outcome: 'identity_mismatch', imported: 0 });
    expect(await rowsFor(36)).toHaveLength(0);
    expect(await rowsFor(35)).toHaveLength(1);

    // Not re-asked every few hours: the mismatch holds the weekly cooldown.
    await getDb().update(federatedActors).set({ instagramGraphSyncedAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(federatedActors.uri, KILOGRAM_ACTOR));
    expect(await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'follow')).toBeNull();
    expect(h.fetchBusinessDiscovery).toHaveBeenCalledTimes(2);
  });

  it('a follow/unfollow loop is ONE backfill: follows share the periodic cooldown', async () => {
    const actor = await seedKilogramActor();
    h.fetchBusinessDiscovery.mockResolvedValue(page([item(37)]));
    expect(await syncInstagramActor(actor, 'follow')).not.toBeNull();
    for (let i = 0; i < 5; i += 1) {
      expect(await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'follow')).toBeNull();
    }
    expect(h.fetchBusinessDiscovery).toHaveBeenCalledTimes(1);
  });

  it('a follow walks history to the backfill depth once — a profile view\'s page does not count', () => {
    expect(optionsFor('follow', {})).toMatchObject({ stopAtKnown: false, limit: 50 });
    expect(optionsFor('follow', { instagramGraphLastResult: 'ok' })).toMatchObject({ stopAtKnown: false });
    expect(optionsFor('follow', { instagramGraphLastResult: 'ok', instagramGraphHistoryDepth: 20 })).toMatchObject({ stopAtKnown: false });
    expect(optionsFor('follow', { instagramGraphLastResult: 'ok', instagramGraphHistoryDepth: 50 })).toMatchObject({ stopAtKnown: true });
    expect(optionsFor('profile_view', { instagramGraphLastResult: 'error' })).toMatchObject({ stopAtKnown: false });
    expect(optionsFor('periodic', {})).toMatchObject({ stopAtKnown: true });
  });

  it('records how deep a follow walked, so the next follow only looks for what is new', async () => {
    const actor = await seedKilogramActor();
    // A profile view first: one full page, the sync succeeds — but that is no backfill.
    const viewPage = Array.from({ length: 20 }, (_, n) => item(n));
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page(viewPage, 'cursor-after'));
    await syncInstagramActor(actor, 'profile_view');
    const afterView = (await findActorByUri(KILOGRAM_ACTOR))!;
    expect(afterView.instagramGraphHistoryDepth).toBe(20);
    expect(optionsFor('follow', afterView)).toMatchObject({ stopAtKnown: false });

    // The follow then walks until the listing ends: history fully walked.
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([...viewPage, item(20), item(21)]));
    await getDb().update(federatedActors).set({ instagramGraphSyncedAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(federatedActors.uri, KILOGRAM_ACTOR));
    await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'follow');
    const afterFollow = (await findActorByUri(KILOGRAM_ACTOR))!;
    expect(afterFollow.instagramGraphHistoryDepth).toBe(50);
    expect(optionsFor('follow', afterFollow)).toMatchObject({ stopAtKnown: true });
  });

  it('never starts work past its deadline (it must end inside its lease)', async () => {
    h.fetchBusinessDiscovery.mockResolvedValue(page([item(38)]));
    expect(await importInstagramMedia(TARGET, { ...ONE_SHOT, deadline: Date.now() - 1 })).toMatchObject({ outcome: 'deadline' });
    expect(h.fetchBusinessDiscovery).not.toHaveBeenCalled();
  });

  it('a run cut short by its deadline resumes after a SHORT cooldown, not the full one', async () => {
    expect(syncResultFor('deadline')).toBe('deadline');
    await seedKilogramActor({ instagramGraphLastResult: 'deadline', instagramGraphSyncedAt: new Date(Date.now() - 20 * 60_000) });
    h.fetchBusinessDiscovery.mockResolvedValueOnce(page([item(38)]));
    expect(await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'profile_view')).not.toBeNull();

    await getDb().update(federatedActors)
      .set({ instagramGraphLastResult: 'deadline', instagramGraphSyncedAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(federatedActors.uri, KILOGRAM_ACTOR));
    expect(await syncInstagramActor((await findActorByUri(KILOGRAM_ACTOR))!, 'profile_view')).toBeNull();
  });

  it('does not stamp a call it withheld (budget), so the next trigger retries', async () => {
    const actor = await seedKilogramActor();
    h.fetchBusinessDiscovery.mockRejectedValueOnce(new InstagramGraphError('budget', 'withheld'));
    expect(await syncInstagramActor(actor, 'periodic')).toMatchObject({ outcome: 'budget' });
    expect((await findActorByUri(KILOGRAM_ACTOR))?.instagramGraphSyncedAt).toBeUndefined();
  });

  it('hands profile-view and follow syncs to the queue worker when there is one', async () => {
    const actor = await seedKilogramActor();
    h.enqueue.mockResolvedValue(true);
    requestInstagramSync(actor, 'follow');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.enqueue).toHaveBeenCalledWith({ actorId: actor.id, trigger: 'follow' });
    expect(h.fetchBusinessDiscovery).not.toHaveBeenCalled();
  });

  it('is inert with the flag off', async () => {
    const actor = await seedKilogramActor();
    config.instagramGraph.enabled = false;
    expect(await syncInstagramActor(actor, 'follow')).toBeNull();
    expect(h.fetchBusinessDiscovery).not.toHaveBeenCalled();
  });
});

describe('periodic job selection', () => {
  const candidates = async () => (await findInstagramGraphSyncCandidates(
    { due: new Date(), notBusiness: new Date(Date.now() - 7 * 86_400_000), shortRetry: new Date(Date.now() - 15 * 60_000) },
    500,
  ))
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

  it('picks an instagram-graph actor too, and never a recently not-business or mismatched one', async () => {
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

    for (const result of ['not_business', 'identity_mismatch'] as const) {
      await getDb().update(federatedActors)
        .set({ instagramGraphSyncedAt: new Date(Date.now() - 86_400_000), instagramGraphLastResult: result })
        .where(eq(federatedActors.uri, GRAPH_ACTOR));
      expect(await candidates()).toEqual([]);
    }
  });

  it('ignores an ordinary fediverse actor', async () => {
    await seedKilogramActor({ networkAcct: null });
    await follow(KILOGRAM_ACTOR);
    expect(await candidates()).toEqual([]);
  });
});
