import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * Tests for the irreversible `purgeGoneFederatedActors` one-shot.
 *
 * ## What is real, and why each piece has to be
 *
 * **The posts are real rows.** They used to be a `models/Post` double whose
 * `find` was routed by query SHAPE — the test inspected the filter and decided
 * what to hand back — so "X's posts and their boosts were deleted" was an
 * assertion about the double. The script reads and deletes `posts` through
 * drizzle now, so each case writes the posts it is about and asserts which rows
 * survive.
 *
 * **The preflight is real.** `assertActorSafeToDelete` is the gate whose whole
 * job is answering "is this safe to delete", and a gate that consults a store
 * nothing writes answers *safe* for everything, silently, in the permissive
 * direction. Mocking it means the suite cannot tell a working gate from an
 * absent one, so it runs for real here: the blocked case writes a REAL
 * uncascaded reference and the happy cases pass the real probes.
 *
 * **The MTN chain rows are real.** A purge that misses a user's signed chain
 * leaves their whole history behind under an identity that no longer exists.
 *
 * ## What is still a double, and why that is not a hedge
 *
 * The remaining Mongo models and three federation repositories keep doubles,
 * because this file also asserts the ORDER of a fourteen-step destructive
 * cascade — above all that the actor anchor is dropped LAST, only after the Oxy
 * identity delete is confirmed, so a failed Oxy call always leaves a retryable
 * row. A call log is the only place that order is observable. Nothing here
 * asserts anything about the SHAPE of a query.
 *
 * `signedFetch`, `deleteFederatedActorIdentity`, `connectToDatabase` and
 * `mongoose.disconnect` are stubbed because they are the network and the other
 * database.
 */

interface ActorRow {
  /** The cursor the paging loop advances on. */
  id: string;
  uri: string;
  acct: string;
  oxyUserId?: string;
}
interface SignedConfig {
  status: number;
  ok: boolean;
  statusText: string;
  throwErr?: Error;
}
type OxyOutcome = 'deleted' | 'absent' | 'skipped' | 'failed';

const h = vi.hoisted(() => {
  const callLog: string[] = [];
  const state: {
    actors: ActorRow[];
    signed: SignedConfig;
    oxyOutcome: OxyOutcome;
    /** Mention rows still present when the Oxy identity delete was issued. */
    refsAtOxyDelete: number | null;
  } = {
    actors: [],
    signed: { status: 410, ok: false, statusText: 'Gone' },
    oxyOutcome: 'deleted',
    refsAtOxyDelete: null,
  };

  const federatedActor = {
    countActors: vi.fn(async () => state.actors.length),
    scanActors: vi.fn(async (_filter: unknown, page: { afterId?: string }) =>
      (page.afterId ? [] : state.actors),
    ),
    updateActorSuspended: vi.fn(async () => {
      callLog.push('FederatedActor.updateOne');
    }),
    deleteActorsByUris: vi.fn(async () => {
      callLog.push('FederatedActor.deleteOne');
      return 1;
    }),
  };

  const federatedFollowRepo = {
    findFollows: vi.fn(async () => [{ id: 'f1' }]),
    deleteFollowsFor: vi.fn(async () => {
      callLog.push('FederatedFollow');
      return 1;
    }),
  };

  const actorKeyPairRepo = {
    hasActorKeyPair: vi.fn(async () => true),
    deleteActorKeyPair: vi.fn(async () => {
      callLog.push('ActorKeyPair');
      return 1;
    }),
  };

  const oxyDelete = vi.fn(async (_id: string): Promise<OxyOutcome> => {
    callLog.push('oxy-delete');
    // The ORDER assertion, taken from real rows rather than from labels: at the
    // moment the irreversible Oxy call happens, every Mention reference must
    // already be gone. `snapshotMentionRefs` is a function declaration below, so
    // it is hoisted into scope here.
    state.refsAtOxyDelete = await snapshotMentionRefs();
    return state.oxyOutcome;
  });

  const signedFetch = vi.fn(async (_uri: string, _ct: string) => {
    if (state.signed.throwErr) throw state.signed.throwErr;
    return { status: state.signed.status, ok: state.signed.ok, statusText: state.signed.statusText };
  });
  return {
    callLog,
    state,
    federatedActor,
    federatedFollowRepo,
    actorKeyPairRepo,
    oxyDelete,
    signedFetch,
    closeAdminScriptResources: vi.fn(async () => undefined),
  };
});

