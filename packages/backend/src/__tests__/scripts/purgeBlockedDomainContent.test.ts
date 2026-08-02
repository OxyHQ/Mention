import { MongoMemoryReplSet } from 'mongodb-memory-server';
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
const { Post } = await import('../../models/Post');
const { default: Like } = await import('../../models/Like');
const { default: Notification } = await import('../../models/Notification');
const { default: FederatedActor } = await import('../../models/FederatedActor');
const { default: FederatedFollow } = await import('../../models/FederatedFollow');
const { default: FederatedMediaCache } = await import('../../models/FederatedMediaCache');
const { default: ContentLabel } = await import('../../models/ContentLabel');
const { AdminScriptCursor } = await import('../../models/AdminScriptCursor');
const { POST_REFERENCE_PROBE_NAMES } = await import('../../scripts/lib/adminDeletionPreflight');
const { FEDERATION_DOMAIN } = await import('../../connectors/activitypub/constants');
const {
  buildBlockedContentDomains,
  canonicalDomain,
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
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  h.deletedFileIds.length = 0;
  h.mediaCacheEnabled.value = true;
  h.deleteShouldFail.value = false;
  await Promise.all(
    [Post, Like, Notification, FederatedActor, FederatedFollow, FederatedMediaCache, ContentLabel,
      AdminScriptCursor].map((model) => model.deleteMany({})),
  );
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

  await FederatedActor.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(),
      protocol: 'activitypub',
      uri: BLOCKED_ACTOR_URI,
      username: 'bad',
      domain: BLOCKED,
      acct: `bad@${BLOCKED}`,
      oxyUserId: 'oxy-blocked',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      protocol: 'activitypub',
      uri: `https://${ALLOWED}/users/ok`,
      username: 'ok',
      domain: ALLOWED,
      acct: `ok@${ALLOWED}`,
      oxyUserId: 'oxy-remote',
    },
  ] as never);

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
    // A local user's like ON blocked content — dies with the post.
    { _id: new mongoose.Types.ObjectId(), userId: 'oxy-local', postId: ids.blockedPost, value: 1 },
    // The blocked actor's like on a SURVIVING local post — counter teardown.
    { _id: new mongoose.Types.ObjectId(), userId: 'oxy-blocked', postId: ids.localPost, value: 1 },
  ] as never);

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

  await FederatedFollow.collection.insertMany([
    {
      _id: new mongoose.Types.ObjectId(),
      localUserId: 'oxy-local',
      remoteActorUri: BLOCKED_ACTOR_URI,
      direction: 'inbound',
      status: 'accepted',
    },
    {
      _id: new mongoose.Types.ObjectId(),
      localUserId: 'oxy-local',
      remoteActorUri: `https://${ALLOWED}/users/ok`,
      direction: 'outbound',
      status: 'accepted',
    },
  ] as never);

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
  const models = [Post, Like, Notification, FederatedActor, FederatedFollow, FederatedMediaCache,
    ContentLabel, AdminScriptCursor];
  const collections = await Promise.all(
    models.map(async (model) => {
      const docs = await model.collection.find({}).sort({ _id: 1 }).toArray();
      return [model.collection.collectionName, docs] as const;
    }),
  );
  return JSON.stringify(collections);
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
    expect(await FederatedActor.countDocuments({ domain: BLOCKED })).toBe(0);
    expect(await FederatedFollow.countDocuments({ remoteActorUri: BLOCKED_ACTOR_URI })).toBe(0);
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
    const ownDomain = canonicalDomain(FEDERATION_DOMAIN);

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
    expect(await FederatedActor.countDocuments({ domain: ALLOWED })).toBe(1);
    expect(await FederatedMediaCache.countDocuments({ remoteUrl: ALLOWED_MEDIA_URL })).toBe(1);
    expect(await FederatedFollow.countDocuments({ remoteActorUri: `https://${ALLOWED}/users/ok` }))
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
  it('tears a blocked actor\'s like off a surviving post AND moves its counter', async () => {
    const ids = await seed();

    const report = await run();

    expect(await Like.countDocuments({ userId: 'oxy-blocked' })).toBe(0);
    // A bulk delete would leave the local author looking at a like count no
    // record explains. The counter moves in lockstep instead.
    const local = await Post.findById(ids.localPost).lean();
    expect(local?.stats?.likesCount).toBe(0);
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

    expect(await AdminScriptCursor.countDocuments({})).toBe(0);
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

    const phases = (await AdminScriptCursor.find({ script: 'purgeBlockedDomainContent' }).lean())
      .map((row) => row.scope.split(':')[0])
      .sort();
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
    expect(canonicalDomain('WWW.Example.COM.')).toBe('example.com');
  });

  it('narrows to one domain, and refuses one that is not on the blocklist', () => {
    expect([...buildBlockedContentDomains([BLOCKED, 'other.example'], own, BLOCKED)])
      .toEqual([BLOCKED]);
    expect(() => buildBlockedContentDomains([BLOCKED], own, 'other.example'))
      .toThrow(EmptyBlocklistError);
  });
});
