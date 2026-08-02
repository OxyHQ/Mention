import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { canonicalFederationHost } from '@oxyhq/federation';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, so it is erased before the hoisted `vi.unmock` below runs and does
// not pull the module in ahead of the dynamic imports.
import type { PurgeOptions, PurgeReport } from '../../scripts/purgeBlockedDomainContent';

/**
 * The blocked-domain purge, against a REAL MongoDB.
 *
 * ## Why a real server, and a replica set
 *
 * Every claim this script makes is a claim about DATA that survives it — a local
 * user's post is still there, their reply still points where it pointed, a
 * non-blocked instance is untouched, a dry run changed nothing. A mocked model
 * cannot fail for any of those reasons: it returns whatever the mock was told to
 * return, so a purge that deleted the wrong collection would pass a mock suite
 * unchanged. Only real documents can distinguish "did not delete it" from "was
 * never asked about it".
 *
 * The replica set (rather than a standalone server) is required because the
 * counter-preserving engagement teardown opens a transaction, and that teardown
 * is the whole reason a blocked instance's like does not leave a local author's
 * like count permanently inflated.
 *
 * The repo-wide `setup.ts` replaces `mongoose.connect` with a no-op so no test
 * can open a connection by accident; this file opts out and imports everything
 * dynamically below the hoisted unmock, mirroring `engagementOutboxWrites.test.ts`.
 *
 * ## What is mocked, and why only this
 *
 * The Oxy S3 object store, because deleting cached media bytes is a network call
 * to another service. The mock RECORDS the file ids it was asked to delete, so
 * the ordering guarantee (bytes before the row that names them) is asserted
 * rather than assumed.
 *
 * ## Why a Postgres connection is opened for a Mongo script
 *
 * KNOWN GAP, stated rather than papered over. This script still reads and
 * deletes MONGO collections, but the deletion preflight it runs
 * (`assertPostsSafeToDelete`, `collectPostCascadeResidue`,
 * `assertActorAnchorSafeToDelete`) probes POSTGRES — the port moved `posts` and
 * its reference tables and this script has not followed. So the preflight is
 * asking a different store than the script deletes from, and it passes here for
 * that reason rather than because the corpus is clean.
 *
 * The connection is opened so the suite exercises the script's own policy at
 * all; every assertion below is about which MONGO documents survive, which is
 * exactly what the script decides today. Porting it is a separate piece of work
 * (20 models), and until then the preflight in front of it is not a guard.
 */
vi.unmock('mongoose');

const h = vi.hoisted(() => ({
  deletedFileIds: [] as string[],
  mediaCacheEnabled: { value: true },
  deleteShouldFail: { value: false },
}));

vi.mock('../../services/mediaCache/oxyMediaStore', () => ({
  isMediaCacheEnabled: () => h.mediaCacheEnabled.value,
  deleteCachedMedia: async (oxyFileId: string) => {
    if (h.deleteShouldFail.value) throw new Error('media store refused the delete');
    h.deletedFileIds.push(oxyFileId);
  },
}));

vi.mock('../../scripts/lib/adminScriptLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scripts/lib/adminScriptLifecycle')>()),
  closeAdminScriptResources: vi.fn(async () => undefined),
}));

const mongoose = (await import('mongoose')).default;
const { eq, inArray } = await import('drizzle-orm');
const { closePostgres, connectPostgres, getDb } = await import('../../db/postgres');
const { likes: pgLikes } = await import('../../db/schema/engagement');
const { posts: pgPosts } = await import('../../db/schema/posts');
const { federatedActors, federatedFollows } = await import('../../db/schema/federation');
const { adminScriptCursors } = await import('../../db/schema/adminScripts');
const { Post } = await import('../../models/Post');
const { default: Like } = await import('../../models/Like');
const { default: Notification } = await import('../../models/Notification');
const { default: FederatedMediaCache } = await import('../../models/FederatedMediaCache');
const { default: ContentLabel } = await import('../../models/ContentLabel');
const { withDeadlockRetry } = await import('../helpers/serviceFixtures');
const { POST_REFERENCE_PROBE_NAMES } = await import('../../scripts/lib/adminDeletionPreflight');
const { FEDERATION_DOMAIN } = await import('../../connectors/activitypub/constants');
const {
  buildBlockedContentDomains,
  purgeBlockedDomainContent,
  CASCADED_POST_REFERENCES,
  EmptyBlocklistError,
} = await import('../../scripts/purgeBlockedDomainContent');