vi.mock('../../utils/database', () => ({ connectToDatabase: vi.fn(async () => undefined) }));
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../connectors/activitypub/helpers', () => ({ signedFetch: h.signedFetch }));
vi.mock('../../connectors/activitypub/constants', () => ({ AP_CONTENT_TYPE: 'application/activity+json' }));
vi.mock('../../connectors/identity', () => ({ deleteFederatedActorIdentity: h.oxyDelete }));
vi.mock('../../scripts/lib/adminScriptLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scripts/lib/adminScriptLifecycle')>()),
  closeAdminScriptResources: h.closeAdminScriptResources,
}));

vi.mock('../../db/federation/actorRepository', () => ({
  countActors: h.federatedActor.countActors,
  scanActors: h.federatedActor.scanActors,
  updateActorSuspended: h.federatedActor.updateActorSuspended,
  deleteActorsByUris: h.federatedActor.deleteActorsByUris,
}));
vi.mock('../../db/federation/followRepository', () => ({
  findFollows: h.federatedFollowRepo.findFollows,
  deleteFollowsFor: h.federatedFollowRepo.deleteFollowsFor,
  // `existsFollow` is the REAL preflight probe's reader and must keep working;
  // the two above are doubled only because the cascade ORDER is asserted.
  existsFollow: async () => false,
}));
vi.mock('../../db/federation/actorKeyPairRepository', () => ({
  hasActorKeyPair: h.actorKeyPairRepo.hasActorKeyPair,
  deleteActorKeyPair: h.actorKeyPairRepo.deleteActorKeyPair,
}));

vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return { ...actual, default: { ...actual.default, disconnect: vi.fn(async () => undefined) } };
});

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { bookmarks, entityFollows, likes } from '../../db/schema/engagement';
import { authorFollowerSnapshots, notifications } from '../../db/schema/discovery';
import { userBehaviors, userSettings } from '../../db/schema/userProfile';
import { userFeedPreferences } from '../../db/schema/feeds';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../db/schema/mtn';
import { posts } from '../../db/schema/posts';
import { uuidv7 } from '../../db/schema/columns';
import { loadPostRecord } from '../../db/posts/postRepository';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import purgeGoneFederatedActors from '../../scripts/purgeGoneFederatedActors';

/**
 * Every table the gone-actor cascade CLAIMS to clear for the purged owner, with
 * the predicate that finds its rows.
 *
 * One list, used by the seeder, the "everything went" assertion and the
 * ordering snapshot alike — so a table can never be seeded and then quietly left
 * out of the check, which is the shape of the bug this suite exists for.
 */
