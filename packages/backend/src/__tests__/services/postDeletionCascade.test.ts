/**
 * `deletePost` and the cascade under it, against REAL rows.
 *
 * ## Why this file had to be re-pointed
 *
 * The suite this replaces mocked `models/Post`, `models/Like`, `models/Notification`
 * and ten more Mongoose models, and asserted the FILTER OBJECTS handed to them.
 * Nothing reads any of those models: the delete path is one Postgres transaction.
 * So every one of those assertions described a store the code had stopped using —
 * green forever, and blind to the two defects that actually shipped here (a reply
 * silently PROMOTED to a root post, and a cascade leg whose failure was
 * indistinguishable from a leg that deleted nothing).
 *
 * ## The four properties, and why each needs a ROW to be observable
 *
 *  1. **The ownership claim is still ONE statement that authorizes and deletes.**
 *     `deletePostRecord` carries the `oxy_user_id` predicate in the `DELETE`'s own
 *     `WHERE`, so there is no window between the check and the write. A caller who
 *     may not manage the post is refused and the row survives — asserted on the
 *     ROW, because a refusal that had also written would pass a status assertion.
 *  2. **A deleted parent's replies are GONE, not orphaned.** `posts.parent_post_id`
 *     is `ON DELETE SET NULL`, so deleting the post first and repairing after —
 *     which is what this route did — leaves the reply alive with
 *     `parent_post_id: null` and `is_reply: true`: a root post nobody wrote. Only
 *     reading the reply row back can tell "deleted" from "promoted".
 *  3. **A tier-1 leg failure leaves the post PRESENT.** The seven explicit
 *     reference legs run inside the same transaction as the `DELETE` and THROW, so
 *     a failure rolls the whole thing back and the 500 is honest and retryable.
 *     The shape this replaces reported a COMPLETED deletion whose leftovers no
 *     retry could reach.
 *  4. **Best-effort work after the commit is swallowed but COUNTED.** Fail-soft is
 *     fine, silent is not — so the metric is asserted, not just the 200.
 *
 * ## `ON DELETE CASCADE` does most of the work, and that is deliberate
 *
 * Six of the thirteen known references cascade from `posts.id`, and a leg for
 * them would be permanently untestable (the residue check runs after the delete,
 * when the rows are gone either way). What this file exercises is the seven that
 * a foreign key CANNOT express — polymorphic, URI-keyed, and the gate tables —
 * plus the boost closure, which has to be captured BEFORE the delete because
 * `posts.boost_of` cascades and takes the only link that could have found the
 * boosts' own references.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { PostType } from '@mention/shared-types';
import type { OxyAuthRequest } from '@oxyhq/core/server';

const mocks = vi.hoisted(() => ({
  deletePendingDeliveries: vi.fn(),
  repairRecentRepliers: vi.fn(),
  /** Who Oxy currently says is a member of the channel. Empty unless a case says otherwise. */
  listAccountMembers: vi.fn(async () => [] as unknown[]),
  /** What kind Oxy says each account is — `assertCanPublishAsAccount` asks before reading members. */
  accountKinds: new Map<string, string>(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async (ids: string[]) => {
    const summaries = new Map();
    for (const id of ids) {
      const kind = mocks.accountKinds.get(id);
      if (kind) summaries.set(id, { user: { id, kind } });
    }
    return summaries;
  }),
  degradedActorSummary: vi.fn(() => ({ id: 'unknown', username: '' })),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  createUserScopedOxyServices: vi.fn(() => ({ listAccountMembers: mocks.listAccountMembers })),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

// The two side effects that leave the process: the MTN chain write and the
// outbound `Delete(Tombstone)`. Both are fire-and-forget and neither decides
// anything here. Spread from the original so no OTHER export of these modules
// silently becomes `undefined` for a module that imports one.
vi.mock('../../services/mtn/MentionRecordEmitter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mtn/MentionRecordEmitter')>()),
  emitTombstone: vi.fn(async () => undefined),
}));

vi.mock('../../connectors/outboundFederation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../connectors/outboundFederation')>()),
  federateAsResolvedActor: vi.fn(),
}));

/**
 * SPIES over the real implementations, not stubs.
 *
 * Each is the injection point for one failure the suite has to produce — a tier-1
 * leg that throws, and a best-effort step that throws — and neither failure can be
 * provoked through the public surface. Wrapping rather than replacing keeps every
 * OTHER test in this file running the real code: a stub here would quietly make
 * the delivery-queue leg and the replier repair untested while the file still
 * reads as if it covered them.
 */