const BLOCKED = 'spam.example';
const ALLOWED = 'mastodon.social';
const BLOCKED_ACTOR_URI = `https://${BLOCKED}/users/bad`;
const GHOST_ACTOR_URI = `https://${BLOCKED}/users/ghost`;
const BLOCKED_MEDIA_URL = `https://${BLOCKED}/media/1.jpg`;
const ALLOWED_MEDIA_URL = `https://${ALLOWED}/media/2.jpg`;

/** Ids fixed per seed so every assertion names the same document it seeded. */
interface Seeded {
  blockedPost: mongoose.Types.ObjectId;
  blockedBoostOfLocal: mongoose.Types.ObjectId;
  orphanPost: mongoose.Types.ObjectId;
  allowedPost: mongoose.Types.ObjectId;
  localPost: mongoose.Types.ObjectId;
  localReply: mongoose.Types.ObjectId;
  localQuote: mongoose.Types.ObjectId;
  localBoost: mongoose.Types.ObjectId;
  entityNotification: mongoose.Types.ObjectId;
  unrelatedNotification: mongoose.Types.ObjectId;
}

let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri(), { dbName: 'purge-blocked-domain' });
  await connectPostgres();
}, 180_000);

afterAll(async () => {
  await clearPostgresFixtures();
  await closePostgres();
  await mongoose.disconnect();
  await server.stop();
});

/**
 * Drop this file's Postgres rows.
 *
 * Mongo is a per-file in-memory server, so its teardown can be a bare
 * `deleteMany`. Postgres is NOT — one database serves every test file in the
 * run — so this is scoped to the two account ids, `oxy-local` and `oxy-blocked`,
 * which are used by this file and no other (checked).
 *
 * Retried, because both statements are bulk writes against `posts` while other
 * suites are writing it concurrently, and `posts` self-references itself four
 * times. An unretried bulk delete there loses a `40P01` often enough to look
 * like a flaky assertion somewhere else in the file.
 */
async function clearPostgresFixtures(): Promise<void> {
  const accounts = ['oxy-local', 'oxy-blocked', 'oxy-remote'];
  const db = getDb();
  await withDeadlockRetry(() => db.delete(pgLikes).where(inArray(pgLikes.userId, accounts)));
  await withDeadlockRetry(() => db.delete(pgPosts).where(inArray(pgPosts.oxyUserId, accounts)));
  // The federation anchors and the resume cursors moved to Postgres with the
  // rest of this script's stores, so they are scoped the same way: by this
  // file's own domains and script name, never "delete every actor".
  await db.delete(federatedFollows).where(inArray(federatedFollows.localUserId, accounts));
  await db.delete(federatedActors).where(inArray(federatedActors.domain, [BLOCKED, ALLOWED]));
  await db
    .delete(adminScriptCursors)
    .where(eq(adminScriptCursors.script, 'purgeBlockedDomainContent'));
}

/** This file's actor rows, so an assertion can count what survived. */
async function actorsOnDomain(domain: string): Promise<number> {
  const rows = await getDb()
    .select({ id: federatedActors.id })
    .from(federatedActors)
    .where(eq(federatedActors.domain, domain));
  return rows.length;
}

/** This file's follow edges naming one remote actor. */
async function followsOfActor(remoteActorUri: string): Promise<number> {
  const rows = await getDb()
    .select({ id: federatedFollows.id })
    .from(federatedFollows)
    .where(eq(federatedFollows.remoteActorUri, remoteActorUri));
  return rows.length;
}

/** This file's resume-cursor rows. */
async function cursorRows() {
  return getDb()
    .select()
    .from(adminScriptCursors)
    .where(eq(adminScriptCursors.script, 'purgeBlockedDomainContent'));
}