const OWNER_SCOPED_TABLES = [
  { name: 'likes', table: likes, id: likes.id, where: () => eq(likes.userId, OWNER) },
  {
    name: 'entity_follows',
    table: entityFollows,
    id: entityFollows.id,
    where: () => eq(entityFollows.userId, OWNER),
  },
  {
    name: 'notifications',
    table: notifications,
    id: notifications.id,
    where: () => eq(notifications.recipientId, OWNER),
  },
  {
    name: 'user_settings',
    table: userSettings,
    id: userSettings.id,
    where: () => eq(userSettings.oxyUserId, OWNER),
  },
  {
    name: 'author_follower_snapshots',
    table: authorFollowerSnapshots,
    id: authorFollowerSnapshots.id,
    where: () => eq(authorFollowerSnapshots.oxyUserId, OWNER),
  },
  // The four with no Postgres WRITER yet. Seeded anyway: the step has to be
  // proven correct now, or the day a writer lands nothing flags that the purge
  // never covered it. Their emptiness in production is "not yet written", never
  // coverage.
  {
    name: 'user_behaviors',
    table: userBehaviors,
    id: userBehaviors.id,
    where: () => eq(userBehaviors.oxyUserId, OWNER),
  },
  {
    name: 'user_feed_preferences',
    table: userFeedPreferences,
    id: userFeedPreferences.id,
    where: () => eq(userFeedPreferences.oxyUserId, OWNER),
  },
  {
    name: 'mention_user_nodes',
    table: mentionUserNodes,
    id: mentionUserNodes.id,
    where: () => eq(mentionUserNodes.oxyUserId, OWNER),
  },
  {
    name: 'mention_node_ingest_witnesses',
    table: mentionNodeIngestWitnesses,
    id: mentionNodeIngestWitnesses.id,
    where: () => eq(mentionNodeIngestWitnesses.oxyUserId, OWNER),
  },
] as const;

/** How many owner-scoped rows survive, per table. */
async function survivingRefsByTable(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const entry of OWNER_SCOPED_TABLES) {
    const rows = await getDb().select({ id: entry.id }).from(entry.table).where(entry.where());
    out[entry.name] = rows.length;
  }
  return out;
}

/** The total, for the ordering snapshot taken inside the Oxy-delete double. */
async function snapshotMentionRefs(): Promise<number> {
  const byTable = await survivingRefsByTable();
  return Object.values(byTable).reduce((total, n) => total + n, 0);
}

/** One row in every table the cascade is responsible for. */
async function seedOwnerScopedRefs(postId: string): Promise<void> {
  const db = getDb();
  await db.insert(likes).values({ userId: OWNER, postId });
  await db.insert(entityFollows).values({
    userId: OWNER, entityType: 'hashtag', entityId: `purge-${scope.name}`,
  });
  await db.insert(notifications).values({
    id: uuidv7(),
    recipientId: OWNER,
    actorId: BOOSTER,
    type: 'like',
    entityType: 'post',
    entityId: postId,
    read: false,
  });
  await db.insert(userSettings).values({ oxyUserId: OWNER });
  await db.insert(authorFollowerSnapshots).values({ oxyUserId: OWNER, followerCount: 3 });
  await db.insert(userBehaviors).values({ oxyUserId: OWNER });
  await db.insert(userFeedPreferences).values({ oxyUserId: OWNER });
  await db.insert(mentionUserNodes).values({
    oxyUserId: OWNER,
    endpoint: `https://node.${scope.name}.test`,
    nodePublicKey: '04abc',
  });
  await db.insert(mentionNodeIngestWitnesses).values({
    oxyUserId: OWNER,
    recordId: `witness-${scope.name}`,
    witnessSignature: 'sig',
    ingestedAt: 1_700_000_000_000,
  });
}

/** Remove anything this suite wrote outside `posts` / the chain. */
async function clearOwnerScopedRefs(): Promise<void> {
  const db = getDb();
  for (const entry of OWNER_SCOPED_TABLES) {
    await db.delete(entry.table).where(entry.where());
  }
}

const scope = postScope('purge-gone-actors');
/** The purged actor's Oxy id. Namespaced: the REAL preflight probes shared tables. */
const OWNER = scope.user('gone');
/** A bystander whose boost of the purged actor's post also has to go. */
const BOOSTER = scope.user('booster');
/** The purged actor's URI. Namespaced for the same reason as {@link OWNER}. */
const ACTOR_URI = `https://purge-gone-actors.test/users/ghost`;

const originalArgv = process.argv;