vi.mock('../../db/federation/deliveryQueueRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/federation/deliveryQueueRepository')>();
  mocks.deletePendingDeliveries.mockImplementation(actual.deletePendingDeliveriesReferencingObjects);
  return { ...actual, deletePendingDeliveriesReferencingObjects: mocks.deletePendingDeliveries };
});

vi.mock('../../services/PostRecentReplierService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/PostRecentReplierService')>();
  mocks.repairRecentRepliers.mockImplementation(actual.repairRecentRepliersAfterPostDelete);
  return { ...actual, repairRecentRepliersAfterPostDelete: mocks.repairRecentRepliers };
});

import { closePostgres, connectPostgres, getDb, type Database } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import { feedInteractions } from '../../db/schema/feeds';
import { postgates } from '../../db/schema/gates';
import { reports } from '../../db/schema/moderation';
import { posts } from '../../db/schema/posts';
import { clearPostScope, postScope, readPostRow, seedPost } from '../helpers/postFixtures';
import {
  CASCADED_POST_REFERENCES,
  POST_DELETION_SIDE_EFFECT_FAILED_METRIC,
  POST_REFERENCES_KEPT_BY_POLICY,
  POST_REFERENCES_REMOVED_BY_DATABASE,
  MAX_DELETION_TARGETS,
  deletePostSubtree,
} from '../../services/PostDeletionCascade';
import { POST_REFERENCE_PROBE_NAMES } from '../../scripts/lib/adminDeletionPreflight';
import { deletePost } from '../../controllers/posts.controller';
import { metrics } from '../../utils/metrics';
import { logger } from '../../utils/logger';

const scope = postScope('post-deletion-cascade');
const AUTHOR = scope.user('author');
const STRANGER = scope.user('stranger');
const BOOSTER = scope.user('booster');
const CHANNEL = scope.user('channel');
const WRITER = scope.user('writer');
const ACTOR = scope.user('actor');

let db: Database;
/** Rows this file writes outside `postScope`, removed by id in teardown. */
const bulkPostIds: string[] = [];

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function makeReq(postId: string, callerId: string): OxyAuthRequest {
  return { user: { id: callerId }, params: { id: postId }, body: {} } as unknown as OxyAuthRequest;
}

async function runDelete(postId: string, callerId: string): Promise<MockRes> {
  const res = makeRes();
  await deletePost(makeReq(postId, callerId), res as never);
  return res;
}

/** A notification naming a post — the polymorphic reference no FK can carry. */
async function notifyAbout(
  entityId: string,
  options: { type?: 'like' | 'reply'; entityType?: 'post' | 'reply' } = {},
): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({
      recipientId: AUTHOR,
      actorId: ACTOR,
      type: options.type ?? 'like',
      entityType: options.entityType ?? 'post',
      entityId,
    })
    .returning({ id: notifications.id });
  return row.id;
}

async function notificationExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id));
  return rows.length > 0;
}

async function seedInteraction(postUri: string): Promise<string> {
  const [row] = await db
    .insert(feedInteractions)
    .values({ userId: AUTHOR, feedDescriptor: 'for_you', postUri, event: 'impression' })
    .returning({ id: feedInteractions.id });
  return row.id;
}

async function interactionExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: feedInteractions.id }).from(feedInteractions).where(eq(feedInteractions.id, id));
  return rows.length > 0;
}

async function seedPostgate(postId: string, postUri: string): Promise<string> {
  const [row] = await db
    .insert(postgates)
    .values({ postId, postUri, createdBy: AUTHOR })
    .returning({ id: postgates.id });
  return row.id;
}

async function postgateExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: postgates.id }).from(postgates).where(eq(postgates.id, id));
  return rows.length > 0;
}

async function seedReport(postId: string): Promise<string> {
  const [row] = await db
    .insert(reports)
    .values({ reportedType: 'post', reportedId: postId, reporter: STRANGER, categories: ['spam'] })
    .returning({ id: reports.id });
  return row.id;
}

/** The metric writes this run recorded, as `{step}` labels. */
function sideEffectFailureSteps(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .filter((call) => call[0] === POST_DELETION_SIDE_EFFECT_FAILED_METRIC)
    .map((call) => (call[2] as { step: string } | undefined)?.step ?? '');
}