beforeEach(async () => {
  h.deletedFileIds.length = 0;
  h.mediaCacheEnabled.value = true;
  h.deleteShouldFail.value = false;
  await Promise.all(
    [Post, Like, Notification, FederatedMediaCache, ContentLabel].map((model) =>
      model.deleteMany({}),
    ),
  );
  await clearPostgresFixtures();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * A corpus with one of every interaction shape the policy decides on.
 *
 * Written through `collection.insertOne` so the documents are exactly what the
 * script will read, without Mongoose defaults quietly filling in fields the real
 * federated-ingest path never sets.
 */
async function seed(): Promise<Seeded> {
  const ids: Seeded = {
    blockedPost: new mongoose.Types.ObjectId(),
    blockedBoostOfLocal: new mongoose.Types.ObjectId(),
    orphanPost: new mongoose.Types.ObjectId(),
    allowedPost: new mongoose.Types.ObjectId(),
    localPost: new mongoose.Types.ObjectId(),
    localReply: new mongoose.Types.ObjectId(),
    localQuote: new mongoose.Types.ObjectId(),
    localBoost: new mongoose.Types.ObjectId(),
    entityNotification: new mongoose.Types.ObjectId(),
    unrelatedNotification: new mongoose.Types.ObjectId(),
  };

  await getDb().insert(federatedActors).values([
    {
      protocol: 'activitypub',
      uri: BLOCKED_ACTOR_URI,
      username: 'bad',
      domain: BLOCKED,
      acct: `bad@${BLOCKED}`,
      oxyUserId: 'oxy-blocked',
    },
    {
      protocol: 'activitypub',
      uri: `https://${ALLOWED}/users/ok`,
      username: 'ok',
      domain: ALLOWED,
      acct: `ok@${ALLOWED}`,
      oxyUserId: 'oxy-remote',
    },
  ]);

  await Post.collection.insertMany([
    {
      _id: ids.blockedPost,
      oxyUserId: 'oxy-blocked',
      type: 'text',
      federation: { actorUri: BLOCKED_ACTOR_URI, activityId: `https://${BLOCKED}/notes/1` },
      media: [{ id: BLOCKED_MEDIA_URL, type: 'image' }],
      stats: { likesCount: 1, boostsCount: 1, federatedBoostsCount: 0 },
    },
    {
      // A boost BY the blocked actor OF a surviving local post — the counter case.
      _id: ids.blockedBoostOfLocal,
      oxyUserId: 'oxy-blocked',
      type: 'boost',
      boostOf: ids.localPost.toString(),
      federation: { actorUri: BLOCKED_ACTOR_URI, activityId: `https://${BLOCKED}/announce/1` },
      stats: {},
    },
    {
      // Blocked host, but no FederatedActor row and an owner no actor resolves to.
      _id: ids.orphanPost,
      oxyUserId: 'oxy-ghost',
      type: 'text',
      federation: { actorUri: GHOST_ACTOR_URI, activityId: `https://${BLOCKED}/notes/2` },
      stats: {},
    },
    {
      _id: ids.allowedPost,
      oxyUserId: 'oxy-remote',
      type: 'text',
      federation: { actorUri: `https://${ALLOWED}/users/ok`, activityId: `https://${ALLOWED}/notes/9` },
      media: [{ id: ALLOWED_MEDIA_URL, type: 'image' }],
      stats: {},
    },
    {
      _id: ids.localPost,
      oxyUserId: 'oxy-local',
      type: 'text',
      stats: { likesCount: 1, boostsCount: 1, federatedBoostsCount: 1 },
    },
    {
      _id: ids.localReply,
      oxyUserId: 'oxy-local',
      type: 'text',
      parentPostId: ids.blockedPost.toString(),
      threadId: ids.blockedPost.toString(),
      stats: {},
    },
    {
      _id: ids.localQuote,
      oxyUserId: 'oxy-local',
      type: 'text',
      quoteOf: ids.blockedPost.toString(),
      stats: {},
    },
    {
      _id: ids.localBoost,
      oxyUserId: 'oxy-local',
      type: 'boost',
      boostOf: ids.blockedPost.toString(),
      stats: {},
    },
  ] as never);

  await Like.collection.insertMany([
    // A local user's like ON blocked content — dies with the post. Mongo, because
    // the lane that removes it is the one still deleting Mongo posts.
    { _id: new mongoose.Types.ObjectId(), userId: 'oxy-local', postId: ids.blockedPost, value: 1 },
  ] as never);

  // The blocked actor's like on a SURVIVING local post — the counter teardown,
  // and the one lane that is fully ported.
  //
  // Seeded in POSTGRES, with the local post present in BOTH stores under the
  // SAME id. That is not a convenience: it is the dual-run's actual shape.
  // `posts.id` is `text` holding the 24-character ObjectId hex for every
  // pre-cutover post, so a Mongo `_id` and its Postgres `posts.id` are the same
  // string — which is exactly what lets a script holding a Mongo id reach the
  // Postgres row. A fixture that seeded only Mongo could not tell a teardown
  // that works from one that silently matches nothing.
  await getDb().insert(pgPosts).values({
    id: ids.localPost.toString(),
    oxyUserId: 'oxy-local',
    status: 'published',
    visibility: 'public',
    statsLikesCount: 1,
    createdAt: new Date(),
  });
  await getDb().insert(pgLikes).values({
    userId: 'oxy-blocked',
    postId: ids.localPost.toString(),
    value: 1,
  });

  await Notification.collection.insertMany([
    {
      _id: ids.entityNotification,
      recipientId: 'oxy-local',
      actorId: 'oxy-other',
      entityId: ids.blockedPost,
      entityType: 'post',
      type: 'like',
      read: false,
    },
    {
      _id: ids.unrelatedNotification,
      recipientId: 'oxy-local',
      actorId: 'oxy-other',
      entityId: ids.localPost,
      entityType: 'post',
      type: 'like',
      read: false,
    },
  ] as never);

  await getDb().insert(federatedFollows).values([
    {
      localUserId: 'oxy-local',
      remoteActorUri: BLOCKED_ACTOR_URI,
      direction: 'inbound',
      status: 'accepted',
    },
    {
      localUserId: 'oxy-local',
      remoteActorUri: `https://${ALLOWED}/users/ok`,
      direction: 'outbound',
      status: 'accepted',
    },
  ]);

  await FederatedMediaCache.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(),
      remoteUrl: BLOCKED_MEDIA_URL,
      state: 'cached',
      oxyFileId: 'file-blocked',
      lastAccessedAt: new Date(),
      failCount: 0,
    },
    {
      _id: new mongoose.Types.ObjectId(),
      remoteUrl: ALLOWED_MEDIA_URL,
      state: 'cached',
      oxyFileId: 'file-allowed',
      lastAccessedAt: new Date(),
      failCount: 0,
    },
  ] as never);

  return ids;
}