/** Seed one signed record + the chain head for {@link OWNER}. */
async function seedChain(): Promise<void> {
  await getDb().insert(mentionSignedRecords).values({
    subjectDid: `did:web:oxy.so:u:${OWNER}`,
    oxyUserId: OWNER,
    type: 'app_record',
    envelope: { version: 2, type: 'app_record', subject: `did:web:oxy.so:u:${OWNER}` } as never,
    publicKey: '04abc',
    verified: true,
    seq: 0,
    prev: null,
    recordId: 'rid-purge-0',
  });
  await getDb().insert(mentionRepoHeads).values({
    oxyUserId: OWNER,
    subjectDid: `did:web:oxy.so:u:${OWNER}`,
    seq: 0,
    headRecordId: 'rid-purge-0',
    recordCount: 1,
  });
}

/** How many chain rows {@link OWNER} still has, as `[records, heads]`. */
async function chainRowCounts(): Promise<[number, number]> {
  const records = await getDb()
    .select({ id: mentionSignedRecords.id })
    .from(mentionSignedRecords)
    .where(eq(mentionSignedRecords.oxyUserId, OWNER));
  const heads = await getDb()
    .select({ id: mentionRepoHeads.id })
    .from(mentionRepoHeads)
    .where(eq(mentionRepoHeads.oxyUserId, OWNER));
  return [records.length, heads.length];
}

/**
 * One post by the purged actor, one boost of it by somebody else, and one post
 * by a bystander that must SURVIVE.
 *
 * The bystander post is the vacuity floor: without it, a cascade that deleted
 * the whole table would pass every assertion below.
 */
async function seedPostGraph(): Promise<{ authored: string; boost: string; bystander: string }> {
  const authored = await seedPost(scope, {
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    content: { variants: [{ source: 'author', text: 'a post by the gone actor', tag: 'en' }] },
  });
  const boost = await seedPost(scope, {
    oxyUserId: BOOSTER,
    authorship: [{ oxyUserId: BOOSTER, role: 'owner', status: 'accepted' }],
    type: PostType.BOOST,
    boostOf: authored.id,
    content: { variants: [{ source: 'author', text: '', tag: 'en' }] },
  });
  const bystander = await seedPost(scope, {
    oxyUserId: BOOSTER,
    authorship: [{ oxyUserId: BOOSTER, role: 'owner', status: 'accepted' }],
    visibility: PostVisibility.PUBLIC,
    content: { variants: [{ source: 'author', text: 'unrelated', tag: 'en' }] },
  });
  return { authored: authored.id, boost: boost.id, bystander: bystander.id };
}

/** Which of the supplied post ids still exist. */
async function survivingPostIds(ids: string[]): Promise<string[]> {
  const rows = await getDb().select({ id: posts.id }).from(posts).where(inArray(posts.id, ids));
  return rows.map((row) => row.id).sort();
}

function makeActor(): ActorRow {
  return {
    id: `actor-${scope.name}`,
    uri: ACTOR_URI,
    acct: `ghost@${scope.name}.test`,
    oxyUserId: OWNER,
  };
}

/**
 * A legacy anchor with no linked Oxy identity.
 *
 * A separate builder rather than `makeActor(undefined)`: a default parameter
 * treats an explicitly-passed `undefined` as absent, so that spelling silently
 * produces the OWNED actor and the test passes for the wrong reason (measured —
 * it did).
 */
function makeOwnerlessActor(): ActorRow {
  const actor = makeActor();
  delete actor.oxyUserId;
  return actor;
}

/** Run the one-shot with the given argv flags (default: a live run). */
async function run(args: string[] = []): Promise<void> {
  process.argv = ['bun', 'purgeGoneFederatedActors', ...args];
  await purgeGoneFederatedActors();
}