let incrementCounter: ReturnType<typeof vi.spyOn>;
let loggedError: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  db = await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Nobody operates anything unless a case stages it. `clearAllMocks` resets the
  // implementation too, so the default has to be restated rather than assumed.
  mocks.accountKinds.clear();
  mocks.listAccountMembers.mockResolvedValue([]);
  incrementCounter = vi.spyOn(metrics, 'incrementCounter');
  loggedError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  incrementCounter.mockRestore();
  loggedError.mockRestore();
  await db.delete(notifications).where(inArray(notifications.recipientId, [AUTHOR]));
  await db.delete(feedInteractions).where(inArray(feedInteractions.userId, [AUTHOR]));
  await db.delete(postgates).where(inArray(postgates.createdBy, [AUTHOR]));
  await db.delete(reports).where(inArray(reports.reporter, [STRANGER]));
  await clearPostScope(scope);
  if (bulkPostIds.length > 0) {
    await db.delete(posts).where(inArray(posts.id, bulkPostIds.splice(0)));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the disposition table', () => {
  it('decides something for every reference the preflight knows about, exactly once', () => {
    // The compiler already enforces the `Record` is total, but a runtime check
    // carries the vacuity floor: an empty or truncated probe list would satisfy
    // the type and prove nothing. Each of the three lists must also be non-empty,
    // or a disposition nobody uses would read as covered.
    expect(POST_REFERENCE_PROBE_NAMES.length).toBeGreaterThanOrEqual(13);
    expect(CASCADED_POST_REFERENCES.length).toBeGreaterThan(0);
    expect(POST_REFERENCES_REMOVED_BY_DATABASE.length).toBeGreaterThan(0);
    expect(POST_REFERENCES_KEPT_BY_POLICY.length).toBeGreaterThan(0);

    const decided = [
      ...CASCADED_POST_REFERENCES,
      ...POST_REFERENCES_REMOVED_BY_DATABASE,
      ...POST_REFERENCES_KEPT_BY_POLICY,
    ];
    // Disjoint AND total: a reference claimed by two lists would be verified as
    // cascaded while being deliberately kept, which is the confusion the split
    // exists to remove.
    expect(new Set(decided).size).toBe(decided.length);
    expect([...decided].sort()).toEqual([...POST_REFERENCE_PROBE_NAMES].sort());
  });

  it('never CLAIMS the references the database removes, or the ones it keeps', () => {
    // `collectPostCascadeResidue` re-runs exactly the claimed probes. Claiming a
    // reference this module does not remove would report the shortfall it finds
    // as satisfied; claiming one the FK removes would verify the schema instead
    // of the cascade.
    expect(CASCADED_POST_REFERENCES).not.toContain('reports.reported_id(post)');
    expect(CASCADED_POST_REFERENCES).not.toContain('federation_delivery_queue.activity_json');
    expect(CASCADED_POST_REFERENCES).not.toContain('likes.post_id');
    expect(POST_REFERENCES_KEPT_BY_POLICY).toContain('reports.reported_id(post)');
  });
});