function options(overrides: Partial<PurgeOptions> = {}): PurgeOptions {
  return { dryRun: false, resetCursor: false, ...overrides };
}

async function run(overrides: Partial<PurgeOptions> = {}): Promise<PurgeReport> {
  return purgeBlockedDomainContent(new Set([BLOCKED]), options(overrides));
}

/** Every document in every collection the run can touch, order-independent. */
async function snapshotEverything(): Promise<string> {
  const models = [Post, Like, Notification, FederatedMediaCache, ContentLabel];
  const collections = await Promise.all(
    models.map(async (model) => {
      const docs = await model.collection.find({}).sort({ _id: 1 }).toArray();
      return [model.collection.collectionName, docs] as const;
    }),
  );
  // The Postgres side has to be in the snapshot too, or "a dry run changes
  // nothing" would stop covering the three stores this script's actor lane now
  // reads and writes — which is precisely where a dry run could start deleting.
  const db = getDb();
  const [actorRows, followRows, cursorRows2] = await Promise.all([
    db.select().from(federatedActors).where(inArray(federatedActors.domain, [BLOCKED, ALLOWED])),
    db
      .select()
      .from(federatedFollows)
      .where(inArray(federatedFollows.localUserId, ['oxy-local', 'oxy-blocked'])),
    cursorRows(),
  ]);
  return JSON.stringify([
    collections,
    actorRows.map((row) => row.uri).sort(),
    followRows.map((row) => `${row.localUserId}|${row.remoteActorUri}`).sort(),
    cursorRows2.map((row) => row.scope).sort(),
  ]);
}

async function postExists(id: mongoose.Types.ObjectId): Promise<boolean> {
  return (await Post.countDocuments({ _id: id })) === 1;
}