/** Assert every label is present and their first occurrences strictly ascend. */
function expectOrder(callLog: string[], labels: string[]): void {
  let prev = -1;
  for (const label of labels) {
    const idx = callLog.indexOf(label);
    expect(idx, `expected "${label}" in call log`).toBeGreaterThan(prev);
    prev = idx;
  }
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CONFIRM_ADMIN_MUTATION', 'purgeGoneFederatedActors');
  await getDb().delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, OWNER));
  await getDb().delete(mentionRepoHeads).where(eq(mentionRepoHeads.oxyUserId, OWNER));
  await getDb().delete(bookmarks).where(eq(bookmarks.userId, OWNER));
  await clearOwnerScopedRefs();
  h.callLog.length = 0;
  h.state.actors = [];
  h.state.signed = { status: 410, ok: false, statusText: 'Gone' };
  h.state.oxyOutcome = 'deleted';
  h.state.refsAtOxyDelete = null;
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`unexpected process.exit(${String(code)})`);
  });
});

afterEach(async () => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await getDb().delete(mentionSignedRecords).where(eq(mentionSignedRecords.oxyUserId, OWNER));
  await getDb().delete(mentionRepoHeads).where(eq(mentionRepoHeads.oxyUserId, OWNER));
  await getDb().delete(bookmarks).where(eq(bookmarks.userId, OWNER));
  await clearOwnerScopedRefs();
  await clearPostScope(scope);
});