describe('the ownership claim', () => {
  it('deletes the author’s own post and answers success', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });

    const res = await runDelete(post.id, AUTHOR);

    expect(res.statusCode).toBe(200);
    expect(await readPostRow(post.id)).toBeUndefined();
  });

  it('refuses a stranger and LEAVES THE ROW, without disclosing that it exists', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });

    const res = await runDelete(post.id, STRANGER);

    // 404 and not 403: these routes have always answered 404 for a post the
    // caller may not touch, so the response cannot be used to discover one.
    expect(res.statusCode).toBe(404);
    // The ROW, not the status. A refusal that had also written would satisfy the
    // status assertion on its own.
    expect(await readPostRow(post.id)).toBeDefined();
  });

  it('ROLLS BACK the subtree when the claim matches nothing — asserted on the FUNCTION, not the route', async () => {
    /**
     * THE FIXTURE IN THE GAP, and it needed TWO corrections to become one.
     *
     * `deletePostSubtree` runs the reference legs and deletes the replies BEFORE
     * it claims the post, so when the ownership predicate matches nothing a
     * subtree has already been removed inside the open transaction. Only a THROW
     * discards it; a plain `return` COMMITS that damage and still returns null,
     * so the caller answers a correct-looking 404 over a conversation that is
     * now gone.
     *
     * Measured: mutating the throw to `return` left the whole suite green.
     *
     * The first attempt at this fixture drove it through the ROUTE with a
     * stranger — and stayed green under the same mutation, because
     * `postManagementRefusal` refuses a stranger BEFORE the transaction opens,
     * so the claim inside it is never reached. That makes the claim genuine
     * defence-in-depth (its reachable trigger is a race, or the channel-writer
     * path where the claim uses `authorId`), and defence in depth is only
     * testable at the layer that holds it. Hence this calls the function
     * directly with a predicate that matches no row.
     */
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const reply = await seedPost(scope, {
      oxyUserId: AUTHOR,
      parentPostId: post.id,
      isReply: true,
    });

    const result = await deletePostSubtree(post.id, eq(posts.oxyUserId, 'nobody-owns-this'));

    expect(result).toBeNull();
    expect(await readPostRow(post.id)).toBeDefined();
    expect(await readPostRow(reply.id)).toBeDefined();
  });

  it('404s an id that names no row', async () => {
    const res = await runDelete('00000000-0000-7000-8000-000000000000', AUTHOR);
    expect(res.statusCode).toBe(404);
  });

  it('lets a CURRENT member of the channel delete its post, though the row belongs to the channel', async () => {
    /**
     * The one case that can observe which id the ownership claim uses.
     *
     * `postManagementRefusal` admits a human who currently operates the channel.
     * A channel post's `oxy_user_id` is the CHANNEL, so a claim built from the
     * CALLER's id matches nothing: the transaction rolls back and the member is
     * told the post does not exist — after being told they were allowed. That is
     * what this merge briefly reintroduced, and what this pins.
     *
     * Every other delete in this suite is an ordinary author deleting their own
     * post, where caller and owner are the same string and the two spellings are
     * indistinguishable. This is the only fixture where they differ, which is
     * why it is the only one that goes red on the wrong one.
     *
     * The lane path two hundred lines above carries a comment naming the same
     * trap ("it used to be `userId` … which made every channel post unmovable").
     *
     * The membership is STAGED rather than taken off the row. Writing the post
     * is not what authorises deleting it — `written_by_oxy_user_id` is never
     * revised, so it goes on naming somebody after they leave — and the roster
     * here is what the route actually asks. `channelPostManagementAuthority`
     * owns the departed-writer half.
     */
    mocks.accountKinds.set(CHANNEL, 'channel');
    mocks.listAccountMembers.mockResolvedValue([{ memberUserId: WRITER, status: 'active' }]);
    const post = await seedPost(scope, {
      oxyUserId: CHANNEL,
      authorship: [{ oxyUserId: CHANNEL, role: 'owner', status: 'accepted' }],
      writtenByOxyUserId: WRITER,
    });

    const res = await runDelete(post.id, WRITER);

    expect(res.statusCode).toBe(200);
    expect(await readPostRow(post.id)).toBeUndefined();
  });
});

