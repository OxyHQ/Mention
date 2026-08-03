import { MongoMemoryServer } from 'mongodb-memory-server';
import { canonicalFederationHost } from '@oxyhq/federation';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, so it is erased before the hoisted `vi.unmock` below runs and does
// not pull the module in ahead of the dynamic imports.
import type { PurgeOptions, PurgeReport } from '../../scripts/purgeBlockedDomainContent';

/**
 * The blocked-domain purge, against REAL rows.
 *
 * Every claim this script makes is a claim about DATA that survives it — a local
 * user's post is still there, their reply still points where it pointed, a
 * non-blocked instance is untouched, a dry run changed nothing. A mocked model
 * cannot fail for any of those reasons: it returns whatever the mock was told to
 * return, so a purge that deleted the wrong store would pass a mock suite
 * unchanged. Only real rows can distinguish "did not delete it" from "was never
 * asked about it".
 *
 * ## What the Postgres port changed, and what this suite could not see before
 *
 * The known gap this file's header used to declare is closed. It read:
 *
 *   > This script still reads and deletes MONGO collections, but the deletion
 *   > preflight it runs probes POSTGRES — so the preflight is asking a different
 *   > store than the script deletes from, and it passes here for that reason
 *   > rather than because the corpus is clean.
 *
 * That is exactly the shape a green suite cannot report. Fourteen deletes named
 * collections nothing had written since those entities moved, so each removed
 * nothing and reported a truthful-looking zero — and `assertPostsSafeToDelete`
 * WAIVES those very probes on the strength of the cascade
 * (`CASCADED_POST_REFERENCES`), so the gate did not block either. The suite was
 * green because it seeded the same empty store the script deleted from.
 *
 * The fixture is Postgres now, and the reference rows below are seeded and then
 * asserted GONE — which is the assertion the old suite had no way to make.
 *
 * ## Mongo is still here, for exactly one collection
 *
 * `feed_interactions` is the one entity whose live writer is still Mongo
 * (`mtn/feed/FeedInteractionTracker.ts`), so the cascade deletes both stores and
 * this file runs a real in-memory Mongo to prove it deletes both. A STANDALONE
 * server suffices: the replica set the old fixture needed was for the engagement
 * teardown's transaction, and that transaction is Postgres's now.
 *
 * The repo-wide `setup.ts` replaces `mongoose.connect` with a no-op so no test
 * can open a connection by accident; this file opts out and imports everything
 * dynamically below the hoisted unmock.
 *
 * ## What is mocked, and why only this
 *
 * The Oxy S3 object store, because deleting cached media bytes is a network call
 * to another service. The mock RECORDS the file ids it was asked to delete, so
 * the ordering guarantee (bytes before the row that names them) is asserted
 * rather than assumed.
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
const { and, eq, inArray, like } = await import('drizzle-orm');
const { closePostgres, connectPostgres, getDb } = await import('../../db/postgres');
const {
  bookmarks: pgBookmarks,
  entityFollows: pgEntityFollows,
  likes: pgLikes,
  postSubscriptions: pgPostSubscriptions,
} = await import('../../db/schema/engagement');
const { notifications: pgNotifications } = await import('../../db/schema/discovery');
const { posts: pgPosts } = await import('../../db/schema/posts');
const { postAuthorships, postMedia, postMentions, postRecentRepliers } = await import(
  '../../db/schema/postContent'
);
const { polls: pgPolls } = await import('../../db/schema/polls');
const { articles: pgArticles } = await import('../../db/schema/articles');
const { postgates: pgPostgates, threadgates: pgThreadgates } = await import(
  '../../db/schema/gates'
);
const { feedInteractions: pgFeedInteractions } = await import('../../db/schema/feeds');
const { engagementOutbox: pgEngagementOutbox } = await import('../../db/schema/outbox');
const {
  contentLabels: pgContentLabels,
  labelers: pgLabelers,
  reports: pgReports,
} = await import('../../db/schema/moderation');
const { logger } = await import('../../utils/logger');
const {
  federatedActors,
  federatedDeliveryQueue,
  federatedFollows,
  federatedMediaCache,
} = await import('../../db/schema/federation').then((m) => ({
  federatedActors: m.federatedActors,
  federatedDeliveryQueue: m.federationDeliveryQueue,
  federatedFollows: m.federatedFollows,
  federatedMediaCache: m.federatedMediaCache,
}));
const { adminScriptCursors } = await import('../../db/schema/adminScripts');
const { FeedInteraction } = await import('../../models/FeedInteraction');
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
/**
 * Media a blocked actor's post embeds from a THIRD-PARTY host, already cached.
 *
 * Deliberately NOT on the blocked host: phase 3 sweeps the media cache by host,
 * so a blocked-host URL is reached whether or not the post cascade reads
 * `post_media.remote_url`, and a fixture using one cannot tell the two apart.
 * This row is reachable ONLY through the post that references it.
 */