describe('purgeGoneFederatedActors', () => {
  it('removes EVERY Mention reference before the irreversible Oxy identity delete', async () => {
    // The ordering guarantee, observed on REAL ROWS rather than on a call log.
    // A label pushed by a double proves the double was called; this proves the
    // rows were actually gone at the moment the Oxy call went out — which is the
    // only moment at which "the cascade ran first" means anything, because after
    // it the identity cannot be brought back.
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await seedOwnerScopedRefs(graph.bystander);
    expect(await snapshotMentionRefs()).toBe(OWNER_SCOPED_TABLES.length);

    await run();

    expect(h.state.refsAtOxyDelete).toBe(0);
    // …and the anchor had NOT yet been dropped when that snapshot was taken.
    expectOrder(h.callLog, ['FederatedFollow', 'oxy-delete', 'FederatedActor.deleteOne']);
  });

  it('clears every owner-scoped table the cascade is responsible for', async () => {
    // One assertion over the whole registry, so a failure NAMES the table that
    // was left behind instead of stopping at the first.
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await seedOwnerScopedRefs(graph.bystander);

    await run();

    const remaining = await survivingRefsByTable();
    expect(remaining).toEqual(
      Object.fromEntries(OWNER_SCOPED_TABLES.map((entry) => [entry.name, 0])),
    );
  });

  it('deletes the actor’s posts and their boosts, and nothing else', async () => {
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();

    await run();

    // The boost renders blank once its original is gone, so it goes with it —
    // while a bystander's own post is untouched.
    expect(await survivingPostIds([graph.authored, graph.boost, graph.bystander]))
      .toEqual([graph.bystander]);
  });

  it('finds a post through the authorship AUTHORITY, not the denormalized owner', async () => {
    // `posts.oxy_user_id` is a projection of the `owner` authorship row. A post
    // whose projection was never written is still the purged actor's, and a
    // cascade that only reads the projection leaves it behind for good.
    h.state.actors = [makeActor()];
    const orphaned = await seedPost(scope, {
      oxyUserId: null,
      authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
      content: { variants: [{ source: 'author', text: 'projection never written', tag: 'en' }] },
    });

    await run();

    expect(await survivingPostIds([orphaned.id])).toEqual([]);
  });

  it("removes the purged owner's signed chain and its head", async () => {
    h.state.actors = [makeActor()];
    await seedChain();
    expect(await chainRowCounts()).toEqual([1, 1]);

    await run();

    expect(await chainRowCounts()).toEqual([0, 0]);
  });

  it('drops the FederatedActor anchor LAST, strictly AFTER a confirmed Oxy identity delete', async () => {
    h.state.actors = [makeActor()];

    await run();

    const oxyIdx = h.callLog.indexOf('oxy-delete');
    expect(oxyIdx).toBeGreaterThanOrEqual(0);
    // Everything AFTER the Oxy delete is ONLY the anchor drop — nothing else, so the
    // anchor can never be dropped before the Oxy identity is confirmed gone.
    expect(h.callLog.slice(oxyIdx + 1)).toEqual(['FederatedActor.deleteOne']);
    expect(h.callLog[h.callLog.length - 1]).toBe('FederatedActor.deleteOne');
  });

  it('re-verify gate: a resurrected (200) actor is NOT purged and its tombstone is cleared', async () => {
    const actor = makeActor();
    h.state.actors = [actor];
    h.state.signed = { status: 200, ok: true, statusText: 'OK' };
    const graph = await seedPostGraph();

    await run();

    // The ONLY write is clearing the tombstone — nothing is deleted.
    expect(h.callLog).toEqual(['FederatedActor.updateOne']);
    expect(h.federatedActor.updateActorSuspended).toHaveBeenCalledWith(actor.id, false);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteActorsByUris).not.toHaveBeenCalled();
    expect(await survivingPostIds([graph.authored, graph.boost, graph.bystander])).toHaveLength(3);
  });

  it('unverified gate: a non-410 (404) actor is left fully intact — no deletes, no tombstone change', async () => {
    h.state.actors = [makeActor()];
    h.state.signed = { status: 404, ok: false, statusText: 'Not Found' };
    const graph = await seedPostGraph();

    await expect(run()).rejects.toThrow('unverified=1');

    expect(h.callLog).toEqual([]);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.updateActorSuspended).not.toHaveBeenCalled();
    expect(await survivingPostIds([graph.authored, graph.boost])).toHaveLength(2);
  });

  it('unverified gate: a transient re-verify error leaves the actor intact', async () => {
    h.state.actors = [makeActor()];
    h.state.signed = { status: 0, ok: false, statusText: '', throwErr: new Error('socket hang up') };
    const graph = await seedPostGraph();

    await expect(run()).rejects.toThrow('unverified=1');

    expect(h.callLog).toEqual([]);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(await survivingPostIds([graph.authored])).toEqual([graph.authored]);
  });

  it('partial: a transient Oxy delete failure KEEPS the anchor (never orphans the Oxy user)', async () => {
    h.state.actors = [makeActor()];
    h.state.oxyOutcome = 'failed';

    await expect(run()).rejects.toThrow('partial=1');

    // Mention refs were removed and the Oxy delete was attempted...
    expect(h.oxyDelete).toHaveBeenCalledTimes(1);
    expect(h.callLog).toContain('oxy-delete');
    expect(h.callLog).toContain('FederatedFollow');
    // ...but the anchor is KEPT so a later run reconciles the still-live Oxy user.
    expect(h.callLog).not.toContain('FederatedActor.deleteOne');
    expect(h.federatedActor.deleteActorsByUris).not.toHaveBeenCalled();
  });

  it('partial: a permanent (skipped) Oxy delete rejection also keeps the anchor', async () => {
    h.state.actors = [makeActor()];
    h.state.oxyOutcome = 'skipped';

    await expect(run()).rejects.toThrow('partial=1');

    expect(h.oxyDelete).toHaveBeenCalledTimes(1);
    expect(h.federatedActor.deleteActorsByUris).not.toHaveBeenCalled();
  });

  it('--dry-run performs ZERO destructive work (no delete, no tombstone clear, no oxy-api call)', async () => {
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await seedOwnerScopedRefs(graph.bystander);
    await seedChain();

    await run(['--dry-run']);

    // No destructive statement ever executed.
    expect(h.callLog).toEqual([]);
    // …and every row a live run would remove is still there.
    expect(await chainRowCounts()).toEqual([1, 1]);
    expect(await survivingPostIds([graph.authored, graph.boost, graph.bystander])).toHaveLength(3);
    expect(await snapshotMentionRefs()).toBe(OWNER_SCOPED_TABLES.length);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteActorsByUris).not.toHaveBeenCalled();
    expect(h.federatedActor.updateActorSuspended).not.toHaveBeenCalled();
    // It still COUNTS what it would delete (read-only), so the summary is accurate.
    expect(h.federatedFollowRepo.findFollows).toHaveBeenCalled();
  });

  it('purges an owner-less legacy row: uri-keyed refs + anchor, with no Oxy identity call', async () => {
    h.state.actors = [makeOwnerlessActor()];

    await run();

    // No owner id → no oxyUserId-keyed identity delete, but the uri-keyed follow
    // edges and the anchor are still removed.
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.callLog).toContain('FederatedFollow');
    expect(h.callLog[h.callLog.length - 1]).toBe('FederatedActor.deleteOne');
  });

  it('fails closed before the first destructive write when a REAL uncascaded reference exists', async () => {
    // A bookmark BY the purged actor is one of the references the gone-actor
    // cascade never claims to remove, so its probe stays armed even for this
    // caller. The row is real, so this test fails if the probe is asking a store
    // nothing writes — the failure mode a mocked preflight cannot see.
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await getDb().insert(bookmarks).values({ userId: OWNER, postId: graph.bystander });

    await expect(run()).rejects.toThrow('blocked=1');

    expect(h.callLog).toEqual([]);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteActorsByUris).not.toHaveBeenCalled();
    // Nothing was deleted on the way to being blocked.
    expect(await survivingPostIds([graph.authored, graph.boost, graph.bystander])).toHaveLength(3);
  });

  it('de-links the purged actor from every OTHER post’s mentions', async () => {
    h.state.actors = [makeActor()];
    const mentioning = await seedPost(scope, {
      oxyUserId: BOOSTER,
      authorship: [{ oxyUserId: BOOSTER, role: 'owner', status: 'accepted' }],
      content: { variants: [{ source: 'author', text: 'hey there', tag: 'en' }] },
      mentions: [OWNER],
    });

    await run();

    // The post SURVIVES — it is somebody else's — but the dangling mention of a
    // deleted identity does not.
    expect(await survivingPostIds([mentioning.id])).toEqual([mentioning.id]);
    expect((await loadPostRecord(mentioning.id))?.mentions).toEqual([]);
  });
});