describe('the subtree the transaction owns', () => {
  it('deletes a reply with its parent — GONE, never orphaned as a root post', async () => {
    const parent = await seedPost(scope, { oxyUserId: AUTHOR });
    const reply = await seedPost(scope, { oxyUserId: STRANGER, parentPostId: parent.id });

    const res = await runDelete(parent.id, AUTHOR);

    expect(res.statusCode).toBe(200);
    // The whole point. `parent_post_id` is `ON DELETE SET NULL`, so deleting the
    // post first leaves this row ALIVE with `parent_post_id: null` and
    // `is_reply: true` — a root post nobody wrote, in every feed that reads
    // roots. "The reply is gone" and "the reply was promoted" are both a
    // successful-looking 200; only the row tells them apart.
    expect(await readPostRow(reply.id)).toBeUndefined();
  });

  it("removes a reply's own references, which nothing could find after the delete", async () => {
    const parent = await seedPost(scope, { oxyUserId: AUTHOR });
    const reply = await seedPost(scope, { oxyUserId: STRANGER, parentPostId: parent.id });
    const onReply = await notifyAbout(reply.id, { type: 'reply', entityType: 'reply' });

    await runDelete(parent.id, AUTHOR);

    expect(await notificationExists(onReply)).toBe(false);
  });

  it('removes a boost of the post AND the boost’s own references', async () => {
    // `posts.boost_of` is `ON DELETE CASCADE`, so the boost row goes with the
    // post whatever this module does — but its polymorphic references have
    // nothing left to find them by unless the closure was captured FIRST.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const boost = await seedPost(scope, {
      oxyUserId: BOOSTER,
      type: PostType.BOOST,
      boostOf: post.id,
    });
    const onBoost = await notifyAbout(boost.id);

    await runDelete(post.id, AUTHOR);

    expect(await readPostRow(boost.id)).toBeUndefined();
    expect(await notificationExists(onBoost)).toBe(false);
  });

  it('follows the boost graph transitively', async () => {
    // A boost of a boost cascades from the boost, so the same argument applies
    // one level down and the capture has to be transitive.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const boost = await seedPost(scope, { oxyUserId: BOOSTER, type: PostType.BOOST, boostOf: post.id });
    const nested = await seedPost(scope, { oxyUserId: STRANGER, type: PostType.BOOST, boostOf: boost.id });
    const onNested = await notifyAbout(nested.id);

    await runDelete(post.id, AUTHOR);

    expect(await readPostRow(nested.id)).toBeUndefined();
    expect(await notificationExists(onNested)).toBe(false);
  });

  it('refuses an oversized deletion outright rather than committing it half-cleaned', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const rows = Array.from({ length: MAX_DELETION_TARGETS }, () => ({
      oxyUserId: STRANGER,
      parentPostId: post.id,
      isReply: true,
    }));
    const inserted = await db.insert(posts).values(rows).returning({ id: posts.id });
    bulkPostIds.push(...inserted.map((row) => row.id));

    const res = await runDelete(post.id, AUTHOR);

    expect(res.statusCode).toBe(409);
    // Nothing was deleted: the cap is checked before any leg runs, and the
    // transaction never reaches the `DELETE`.
    expect(await readPostRow(post.id)).toBeDefined();
    expect(await readPostRow(inserted[0].id)).toBeDefined();
  });
});

describe('the reference legs', () => {
  it('deletes notifications naming the post under BOTH entity types', async () => {
    // `entity_type` has three values and two of them name a post row. Filtering
    // on `'post'` alone left every reply notification behind — the shape the
    // route shipped with.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const asPost = await notifyAbout(post.id, { type: 'like', entityType: 'post' });
    const asReply = await notifyAbout(post.id, { type: 'reply', entityType: 'reply' });
    const other = await seedPost(scope, { oxyUserId: AUTHOR });
    const untouched = await notifyAbout(other.id);

    await runDelete(post.id, AUTHOR);

    expect(await notificationExists(asPost)).toBe(false);
    expect(await notificationExists(asReply)).toBe(false);
    // Scoped: a leg that deleted every notification of this recipient would pass
    // the two assertions above.
    expect(await notificationExists(untouched)).toBe(true);
  });

  it('matches the URI-keyed and two-key legs by the AP identifiers as well as the id', async () => {
    // A federated post travels under identifiers that are not `posts.id`, and
    // `feed_interactions.post_uri` / the gate tables are keyed by them. A leg that
    // only ever passed ids matches nothing here and reports success.
    const activityId = `https://remote.test/${scope.name}/notes/1`;
    const post = await seedPost(scope, {
      oxyUserId: AUTHOR,
      federation: { activityId },
    });
    const byId = await seedInteraction(post.id);
    const byUri = await seedInteraction(activityId);
    const elsewhere = await seedInteraction(`https://remote.test/${scope.name}/notes/other`);
    const gateById = await seedPostgate(post.id, `urn:${scope.name}:gate-by-id`);
    const gateByUri = await seedPostgate(`other-${scope.name}`, activityId);

    await runDelete(post.id, AUTHOR);

    expect(await interactionExists(byId)).toBe(false);
    expect(await interactionExists(byUri)).toBe(false);
    expect(await interactionExists(elsewhere)).toBe(true);
    expect(await postgateExists(gateById)).toBe(false);
    expect(await postgateExists(gateByUri)).toBe(false);
  });

  it('KEEPS the moderation report, which is not the deleting user’s to erase', async () => {
    // Deleting it would strand an inbound CrowdSource decision:
    // `ModerationDecisionWorker` resolves a case through `Report.crowdSourceCaseId`
    // and treats "no local report" as RETRYABLE, so the decision would back off
    // and retry until it expired.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const reportId = await seedReport(post.id);

    await runDelete(post.id, AUTHOR);

    const rows = await db.select({ id: reports.id }).from(reports).where(eq(reports.id, reportId));
    expect(rows).toHaveLength(1);
  });

  it('rolls the WHOLE deletion back when a tier-1 leg fails, leaving the post present', async () => {
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    const reply = await seedPost(scope, { oxyUserId: STRANGER, parentPostId: post.id });
    const notification = await notifyAbout(post.id);
    mocks.deletePendingDeliveries.mockRejectedValueOnce(new Error('deadlock detected'));

    const res = await runDelete(post.id, AUTHOR);

    // Honest and retryable. The shape this replaces swallowed the failure and
    // reported a COMPLETED deletion whose leftovers no retry could ever reach.
    expect(res.statusCode).toBe(500);
    expect(await readPostRow(post.id)).toBeDefined();
    expect(await readPostRow(reply.id)).toBeDefined();
    // The legs that ran BEFORE the failing one are rolled back too — they are in
    // the same transaction as the `DELETE`, which is the only thing that makes
    // throwing coherent.
    expect(await notificationExists(notification)).toBe(true);
  });

  it('retries cleanly once the failing leg recovers', async () => {
    // The vacuity floor for the case above: a 500 that could never become a 200
    // would satisfy it just as well, and "retryable" is the claim being made.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    mocks.deletePendingDeliveries.mockRejectedValueOnce(new Error('deadlock detected'));

    expect((await runDelete(post.id, AUTHOR)).statusCode).toBe(500);
    expect((await runDelete(post.id, AUTHOR)).statusCode).toBe(200);
    expect(await readPostRow(post.id)).toBeUndefined();
  });
});