const THIRD_PARTY_MEDIA_URL = 'https://cdn.example.org/embedded.jpg';
const ALLOWED_MEDIA_URL = `https://${ALLOWED}/media/2.jpg`;
const BLOCKED_POST_ACTIVITY_ID = `https://${BLOCKED}/notes/1`;

/** Every account id this file writes, so its teardown can name them all. */
const ACCOUNTS = ['oxy-local', 'oxy-blocked', 'oxy-remote', 'oxy-ghost', 'oxy-other'];

/**
 * Post ids, fixed and namespaced so every assertion names the row it seeded.
 *
 * Readable strings rather than ObjectId hex: `posts.id` is `text` and holds
 * either id space, and a fixture id that cannot be mistaken for a real one is
 * what lets the teardown below be scoped by prefix as well as by account.
 */
const P = {
  blockedPost: 'purge-test-blocked-post',
  blockedBoostOfLocal: 'purge-test-blocked-boost-of-local',
  orphanPost: 'purge-test-orphan-post',
  allowedPost: 'purge-test-allowed-post',
  localPost: 'purge-test-local-post',
  localReply: 'purge-test-local-reply',
  localQuote: 'purge-test-local-quote',
  localBoost: 'purge-test-local-boost',
} as const;

let server: MongoMemoryServer;
let labelerId: string;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'purge-blocked-domain' });
  await connectPostgres();
}, 180_000);

afterAll(async () => {
  await clearFixtures();
  await closePostgres();
  await mongoose.disconnect();
  await server.stop();
});

/**
 * Drop this file's rows.
 *
 * ONE Postgres database serves every test file in the run, so nothing here is a
 * bare `delete(table)`: every statement is scoped to this file's own account
 * ids, post-id prefix, domains or script name.
 *
 * Retried, because the post delete is a bulk write against `posts` while other
 * suites are writing it concurrently, and `posts` self-references itself four
 * times. An unretried bulk delete there loses a `40P01` often enough to look like
 * a flaky assertion somewhere else in the file.
 */