/**
 * The engagement rows the WAIVED preflight probes stop guarding.
 *
 * `assertActorSafeToDelete` skips `likes.user_id` and its neighbours for this
 * caller specifically (`allowGoneActorCascade`) ON THE STRENGTH of the cascade
 * removing them. While the cascade still deleted from the Mongo collections of
 * the same name, that waiver guarded nothing and the rows survived a completed
 * purge — verified against a real row before the fix. These cases are what keep
 * the two halves honest about each other.
 */
describe('purgeGoneFederatedActors — the rows the preflight stops guarding', () => {
  it('removes the purged actor’s own likes', async () => {
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await getDb().insert(likes).values({ userId: OWNER, postId: graph.bystander });

    await run();

    expect(await getDb().select({ id: likes.id }).from(likes).where(eq(likes.userId, OWNER)))
      .toEqual([]);
  });

  it('removes likes and bookmarks left on the posts it deletes', async () => {
    // These two ride an `ON DELETE CASCADE` to `posts.id`, so they would go
    // anyway — the step exists so the cascade is one this script STATES and
    // counts, rather than one nobody chose.
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await getDb().insert(likes).values({ userId: BOOSTER, postId: graph.authored });
    await getDb().insert(bookmarks).values({ userId: BOOSTER, postId: graph.authored });

    await run();

    expect(await getDb().select({ id: likes.id }).from(likes).where(eq(likes.userId, BOOSTER)))
      .toEqual([]);
    expect(await getDb().select({ id: bookmarks.id }).from(bookmarks).where(eq(bookmarks.userId, BOOSTER)))
      .toEqual([]);
  });
});