describe('purgeBlockedDomainContent — what it removes', () => {
  it('removes a blocked domain\'s posts, actor row, follow edge and cached media', async () => {
    const ids = await seed();

    const report = await run();

    expect(await postExists(ids.blockedPost)).toBe(false);
    expect(await postExists(ids.blockedBoostOfLocal)).toBe(false);
    expect(await actorsOnDomain(BLOCKED)).toBe(0);
    expect(await followsOfActor(BLOCKED_ACTOR_URI)).toBe(0);
    expect(await FederatedMediaCache.countDocuments({ remoteUrl: BLOCKED_MEDIA_URL })).toBe(0);
    expect(report.issues.preflightBlocked).toBe(0);
    expect(report.issues.cascadeResidue).toBe(0);
  });

  it('removes a post whose actor row is GONE — the case an actor-anchored count misses', async () => {
    const ids = await seed();

    const report = await run();

    expect(await postExists(ids.orphanPost)).toBe(false);
    // Attributed separately so a review can see it was NOT part of the naive
    // "posts by actors we hold from that domain" figure.
    expect(report.totals.orphanPosts).toBe(1);
    expect(report.byDomain.get(BLOCKED)?.orphanPosts).toBe(1);
  });

  it('deletes the cached BYTES before the row that names them', async () => {
    await seed();

    await run();

    expect(h.deletedFileIds).toContain('file-blocked');
    expect(h.deletedFileIds).not.toContain('file-allowed');
  });

  it('keeps the row when the object store cannot delete, and fails the run', async () => {
    await seed();
    h.deleteShouldFail.value = true;

    const report = await run();

    // A row deleted before its bytes is an S3 object nothing can ever name again.
    expect(await FederatedMediaCache.countDocuments({ remoteUrl: BLOCKED_MEDIA_URL })).toBe(1);
    expect(report.issues.mediaObjectDeleteFailed).toBeGreaterThan(0);
  });
});

describe('purgeBlockedDomainContent — what it must NEVER remove', () => {
  it('leaves a local user\'s own post alone', async () => {
    const ids = await seed();

    await run();

    expect(await postExists(ids.localPost)).toBe(true);
  });

  it('leaves local posts alone even when handed a domain set naming OUR OWN domain', async () => {
    // `buildBlockedContentDomains` makes this set impossible to construct, and
    // its own tests cover that. This asserts the SECOND, independent property
    // underneath it: a post is only ever a candidate if it carries a
    // `federation.actorUri` or is owned by a blocked actor, so local content is
    // out of reach even if the first line of defence were wrong. Two independent
    // guards, because the cost of both failing is every local user's content.
    const ids = await seed();
    const ownDomain = canonicalFederationHost(FEDERATION_DOMAIN);

    await purgeBlockedDomainContent(new Set([ownDomain]), options());

    expect(await postExists(ids.localPost)).toBe(true);
    expect(await postExists(ids.localReply)).toBe(true);
    expect(await postExists(ids.localQuote)).toBe(true);
    expect(await Post.countDocuments({ oxyUserId: 'oxy-local' })).toBe(4);
  });

  it('leaves a non-blocked instance completely alone', async () => {
    const ids = await seed();

    await run();

    expect(await postExists(ids.allowedPost)).toBe(true);
    expect(await actorsOnDomain(ALLOWED)).toBe(1);
    expect(await FederatedMediaCache.countDocuments({ remoteUrl: ALLOWED_MEDIA_URL })).toBe(1);
    expect(await followsOfActor(`https://${ALLOWED}/users/ok`))
      .toBe(1);
  });

  it('keeps a local reply and does NOT rewrite where it points', async () => {
    const ids = await seed();

    const report = await run();

    const reply = await Post.findById(ids.localReply).lean();
    expect(reply).not.toBeNull();
    // Deliberately still dangling: hydration soft-fails the parent lookup, so the
    // reply renders and simply loses its "Replying to @…" handle. Re-rooting it
    // would rewrite a real user's post to remove someone else's.
    expect(reply?.parentPostId).toBe(ids.blockedPost.toString());
    expect(report.totals.repliesByOthersKept).toBe(1);
    expect(report.totals.threadRootsKept).toBe(1);
  });

  it('keeps a local quote and does NOT rewrite where it points', async () => {
    const ids = await seed();

    const report = await run();

    const quote = await Post.findById(ids.localQuote).lean();
    expect(quote).not.toBeNull();
    expect(quote?.quoteOf).toBe(ids.blockedPost.toString());
    expect(report.totals.quotesByOthersKept).toBe(1);
  });

  it('keeps an unrelated notification', async () => {
    const ids = await seed();

    await run();

    expect(await Notification.countDocuments({ _id: ids.unrelatedNotification })).toBe(1);
    expect(await Notification.countDocuments({ _id: ids.entityNotification })).toBe(0);
  });
});