async function clearFixtures(): Promise<void> {
  const db = getDb();
  await FeedInteraction.deleteMany({});
  await withDeadlockRetry(() => db.delete(pgLikes).where(inArray(pgLikes.userId, ACCOUNTS)));
  await withDeadlockRetry(() =>
    db.delete(pgBookmarks).where(inArray(pgBookmarks.userId, ACCOUNTS)),
  );
  await db.delete(pgFeedInteractions).where(inArray(pgFeedInteractions.userId, ACCOUNTS));
  await db.delete(pgNotifications).where(inArray(pgNotifications.recipientId, ACCOUNTS));
  await db.delete(pgPostSubscriptions).where(inArray(pgPostSubscriptions.subscriberId, ACCOUNTS));
  await db.delete(pgEntityFollows).where(inArray(pgEntityFollows.userId, ACCOUNTS));
  // `postgates` and `threadgates` name a post by id and by uri but carry NO
  // foreign key to it, so they do NOT cascade with the post: they have to be
  // named here or the next seed collides on `postgates_post_uri_key`.
  await db.delete(pgPostgates).where(inArray(pgPostgates.createdBy, ACCOUNTS));
  await db.delete(pgThreadgates).where(inArray(pgThreadgates.createdBy, ACCOUNTS));
  await db.delete(pgReports).where(inArray(pgReports.reporter, ACCOUNTS));
  await db.delete(pgLabelers).where(inArray(pgLabelers.creatorId, ACCOUNTS));
  await db
    .delete(pgEngagementOutbox)
    .where(like(pgEngagementOutbox.id, 'purge-test-%'));
  await db
    .delete(federatedDeliveryQueue)
    .where(inArray(federatedDeliveryQueue.senderOxyUserId, ACCOUNTS));
  // Every child of a post cascades from it, so one delete clears the rest.
  await withDeadlockRetry(() => db.delete(pgPosts).where(like(pgPosts.id, '%purge-test%')));
  await db
    .delete(federatedMediaCache)
    .where(
      inArray(federatedMediaCache.remoteUrl, [
        BLOCKED_MEDIA_URL,
        THIRD_PARTY_MEDIA_URL,
        ALLOWED_MEDIA_URL,
      ]),
    );
  await db.delete(federatedFollows).where(inArray(federatedFollows.localUserId, ACCOUNTS));
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

async function postExists(id: string): Promise<boolean> {
  const rows = await getDb().select({ id: pgPosts.id }).from(pgPosts).where(eq(pgPosts.id, id));
  return rows.length === 1;
}

async function mediaCacheRows(remoteUrl: string): Promise<number> {
  const rows = await getDb()
    .select({ id: federatedMediaCache.id })
    .from(federatedMediaCache)
    .where(eq(federatedMediaCache.remoteUrl, remoteUrl));
  return rows.length;
}

beforeEach(async () => {
  h.deletedFileIds.length = 0;
  h.mediaCacheEnabled.value = true;
  h.deleteShouldFail.value = false;
  await clearFixtures();
});

afterEach(async () => {
  vi.clearAllMocks();
  await clearFixtures();
});

/**
 * A corpus with one of every interaction shape the policy decides on, PLUS one
 * row for every reference `CASCADED_POST_REFERENCES` claims to remove.
 *
 * The second half is the point of this fixture. Those thirteen probes are waived
 * by the preflight on this script's word, so a suite that never seeds them
 * cannot tell a cascade that cleans from one that deletes from an empty store —
 * which is what the previous version of this file was measuring.
 */
async function seed(): Promise<void> {
  const db = getDb();

  await db.insert(federatedActors).values([
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

  // The local post first: three other rows reference it.
  await db.insert(pgPosts).values([
    {
      id: P.localPost,
      oxyUserId: 'oxy-local',
      type: 'text',
      statsLikesCount: 1,
      statsBoostsCount: 1,
      statsFederatedBoostsCount: 1,
    },
    {
      id: P.blockedPost,
      oxyUserId: 'oxy-blocked',
      type: 'text',
      federationActorUri: BLOCKED_ACTOR_URI,
      federationActivityId: BLOCKED_POST_ACTIVITY_ID,
    },
    {
      // Blocked host, but no `federated_actors` row and an owner no actor
      // resolves to — what an actor-anchored count misses entirely.
      id: P.orphanPost,
      oxyUserId: 'oxy-ghost',
      type: 'text',
      federationActorUri: GHOST_ACTOR_URI,
      federationActivityId: `https://${BLOCKED}/notes/2`,
    },
    {
      id: P.allowedPost,
      oxyUserId: 'oxy-remote',
      type: 'text',
      federationActorUri: `https://${ALLOWED}/users/ok`,
      federationActivityId: `https://${ALLOWED}/notes/9`,
    },
  ]);
  await db.insert(pgPosts).values([
    {
      /**
       * A boost BY the blocked actor OF a surviving local post — the counter
       * case, and deliberately the row with NO denormalized `oxy_user_id`.
       *
       * The author predicate has two branches (`posts.oxy_user_id` and the
       * `post_authorships` join) because the raw federated insert path can omit
       * the projection. One row per branch is what makes dropping either branch
       * a failing test rather than a passing one.
       */
      id: P.blockedBoostOfLocal,
      type: 'boost',
      boostOf: P.localPost,
      federationActorUri: BLOCKED_ACTOR_URI,
      federationActivityId: `https://${BLOCKED}/announce/1`,
    },
    {
      id: P.localReply,
      oxyUserId: 'oxy-local',
      type: 'text',
      parentPostId: P.blockedPost,
      // `posts_reply_discriminator_check` is `parent_post_id is null or is_reply`
      // — a constraint the Mongo document had no counterpart for, so a fixture
      // translated field-for-field is refused rather than quietly wrong.
      isReply: true,
      threadId: P.blockedPost,
    },
    { id: P.localQuote, oxyUserId: 'oxy-local', type: 'text', quoteOf: P.blockedPost },
    { id: P.localBoost, oxyUserId: 'oxy-local', type: 'boost', boostOf: P.blockedPost },
  ]);

  await db.insert(postAuthorships).values({
    postId: P.blockedBoostOfLocal,
    oxyUserId: 'oxy-blocked',
    role: 'owner',
    status: 'accepted',
  });

  await db.insert(postMedia).values([
    { postId: P.blockedPost, position: 0, mediaId: BLOCKED_MEDIA_URL, type: 'image' },
    // The media cache already rewrote this one, so the origin URL survives only
    // in `remote_url` — the case a literal port of the Mongo `media[].id` read
    // would miss, and the one with bytes in our S3.
    {
      postId: P.blockedPost,
      position: 1,
      mediaId: 'oxy-file-id-cached',
      remoteUrl: THIRD_PARTY_MEDIA_URL,
      type: 'image',
    },
    { postId: P.allowedPost, position: 0, mediaId: ALLOWED_MEDIA_URL, type: 'image' },
  ]);

  // A local user's like ON blocked content, and the blocked actor's like on a
  // SURVIVING local post — the counter-preserving teardown's subject.
  await db.insert(pgLikes).values([
    { userId: 'oxy-local', postId: P.blockedPost, value: 1 },
    { userId: 'oxy-blocked', postId: P.localPost, value: 1 },
  ]);
  await db.insert(pgBookmarks).values({ userId: 'oxy-local', postId: P.blockedPost });

  await db.insert(pgNotifications).values([
    {
      id: 'purge-test-notification-entity',
      recipientId: 'oxy-local',
      actorId: 'oxy-other',
      entityId: P.blockedPost,
      entityType: 'post',
      type: 'like',
    },
    {
      id: 'purge-test-notification-unrelated',
      recipientId: 'oxy-local',
      actorId: 'oxy-other',
      entityId: P.localPost,
      entityType: 'post',
      type: 'like',
    },
  ]);

  // --- one row per waived reference probe ------------------------------------
  await db.insert(pgPolls).values({
    postId: P.blockedPost,
    question: 'q',
    createdBy: 'oxy-blocked',
    endsAt: new Date(Date.now() + 86_400_000),
  });
  await db
    .insert(pgArticles)
    .values({ postId: P.blockedPost, createdBy: 'oxy-blocked', title: 't', body: 'b' });
  await db
    .insert(pgPostgates)
    .values({ postId: P.blockedPost, postUri: BLOCKED_POST_ACTIVITY_ID, createdBy: 'oxy-blocked' });
  await db
    .insert(pgThreadgates)
    .values({ postId: P.blockedPost, postUri: BLOCKED_POST_ACTIVITY_ID, createdBy: 'oxy-blocked' });
  await db
    .insert(postRecentRepliers)
    .values([
      { postId: P.blockedPost, oxyUserId: 'oxy-local', repliedAt: new Date() },
      // The blocked actor's entry on a SURVIVING post — pulled, not deleted with
      // a projection.
      { postId: P.localPost, oxyUserId: 'oxy-blocked', repliedAt: new Date() },
    ]);
  await db.insert(postMentions).values([
    { postId: P.localPost, oxyUserId: 'oxy-blocked' },
    { postId: P.localReply, oxyUserId: 'oxy-blocked' },
  ]);
  await db.insert(pgEngagementOutbox).values({
    id: 'purge-test-engagement-event',
    kind: 'post.like',
    revision: 1,
    payloadActorOxyUserId: 'oxy-local',
    payloadPostId: P.blockedPost,
    payloadRelationshipId: 'purge-test-relationship',
    expiresAt: new Date(Date.now() + 86_400_000),
    /**
     * NOT due, and that is a claim about another file rather than about this one.
     *
     * `engagement_outbox` is drained GLOBALLY by `dispatchEngagementOutbox`, and
     * `engagementWritePath.test.ts` keeps its producers and its drainer in one
     * file precisely so its counts are deterministic. A due row written here is
     * claimed by that suite's dispatcher and reported as an extra `processed`, in
     * a file this one never touches. The purge deletes by post id whatever the
     * status, so backing the row off costs this fixture nothing.
     */
    availableAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(pgReports).values({
    reportedType: 'post',
    reportedId: P.blockedPost,
    reporter: 'oxy-local',
    categories: ['hate_speech'],
  });
  const [labeler] = await db
    .insert(pgLabelers)
    .values({ name: 'purge-test-labeler', creatorId: 'oxy-local' })
    .returning({ id: pgLabelers.id });
  labelerId = labeler.id;
  await db.insert(pgContentLabels).values({
    labelerId,
    targetType: 'post',
    targetId: P.blockedPost,
    labelSlug: 'nsfw',
    createdBy: 'oxy-local',
  });
  await db.insert(federatedDeliveryQueue).values({
    activityJson: { id: 'https://example.test/act/1', object: BLOCKED_POST_ACTIVITY_ID },
    targetInbox: 'https://example.test/inbox',
    senderOxyUserId: 'oxy-local',
    nextAttemptAt: new Date(),
  });
  // The split-store lane: BOTH halves seeded, because the cascade deletes both.
  await db.insert(pgFeedInteractions).values({
    userId: 'oxy-local',
    feedDescriptor: 'for_you',
    postUri: P.blockedPost,
    event: 'impression',
  });
  await FeedInteraction.create({
    userId: 'oxy-local',
    feedDescriptor: 'for_you',
    postUri: P.blockedPost,
    event: 'impression',
  });

  // Actor-scoped rows: a standing subscription and an entity follow.
  await db.insert(pgPostSubscriptions).values({
    subscriberId: 'oxy-local',
    authorId: 'oxy-blocked',
  });
  await db
    .insert(pgEntityFollows)
    .values({ userId: 'oxy-blocked', entityType: 'hashtag', entityId: 'cats' });

  await db.insert(federatedFollows).values([
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

  await db.insert(federatedMediaCache).values([
    { remoteUrl: BLOCKED_MEDIA_URL, state: 'cached', oxyFileId: 'file-blocked' },
    { remoteUrl: THIRD_PARTY_MEDIA_URL, state: 'cached', oxyFileId: 'file-embedded' },
    { remoteUrl: ALLOWED_MEDIA_URL, state: 'cached', oxyFileId: 'file-allowed' },
  ]);
}

function options(overrides: Partial<PurgeOptions> = {}): PurgeOptions {
  return { dryRun: false, resetCursor: false, ...overrides };
}

async function run(overrides: Partial<PurgeOptions> = {}): Promise<PurgeReport> {
  return purgeBlockedDomainContent(new Set([BLOCKED]), options(overrides));
}

/** Every row in every store the run can touch, order-independent. */
async function snapshotEverything(): Promise<string> {
  const db = getDb();
  const [
    postRows,
    likeRows,
    notificationRows,
    mediaRows,
    labelRows,
    reportRows,
    gateRows,
    interactionRows,
    subscriptionRows,
    actorRows,
    followRows,
    scopes,
  ] = await Promise.all([
    db.select().from(pgPosts).where(like(pgPosts.id, '%purge-test%')),
    db.select().from(pgLikes).where(inArray(pgLikes.userId, ACCOUNTS)),
    db.select().from(pgNotifications).where(inArray(pgNotifications.recipientId, ACCOUNTS)),
    db.select().from(federatedMediaCache),
    db.select().from(pgContentLabels).where(inArray(pgContentLabels.createdBy, ACCOUNTS)),
    db.select().from(pgReports).where(inArray(pgReports.reporter, ACCOUNTS)),
    db.select().from(pgPostgates).where(inArray(pgPostgates.createdBy, ACCOUNTS)),
    db.select().from(pgFeedInteractions).where(inArray(pgFeedInteractions.userId, ACCOUNTS)),
    db.select().from(pgPostSubscriptions).where(inArray(pgPostSubscriptions.subscriberId, ACCOUNTS)),
    db.select().from(federatedActors).where(inArray(federatedActors.domain, [BLOCKED, ALLOWED])),
    db.select().from(federatedFollows).where(inArray(federatedFollows.localUserId, ACCOUNTS)),
    cursorRows(),
  ]);
  const mongoInteractions = await FeedInteraction.find({}).lean();
  return JSON.stringify([
    postRows.map((row) => `${row.id}|${row.statsBoostsCount}|${row.statsLikesCount}`).sort(),
    likeRows.map((row) => `${row.userId}|${row.postId}`).sort(),
    notificationRows.map((row) => row.id).sort(),
    mediaRows.map((row) => row.remoteUrl).sort(),
    labelRows.map((row) => row.targetId).sort(),
    reportRows.map((row) => row.reportedId).sort(),
    gateRows.map((row) => row.postId).sort(),
    interactionRows.map((row) => row.postUri).sort(),
    subscriptionRows.map((row) => `${row.subscriberId}|${row.authorId}`).sort(),
    actorRows.map((row) => row.uri).sort(),
    followRows.map((row) => `${row.localUserId}|${row.remoteActorUri}`).sort(),
    mongoInteractions.length,
    scopes.map((row) => row.scope).sort(),
  ]);
}

describe('purgeBlockedDomainContent — what it removes', () => {
  it('removes a blocked domain\'s posts, actor row, follow edge and cached media', async () => {
    await seed();

    const report = await run();

    expect(await postExists(P.blockedPost)).toBe(false);
    expect(await postExists(P.blockedBoostOfLocal)).toBe(false);
    expect(await actorsOnDomain(BLOCKED)).toBe(0);
    expect(await followsOfActor(BLOCKED_ACTOR_URI)).toBe(0);
    expect(await mediaCacheRows(BLOCKED_MEDIA_URL)).toBe(0);
    expect(report.issues.preflightBlocked).toBe(0);
    expect(report.issues.cascadeResidue).toBe(0);
  });

  /**
   * The assertion the previous fixture could not make.
   *
   * Each of these thirteen references is WAIVED by `assertPostsSafeToDelete` on
   * this cascade's word, so each one deleted from the wrong store was a row left
   * behind by a gate that had already cleared it. Asserted as rows AND as
   * counters, because a delete that removed the rows without recording them
   * would still hand the operator a table of zeros.
   */
  it('removes every post reference the preflight waived on its word', async () => {
    await seed();

    const report = await run();

    const db = getDb();
    const survivors = await Promise.all([
      db.select().from(pgPolls).where(eq(pgPolls.postId, P.blockedPost)),
      db.select().from(pgArticles).where(eq(pgArticles.postId, P.blockedPost)),
      db.select().from(pgPostgates).where(eq(pgPostgates.postId, P.blockedPost)),
      db.select().from(pgThreadgates).where(eq(pgThreadgates.postId, P.blockedPost)),
      db.select().from(postRecentRepliers).where(eq(postRecentRepliers.postId, P.blockedPost)),
      db
        .select()
        .from(pgEngagementOutbox)
        .where(eq(pgEngagementOutbox.payloadPostId, P.blockedPost)),
      db
        .select()
        .from(pgReports)
        .where(and(eq(pgReports.reportedType, 'post'), eq(pgReports.reportedId, P.blockedPost))),
      db
        .select()
        .from(pgContentLabels)
        .where(
          and(eq(pgContentLabels.targetType, 'post'), eq(pgContentLabels.targetId, P.blockedPost)),
        ),
      db.select().from(pgFeedInteractions).where(eq(pgFeedInteractions.postUri, P.blockedPost)),
      db.select().from(pgLikes).where(eq(pgLikes.postId, P.blockedPost)),
      db.select().from(pgBookmarks).where(eq(pgBookmarks.postId, P.blockedPost)),
      db.select().from(federatedDeliveryQueue),
      db
        .select()
        .from(pgNotifications)
        .where(eq(pgNotifications.entityId, P.blockedPost)),
    ]);
    expect(survivors.map((rows) => rows.length)).toEqual(Array(13).fill(0));

    // And the counts say so, one per lane.
    expect(report.totals).toMatchObject({
      polls: 1,
      articles: 1,
      postgates: 1,
      threadgates: 1,
      recentReplierProjections: 1,
      engagementOutbox: 1,
      reports: 1,
      contentLabels: 1,
      federationDeliveries: 1,
      likesOnRemovedPosts: 1,
      bookmarksOnRemovedPosts: 1,
      notificationsByEntity: 1,
    });
  });

  it('deletes the Mongo feed interactions too, because that writer has not ported', async () => {
    await seed();

    const report = await run();

    // The one entity whose live writer is still Mongo while its Postgres table
    // is backfilled and probed. Deleting either store alone leaves real rows
    // behind — Postgres-only silently, Mongo-only as a residue failure.
    expect(await FeedInteraction.countDocuments({ postUri: P.blockedPost })).toBe(0);
    expect(report.totals.feedInteractions).toBe(2);
    expect(report.issues.cascadeResidue).toBe(0);
  });

  it('de-links a blocked actor from surviving posts and projections', async () => {
    await seed();

    const report = await run();

    const db = getDb();
    // `mentions[]` and `repliers[]` are child TABLES now: the rows naming this
    // actor go, and the posts they named do not.
    expect(
      await db.select().from(postMentions).where(eq(postMentions.oxyUserId, 'oxy-blocked')),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(postRecentRepliers)
        .where(eq(postRecentRepliers.oxyUserId, 'oxy-blocked')),
    ).toEqual([]);
    expect(await postExists(P.localPost)).toBe(true);
    // Counted as POSTS, not rows — two posts carried a mention of this actor.
    expect(report.totals.mentionsDelinked).toBe(2);
    expect(report.totals.recentReplierEntriesPulled).toBe(1);
  });

  it('removes a standing post subscription naming the blocked actor', async () => {
    /**
     * The delete that could never have matched. It read
     * `{ postId: { $in: … } }` inside the POST cascade, and `PostSubscription`
     * is `(subscriberId, authorId)` — it has no `postId`. Mongoose passes an
     * unknown path straight through, so the query was well-formed, matched
     * nothing, and reported `postSubscriptions: 0` on every run since the script
     * was written.
     */
    await seed();

    const report = await run();

    expect(
      await getDb()
        .select()
        .from(pgPostSubscriptions)
        .where(eq(pgPostSubscriptions.authorId, 'oxy-blocked')),
    ).toEqual([]);
    expect(report.totals.postSubscriptions).toBe(1);
  });

  it('removes a post whose actor row is GONE — the case an actor-anchored count misses', async () => {
    await seed();

    const report = await run();

    expect(await postExists(P.orphanPost)).toBe(false);
    // Attributed separately so a review can see it was NOT part of the naive
    // "posts by actors we hold from that domain" figure.
    expect(report.totals.orphanPosts).toBe(1);
    expect(report.byDomain.get(BLOCKED)?.orphanPosts).toBe(1);
  });

  it('deletes the cached BYTES before the row that names them', async () => {
    await seed();

    await run();

    expect(h.deletedFileIds).toContain('file-blocked');
    // Reached ONLY through `post_media.remote_url` — the column that holds the
    // origin once the cache has rewritten `media_id` to an Oxy file id. Its host
    // is not blocked, so the media phase never sees it; the post that embedded it
    // is the only route.
    expect(h.deletedFileIds).toContain('file-embedded');
    expect(h.deletedFileIds).not.toContain('file-allowed');
  });

  it('keeps the row when the object store cannot delete, and fails the run', async () => {
    await seed();
    h.deleteShouldFail.value = true;

    const report = await run();

    // A row deleted before its bytes is an S3 object nothing can ever name again.
    expect(await mediaCacheRows(BLOCKED_MEDIA_URL)).toBe(1);
    expect(report.issues.mediaObjectDeleteFailed).toBeGreaterThan(0);
  });

  it('logs WHY the delete failed, not just how many did', async () => {
    // The count alone says objects from a blocked domain survived the purge but
    // not what to do about it — a missing key, a permissions failure and an
    // outage each need a different response, and this log is the only record
    // that the delete was ever attempted.
    await seed();
    h.deleteShouldFail.value = true;
    const warn = vi.spyOn(logger, 'warn');

    await run();

    const reasons = warn.mock.calls
      .map(([, meta]) => (meta as { reasons?: unknown } | undefined)?.reasons)
      .find((value): value is string[] => Array.isArray(value));
    expect(reasons).toEqual(['media store refused the delete']);
  });

  it('says so when the media cache is disabled, instead of failing silently', async () => {
    // This increments the SAME counter the delete failures do, so without a log
    // a run that never attempted a delete is indistinguishable from one the
    // object store refused — same number, entirely different cause.
    await seed();
    h.mediaCacheEnabled.value = false;
    const warn = vi.spyOn(logger, 'warn');

    const report = await run();

    expect(report.issues.mediaObjectDeleteFailed).toBeGreaterThan(0);
    expect(warn.mock.calls.some(([message]) => String(message).includes('media cache is disabled')))
      .toBe(true);
  });
});

describe('purgeBlockedDomainContent — what it must NEVER remove', () => {
  it('leaves a local user\'s own post alone', async () => {
    await seed();

    await run();

    expect(await postExists(P.localPost)).toBe(true);
  });

  it('leaves local posts alone even when handed a domain set naming OUR OWN domain', async () => {
    // `buildBlockedContentDomains` makes this set impossible to construct, and
    // its own tests cover that. This asserts the SECOND, independent property
    // underneath it: a post is only ever a candidate if it carries a
    // `federation_actor_uri` or is owned by a blocked actor, so local content is
    // out of reach even if the first line of defence were wrong. Two independent
    // guards, because the cost of both failing is every local user's content.
    await seed();
    const ownDomain = canonicalFederationHost(FEDERATION_DOMAIN);

    await purgeBlockedDomainContent(new Set([ownDomain]), options());

    expect(await postExists(P.localPost)).toBe(true);
    expect(await postExists(P.localReply)).toBe(true);
    expect(await postExists(P.localQuote)).toBe(true);
    expect(
      await getDb().select().from(pgPosts).where(eq(pgPosts.oxyUserId, 'oxy-local')),
    ).toHaveLength(4);
  });

  it('leaves a non-blocked instance completely alone', async () => {
    await seed();

    await run();

    expect(await postExists(P.allowedPost)).toBe(true);
    expect(await actorsOnDomain(ALLOWED)).toBe(1);
    expect(await mediaCacheRows(ALLOWED_MEDIA_URL)).toBe(1);
    expect(await followsOfActor(`https://${ALLOWED}/users/ok`)).toBe(1);
  });

  it('keeps a local reply and does NOT rewrite where it points', async () => {
    await seed();

    const report = await run();

    /**
     * `parent_post_id` and `thread_id` are `ON DELETE SET NULL`, so the reference
     * is ERASED by the database rather than left dangling as it was in Mongo.
     * That is the trade `allowDanglingReplyReferences` exists to state, and it is
     * why the post itself surviving is the assertion: hydration soft-fails a
     * missing parent, so the reply renders and loses its "Replying to @…" handle.
     * Re-rooting it would rewrite a real user's post to remove someone else's.
     */
    const [reply] = await getDb()
      .select({ id: pgPosts.id, parentPostId: pgPosts.parentPostId })
      .from(pgPosts)
      .where(eq(pgPosts.id, P.localReply));
    expect(reply).toBeDefined();
    expect(reply.parentPostId).toBeNull();
    expect(report.totals.repliesByOthersKept).toBe(1);
    expect(report.totals.threadRootsKept).toBe(1);
  });

  it('keeps a local quote and does NOT rewrite where it points', async () => {
    await seed();

    const report = await run();

    expect(await postExists(P.localQuote)).toBe(true);
    expect(report.totals.quotesByOthersKept).toBe(1);
  });

  it('keeps an unrelated notification', async () => {
    await seed();

    await run();

    const remaining = await getDb()
      .select({ id: pgNotifications.id })
      .from(pgNotifications)
      .where(inArray(pgNotifications.recipientId, ACCOUNTS));
    expect(remaining.map((row) => row.id)).toEqual(['purge-test-notification-unrelated']);
  });
});

describe('purgeBlockedDomainContent — the boost policy', () => {
  it('deletes a LOCAL user\'s boost of removed content', async () => {
    await seed();

    const report = await run();

    // A boost has an empty body and renders entirely from its original; kept, it
    // would be a permanent placeholder card with nothing behind it.
    expect(await postExists(P.localBoost)).toBe(false);
    expect(report.totals.boostsByOthers).toBe(1);
  });

  it('repairs the boost counters on a SURVIVING post it took a boost from', async () => {
    await seed();

    await run();

    const [local] = await getDb()
      .select({
        boosts: pgPosts.statsBoostsCount,
        federatedBoosts: pgPosts.statsFederatedBoostsCount,
      })
      .from(pgPosts)
      .where(eq(pgPosts.id, P.localPost));
    expect(local.boosts).toBe(0);
    expect(local.federatedBoosts).toBe(0);
  });
});

describe('purgeBlockedDomainContent — the engagement policy', () => {
  it('tears a blocked actor\'s like off a surviving post AND moves its counter', async () => {
    await seed();

    const report = await run();

    expect(
      await getDb().select().from(pgLikes).where(eq(pgLikes.userId, 'oxy-blocked')),
    ).toEqual([]);
    // A bulk delete would leave the local author looking at a like count no
    // record explains. The counter moves in lockstep instead.
    const [local] = await getDb()
      .select({ likesCount: pgPosts.statsLikesCount })
      .from(pgPosts)
      .where(eq(pgPosts.id, P.localPost));
    expect(local.likesCount).toBe(0);
    expect(report.totals.likesByBlockedActors).toBe(1);
    expect(report.issues.engagementResidue).toBe(0);
  });

  it('removes an entity follow the blocked actor held', async () => {
    await seed();

    const report = await run();

    expect(
      await getDb()
        .select()
        .from(pgEntityFollows)
        .where(eq(pgEntityFollows.userId, 'oxy-blocked')),
    ).toEqual([]);
    expect(report.totals.entityFollows).toBe(1);
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
    expect(report.totals.reports).toBe(1);
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

  it('RESUMES from an opaque cursor rather than restarting the sweep', async () => {
    /**
     * What replaced the `toMongoCursor` tripwire.
     *
     * Two tests used to live here, both pinning the LOUD half of a transition
     * that has now happened: a Mongo-paged phase THREW on a cursor that was not
     * an ObjectId, and a boost target whose id could not be cast was COUNTED as a
     * run issue. Both guarded the moment `posts` moved, and both said in their own
     * docblocks that they had to go WITH the port rather than be relaxed — the
     * alternative being a guard that answers "start from the beginning" and
     * silently re-walks the corpus on every attempt of a destructive sweep.
     *
     * The property that outlives them is the positive one: a stored cursor is an
     * opaque `text` id, and a resumed phase starts AFTER it rather than at the
     * top. Asserted by parking the orphan-posts cursor past every row this file
     * seeded and requiring the next run to find nothing — a phase that restarted
     * would find the orphan post again.
     */
    await seed();
    await run();
    const orphanScope = (await cursorRows()).find((row) => row.scope.startsWith('orphan-posts'));
    expect(orphanScope, 'the orphan-posts phase recorded a cursor').toBeDefined();
    // A uuid v7 — exactly what a post created after the cutover carries, and what
    // the deleted guard would have refused.
    await getDb()
      .update(adminScriptCursors)
      .set({ cursor: '01924f3c-0000-7000-8000-0123456789ab', completed: false })
      .where(eq(adminScriptCursors.id, orphanScope!.id));
    /**
     * One orphan post, with an id that sorts BEFORE that cursor.
     *
     * The keyset is `posts.id` as TEXT, so what "before" means is byte order, not
     * time — and a uuid v7 always starts with a hex digit, so `purge-test-…`
     * would sort after it and be scanned however well the cursor worked. Choosing
     * the id is what makes this test able to fail.
     *
     * Re-seeding the whole fixture is not an option either: `seed()` re-inserts
     * the ALLOWED actor, which no run removes, and collides on
     * `federated_actors_uri_key`.
     */
    const skipped = '0000-purge-test-resume-orphan';
    await getDb().insert(pgPosts).values({
      id: skipped,
      oxyUserId: 'oxy-ghost',
      type: 'text',
      federationActorUri: GHOST_ACTOR_URI,
      federationActivityId: `https://${BLOCKED}/notes/3`,
    });

    const report = await run();

    // A phase that honoured the cursor skips this row; one that restarted — or
    // one whose guard refused the uuid and answered "start from the beginning" —
    // removes it.
    expect(await postExists(skipped)).toBe(true);
    expect(report.totals.orphanPosts).toBe(0);
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
    await seed();
    await purgeBlockedDomainContent(new Set(['unrelated.example']), options());

    // A second, different set must start from the top and actually find things.
    const report = await purgeBlockedDomainContent(new Set([BLOCKED]), options());

    expect(await postExists(P.blockedPost)).toBe(false);
    expect(await postExists(P.orphanPost)).toBe(false);
    expect(report.totals.posts).toBeGreaterThan(0);
    expect(report.totals.orphanPosts).toBe(1);
  });
});

describe('purgeBlockedDomainContent — failing closed', () => {
  it('removes a boost OF a boost, which one hop of expansion would strand', async () => {
    await seed();
    // `handleAnnounce` keys an inbound Announce on whatever local post the uri
    // resolved to, and that post can itself be a boost — so this shape is
    // reachable, not hypothetical. With a single hop of expansion the outer boost
    // survives with nothing behind it, the graph probe then refuses the batch,
    // and the actor stalls on every future run.
    const boostOfBoost = 'purge-test-boost-of-boost';
    await getDb()
      .insert(pgPosts)
      .values({ id: boostOfBoost, oxyUserId: 'oxy-local', type: 'boost', boostOf: P.localBoost });

    const report = await run();

    expect(await postExists(boostOfBoost)).toBe(false);
    expect(await postExists(P.localBoost)).toBe(false);
    expect(await postExists(P.blockedPost)).toBe(false);
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