describe('best-effort work after the commit', () => {
  it('swallows a failed projection repair but COUNTS it', async () => {
    // The post is gone and the user is about to be told so — a projection that
    // could not be repaired is not a reason to report a completed deletion as a
    // failure. Fail-soft is fine, SILENT is not, so the metric is the assertion.
    const parent = await seedPost(scope, { oxyUserId: STRANGER });
    const post = await seedPost(scope, { oxyUserId: AUTHOR, parentPostId: parent.id });
    mocks.repairRecentRepliers.mockRejectedValueOnce(new Error('projection unavailable'));

    const res = await runDelete(post.id, AUTHOR);

    expect(res.statusCode).toBe(200);
    expect(await readPostRow(post.id)).toBeUndefined();
    expect(sideEffectFailureSteps(incrementCounter)).toEqual(['recent_replier_projection']);
  });

  it('repairs the surviving parent’s reply counter, guarded so it cannot go negative', async () => {
    const parent = await seedPost(scope, { oxyUserId: STRANGER });
    await db.update(posts).set({ statsCommentsCount: 1 }).where(eq(posts.id, parent.id));
    const reply = await seedPost(scope, { oxyUserId: AUTHOR, parentPostId: parent.id });

    await runDelete(reply.id, AUTHOR);

    const [row] = await db
      .select({ count: posts.statsCommentsCount })
      .from(posts)
      .where(eq(posts.id, parent.id));
    expect(row.count).toBe(0);
  });

  it('never drives an already-zero counter below zero', async () => {
    // The guard is `> 0`, the same one the unboost path and the administrative
    // purge use. A counter already behind is repairable; a negative one renders.
    const parent = await seedPost(scope, { oxyUserId: STRANGER });
    const reply = await seedPost(scope, { oxyUserId: AUTHOR, parentPostId: parent.id });

    await runDelete(reply.id, AUTHOR);

    const [row] = await db
      .select({ count: posts.statsCommentsCount })
      .from(posts)
      .where(and(eq(posts.id, parent.id)));
    expect(row.count).toBe(0);
  });

  it('records nothing at all when the deletion is clean', async () => {
    // The vacuity floor for the counter: it must not fire on the happy path, or
    // "it was counted" says nothing about the failure that supposedly caused it.
    const post = await seedPost(scope, { oxyUserId: AUTHOR });
    await notifyAbout(post.id);

    const res = await runDelete(post.id, AUTHOR);

    expect(res.statusCode).toBe(200);
    expect(sideEffectFailureSteps(incrementCounter)).toEqual([]);
    // Including the residue check, which re-runs every CLAIMED probe against the
    // committed state — so a leg that silently matched nothing is reported here.
    expect(loggedError).not.toHaveBeenCalled();
  });
});