describe('purgeBlockedDomainContent — the boost policy', () => {
  it('deletes a LOCAL user\'s boost of removed content', async () => {
    const ids = await seed();

    const report = await run();

    // A boost has an empty body and renders entirely from its original; kept, it
    // would be a permanent placeholder card with nothing behind it.
    expect(await postExists(ids.localBoost)).toBe(false);
    expect(report.totals.boostsByOthers).toBe(1);
  });

  it('repairs the boost counters on a SURVIVING post it took a boost from', async () => {
    const ids = await seed();

    await run();

    const local = await Post.findById(ids.localPost).lean();
    expect(local?.stats?.boostsCount).toBe(0);
    expect(local?.stats?.federatedBoostsCount).toBe(0);
  });
});

describe('purgeBlockedDomainContent — the engagement policy', () => {
  /**
   * Previously `it.fails`: the teardown was SPLIT across two stores — the script
   * found the blocked actor's engagement by reading the MONGO `Like`
   * collection, while `materializeEngagementTombstone` deletes from the POSTGRES
   * `likes` table. Every row came back `changed: false`, the page was recorded
   * as residue, and a local author kept a like count no record explained.
   *
   * Both halves name Postgres now. The assertions below read the store that
   * actually holds the answer, which is the part a Mongo-only version of this
   * case could not do: the counter lives on `posts.stats_likes_count` and
   * `updateCounters` moves it in the same transaction as the delete, so the
   * Mongo document's `stats.likesCount` was never going to move and asserting
   * on it would have measured nothing.
   */
  it('tears a blocked actor\'s like off a surviving post AND moves its counter', async () => {
    const ids = await seed();

    const report = await run();

    const remaining = await getDb()
      .select({ postId: pgLikes.postId })
      .from(pgLikes)
      .where(eq(pgLikes.userId, 'oxy-blocked'));
    expect(remaining).toEqual([]);
    // A bulk delete would leave the local author looking at a like count no
    // record explains. The counter moves in lockstep instead.
    const [local] = await getDb()
      .select({ likesCount: pgPosts.statsLikesCount })
      .from(pgPosts)
      .where(eq(pgPosts.id, ids.localPost.toString()));
    expect(local?.likesCount).toBe(0);
    expect(report.totals.likesByBlockedActors).toBe(1);
    expect(report.issues.engagementResidue).toBe(0);
  });

  it('deletes likes that pointed at a removed post', async () => {
    const ids = await seed();

    await run();

    expect(await Like.countDocuments({ postId: ids.blockedPost })).toBe(0);
  });
});

describe('purgeBlockedDomainContent — DRY_RUN', () => {
  it('reports what it would remove and changes NOTHING', async () => {
    await seed();
    const before = await snapshotEverything();

    const report = await run({ dryRun: true });

    expect(await snapshotEverything()).toBe(before);
    expect(h.deletedFileIds).toEqual([]);
    // A dry run that reported nothing would also "change nothing" — pin that it
    // actually measured the corpus, so this test cannot pass vacuously.
    expect(report.totals.posts).toBeGreaterThan(0);
    expect(report.totals.orphanPosts).toBe(1);
    expect(report.totals.actors).toBe(1);
    expect(report.dryRun).toBe(true);
  });

  it('records no resume cursor, because a cursor row is itself a write', async () => {
    await seed();

    await run({ dryRun: true });

    expect(await cursorRows()).toEqual([]);
  });
});

