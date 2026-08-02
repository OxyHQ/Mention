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
  } = {
    actors: [],
    signed: { status: 410, ok: false, statusText: 'Gone' },
    oxyOutcome: 'deleted',
  };

  // A count query that is both directly awaitable (the driver's `countDocuments`)
  // and `.exec()`-able (the `countOrDelete` helper's dry-run path).
  const countQuery = (n: number): Promise<number> & { exec: () => Promise<number> } =>
    Object.assign(Promise.resolve(n), { exec: async () => n });

  // A simple model: `deleteMany` (records order) + `countDocuments`.
  const makeSimple = (label: string) => ({
    deleteMany: vi.fn((_filter: unknown) => ({
      exec: async () => {
        callLog.push(label);
        return { deletedCount: 1 };
      },
    })),
    countDocuments: vi.fn((_filter: unknown) => countQuery(1)),
  });

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
    like: makeSimple('Like'),
    bookmark: makeSimple('Bookmark'),
    entityFollow: makeSimple('EntityFollow'),
    notification: makeSimple('Notification'),
    userSettings: makeSimple('UserSettings'),
    userBehavior: makeSimple('UserBehavior'),
    userFeedPreference: makeSimple('UserFeedPreference'),
    authorFollowerSnapshot: makeSimple('AuthorFollowerSnapshot'),
    mentionUserNode: makeSimple('MentionUserNode'),
    mentionNodeIngestWitness: makeSimple('MentionNodeIngestWitness'),
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
vi.mock('../../models/Like', () => ({ default: h.like }));
vi.mock('../../models/Bookmark', () => ({ default: h.bookmark }));
vi.mock('../../models/EntityFollow', () => ({ EntityFollow: h.entityFollow }));
vi.mock('../../models/Notification', () => ({ default: h.notification }));
vi.mock('../../models/UserSettings', () => ({ default: h.userSettings }));
vi.mock('../../models/UserBehavior', () => ({ default: h.userBehavior }));
vi.mock('../../models/UserFeedPreference', () => ({ default: h.userFeedPreference }));
vi.mock('../../models/AuthorFollowerSnapshot', () => ({ AuthorFollowerSnapshot: h.authorFollowerSnapshot }));
vi.mock('../../models/MentionUserNode', () => ({ default: h.mentionUserNode }));
vi.mock('../../models/MentionNodeIngestWitness', () => ({ default: h.mentionNodeIngestWitness }));

vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return { ...actual, default: { ...actual.default, disconnect: vi.fn(async () => undefined) } };
});

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { bookmarks, likes } from '../../db/schema/engagement';
import { mentionRepoHeads, mentionSignedRecords } from '../../db/schema/mtn';
import { posts } from '../../db/schema/posts';
import { loadPostRecord } from '../../db/posts/postRepository';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import purgeGoneFederatedActors from '../../scripts/purgeGoneFederatedActors';

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

function makeActor(oxyUserId: string | undefined = OWNER): ActorRow {
  return {
    id: `actor-${scope.name}`,
    uri: ACTOR_URI,
    acct: `ghost@${scope.name}.test`,
    oxyUserId,
  };
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
  h.callLog.length = 0;
  h.state.actors = [];
  h.state.signed = { status: 410, ok: false, statusText: 'Gone' };
  h.state.oxyOutcome = 'deleted';
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
  await clearPostScope(scope);
});

describe('purgeGoneFederatedActors', () => {
  it('cascades a confirmed-gone actor in order: Mention refs → Oxy identity → FederatedActor anchor', async () => {
    h.state.actors = [makeActor()];
    await seedPostGraph();

    await run();

    // Step 1 (posts) → 2 (mentions) → 4 (follows) → 5-7 → 8 (oxy) → 9 (anchor).
    expectOrder(h.callLog, [
      'Bookmark',
      'FederatedFollow',
      'EntityFollow',
      'Notification',
      'UserSettings',
      'MentionNodeIngestWitness',
      'oxy-delete',
      'FederatedActor.deleteOne',
    ]);
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
    await seedChain();

    await run(['--dry-run']);

    // No deleteMany / updateMany / deleteOne / updateOne ever executed.
    expect(h.callLog).toEqual([]);
    // …and every row a live run would remove is still there.
    expect(await chainRowCounts()).toEqual([1, 1]);
    expect(await survivingPostIds([graph.authored, graph.boost, graph.bystander])).toHaveLength(3);
    expect(h.oxyDelete).not.toHaveBeenCalled();
    expect(h.federatedActor.deleteActorsByUris).not.toHaveBeenCalled();
    expect(h.federatedActor.updateActorSuspended).not.toHaveBeenCalled();
    // It still COUNTS what it would delete (read-only), so the summary is accurate.
    expect(h.like.countDocuments).toHaveBeenCalled();
    expect(h.federatedFollowRepo.findFollows).toHaveBeenCalled();
  });

  it('purges an owner-less legacy row: uri-keyed refs + anchor, with no Oxy identity call', async () => {
    h.state.actors = [makeActor(undefined)];

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
 * Rows the cascade CLAIMS to remove, whose tables moved to Postgres while the
 * cascade still deletes from the Mongo collection of the same name.
 *
 * This is separated from the cases above because it is a FINDING about the
 * script, not a property it currently holds: `assertActorSafeToDelete` waives
 * the matching probes for this caller precisely because the cascade is supposed
 * to remove them, so nothing blocks the purge and nothing removes the rows.
 */
describe('purgeGoneFederatedActors — Postgres rows the cascade leaves behind', () => {
  it('removes the purged actor’s own likes', async () => {
    const { likes } = await import('../../db/schema/engagement');
    h.state.actors = [makeActor()];
    const graph = await seedPostGraph();
    await getDb().insert(likes).values({ userId: OWNER, postId: graph.bystander });

    await run();

    const remaining = await getDb()
      .select({ id: likes.id })
      .from(likes)
      .where(eq(likes.userId, OWNER));
    expect(remaining).toEqual([]);
  });
});

// `track` is re-exported by the fixtures for suites that let PRODUCTION code
// create posts; this suite seeds every row itself, so referencing it here keeps
// the import list honest about what is used.
void track;