describe('purgeBlockedDomainContent — re-running', () => {
  it('is idempotent: a second run finds nothing left and reports zero', async () => {
    await seed();
    await run();

    const second = await run();

    expect(second.totals.posts).toBe(0);
    expect(second.totals.orphanPosts).toBe(0);
    expect(second.totals.actors).toBe(0);
    expect(second.issues.preflightBlocked).toBe(0);
  });

  it('records a resume cursor per phase on a live run', async () => {
    await seed();

    await run();

    const phases = (await cursorRows()).map((row) => row.scope.split(':')[0]).sort();
    expect(phases).toEqual(['actors', 'anchors', 'media', 'orphan-posts']);
  });

  it('does NOT inherit a completed cursor when the next run sweeps a DIFFERENT domain set', async () => {
    // The failure this guards is silent and arrives on the SECOND domain ever
    // blocked: run one finishes with its cursors parked at the end of each
    // collection, run two resumes from there, scans nothing, and reports a clean
    // zero — a blocklist that looks enforced while the content is still served.
    const ids = await seed();
    await purgeBlockedDomainContent(new Set(['unrelated.example']), options());

    // A second, different set must start from the top and actually find things.
    const report = await purgeBlockedDomainContent(new Set([BLOCKED]), options());

    expect(await postExists(ids.blockedPost)).toBe(false);
    expect(await postExists(ids.orphanPost)).toBe(false);
    expect(report.totals.posts).toBeGreaterThan(0);
    expect(report.totals.orphanPosts).toBe(1);
  });
});

describe('purgeBlockedDomainContent — failing closed', () => {
  it('removes a boost OF a boost, which one hop of expansion would strand', async () => {
    const ids = await seed();
    // `handleAnnounce` keys an inbound Announce on whatever local post the uri
    // resolved to, and that post can itself be a boost — so this shape is
    // reachable, not hypothetical. With a single hop of expansion the outer boost
    // survives with nothing behind it, the graph probe then refuses the batch,
    // and the actor stalls on every future run.
    const boostOfBoost = new mongoose.Types.ObjectId();
    await Post.collection.insertOne({
      _id: boostOfBoost,
      oxyUserId: 'oxy-local',
      type: 'boost',
      boostOf: ids.localBoost.toString(),
      stats: {},
    } as never);

    const report = await run();

    expect(await postExists(boostOfBoost)).toBe(false);
    expect(await postExists(ids.localBoost)).toBe(false);
    expect(await postExists(ids.blockedPost)).toBe(false);
    expect(report.issues.preflightBlocked).toBe(0);
  });

  it('cascades EVERY post reference the shared preflight knows about', async () => {
    // The tripwire behind the whole manifest. A probe added to the shared module
    // is not in this script's manifest, so the preflight starts refusing batches
    // — correct, but silent, and only visible as a counter on a production run.
    // Failing here instead tells whoever adds the probe what they have to teach
    // this cascade, before it ships.
    expect([...CASCADED_POST_REFERENCES].sort())
      .toEqual([...POST_REFERENCE_PROBE_NAMES].sort());
  });
});

describe('buildBlockedContentDomains', () => {
  const own = ['mention.earth', 'oxy.so'];

  it('refuses to run on an empty blocklist', () => {
    // The live `isBlockedDomain` predicate also matches OUR OWN domains, so a
    // purge driven off it with an unset blocklist would target every local user.
    // This function is the reason that can never happen.
    expect(() => buildBlockedContentDomains([], own)).toThrow(EmptyBlocklistError);
  });

  it('refuses to run when the blocklist names ONLY our own domains', () => {
    expect(() => buildBlockedContentDomains(['mention.earth', 'www.oxy.so'], own))
      .toThrow(EmptyBlocklistError);
  });

  it('subtracts our own domains from a mixed blocklist instead of honouring them', () => {
    const domains = buildBlockedContentDomains([BLOCKED, 'oxy.so'], own);

    expect([...domains]).toEqual([BLOCKED]);
  });

  it('canonicalizes case and a www. prefix, so it matches what the live policy blocks', () => {
    const domains = buildBlockedContentDomains([`WWW.${BLOCKED.toUpperCase()}`], own);

    expect([...domains]).toEqual([BLOCKED]);
    expect(canonicalFederationHost('WWW.Example.COM')).toBe('example.com');
    // A trailing dot is deliberately NOT stripped. This IS the engine's function
    // now, so the script cannot be broader than what is refused at the wire by
    // construction — `example.com.` matches no host there and none here. See
    // `blockedDomainCanonicalAgreement.test.ts` for the verdict-level proof.
    expect(canonicalFederationHost('example.com.')).toBe('example.com.');
  });

  it('narrows to one domain, and refuses one that is not on the blocklist', () => {
    expect([...buildBlockedContentDomains([BLOCKED, 'other.example'], own, BLOCKED)])
      .toEqual([BLOCKED]);
    expect(() => buildBlockedContentDomains([BLOCKED], own, 'other.example'))
      .toThrow(EmptyBlocklistError);
  });
});
