import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

/**
 * `ChannelDeletionService` — destroying one channel's archive, against REAL ROWS.
 *
 * ## Why this file was rewritten rather than repaired
 *
 * The version this replaces carried 56 `vi.mock` calls, one of them
 * `vi.mock('mongoose')`. Every assertion in it was about a mock of a store the
 * application no longer reads: it could not tell a cascade that ran from one that
 * matched nothing, because nothing it asserted on was ever in a database. A check
 * pointed at the abandoned store passes forever, and this cascade is exactly the
 * kind of code where "passes forever" and "deletes nothing" look identical from
 * the outside — the user gets a success response and the posts survive.
 *
 * Everything below therefore seeds rows into the throwaway Postgres and asserts
 * on what the database holds afterwards. Only the genuinely remote things are
 * mocked: the Oxy account-kind read and the two ActivityPub delivery paths.
 *
 * ## The one thing that must NOT be tested here, and why
 *
 * Eighteen manifest entries are performed by an `ON DELETE` constraint. There is
 * no leg for them and there must not be one, so there is no leg to test — a
 * residue check runs after the delete, when the rows are gone either way, and
 * cannot tell "the service removed it" from "the FK removed it". What IS tested
 * is the observable OUTCOME (a boost is gone, a quote survives with a NULL
 * pointer) plus the manifest's claim that a constraint is what does it. Asserting
 * a leg ran would be asserting something no evidence can distinguish.
 */

const oxyKind = vi.hoisted(() => vi.fn());
const federateDelete = vi.hoisted(() => vi.fn(async () => undefined));
const deliverToFollowers = vi.hoisted(() => vi.fn(async () => undefined));
const getUserById = vi.hoisted(() => vi.fn());

vi.mock('../../services/publishAsAccount', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/publishAsAccount')>()),
  resolveAccountKind: oxyKind,
}));
vi.mock('../../connectors/activitypub/follow.service', () => ({
  followService: { federateDelete },
}));
vi.mock('../../connectors/activitypub/delivery.service', () => ({
  deliveryService: { deliverToFollowers },
}));
vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ getUserById }),
}));

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { notifications, trending } from '../../db/schema/discovery';
import { federatedFollows } from '../../db/schema/federation';
import { likes, mutes } from '../../db/schema/engagement';
import { accountListMembers, accountLists } from '../../db/schema/lists';
import { reports } from '../../db/schema/moderation';
import { mcpConnections } from '../../db/schema/mcp';
import { userSettings } from '../../db/schema/userProfile';
import { lanes } from '../../db/schema/channels';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { CHANNEL_CASCADE } from '../../services/channelDeletion/channelCascadeManifest';
import {
  deleteChannelContent,
  NotAChannelAccountError,
  previewChannelDeletion,
} from '../../services/channelDeletion/ChannelDeletionService';

const scope = serviceScope('channel-deletion');
const CHANNEL = scope.user('channel');
const STRANGER = scope.user('stranger');
const WRITER = scope.user('writer');
const VIEWER = scope.user('viewer');
/** Every account id this file mints, for the teardown of the non-post tables. */
const SCOPE_PREFIX = `oxy-${scope.name}-`;

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(() => {
  vi.clearAllMocks();
  oxyKind.mockResolvedValue('channel');
  getUserById.mockResolvedValue({ username: 'thechannel' });
});

afterEach(async () => {
  // Every non-post table this file writes to, cleaned by the scope prefix — one
  // database serves the whole parallel run, so a predicate wider than this one
  // would delete another suite's rows mid-assertion.
  const db = getDb();
  await db.delete(notifications).where(like(notifications.recipientId, `${SCOPE_PREFIX}%`));
  await db.delete(notifications).where(like(notifications.actorId, `${SCOPE_PREFIX}%`));
  await db.delete(mutes).where(like(mutes.userId, `${SCOPE_PREFIX}%`));
  await db.delete(mutes).where(like(mutes.mutedId, `${SCOPE_PREFIX}%`));
  await db.delete(likes).where(like(likes.userId, `${SCOPE_PREFIX}%`));
  await db.delete(accountLists).where(like(accountLists.ownerOxyUserId, `${SCOPE_PREFIX}%`));
  await db.delete(accountListMembers).where(like(accountListMembers.oxyUserId, `${SCOPE_PREFIX}%`));
  await db.delete(reports).where(like(reports.reporter, `${SCOPE_PREFIX}%`));
  await db.delete(mcpConnections).where(like(mcpConnections.oxyUserId, `${SCOPE_PREFIX}%`));
  await db.delete(userSettings).where(like(userSettings.oxyUserId, `${SCOPE_PREFIX}%`));
  await db.delete(lanes).where(like(lanes.ownerId, `${SCOPE_PREFIX}%`));
  await db.delete(federatedFollows).where(like(federatedFollows.localUserId, `${SCOPE_PREFIX}%`));
  await db.delete(trending).where(like(trending.name, `${SCOPE_PREFIX}%`));
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

/** Does a post row still exist? The only question most of these tests ask. */
async function postExists(id: string): Promise<boolean> {
  const rows = await getDb().select({ id: posts.id }).from(posts).where(eq(posts.id, id));
  return rows.length > 0;
}

async function readPostRow(id: string): Promise<typeof posts.$inferSelect | undefined> {
  const [row] = await getDb().select().from(posts).where(eq(posts.id, id));
  return row;
}

/** A channel post: the channel is the AUTHOR, and a human may be recorded as its writer. */
async function seedChannelPost(overrides: Parameters<typeof seedPost>[1] = {}) {
  return seedPost(scope, { oxyUserId: CHANNEL, ...overrides });
}

describe('ChannelDeletionService — the manifest binding', () => {
  it('accounts for every manifest entry exactly once, in exactly one of four ways', async () => {
    // The binding that makes the manifest the program. A step that stops
    // executing disappears from `steps` and appears in none of the other three,
    // so the union stops equalling the manifest and this fails — rather than the
    // rows quietly surviving.
    const result = await deleteChannelContent(CHANNEL, { dryRun: true });

    const accounted = [
      ...Object.keys(result.steps),
      ...result.delegated,
      ...result.performedByDatabase,
      ...result.retained,
    ];
    expect(new Set(accounted).size, 'the four accounts must be disjoint').toBe(accounted.length);

    const manifestKeys = new Set(CHANNEL_CASCADE.map((step) => `${step.table}.${step.column}`));
    expect([...new Set(accounted)].sort()).toEqual([...manifestKeys].sort());
  });

  it('leaves the constraint-performed entries to the database, with no leg of their own', async () => {
    // The boundary this port exists to state. `posts.boost_of` and
    // `posts.quote_of` must be reported as the DATABASE's work — if either ever
    // shows up under `steps`, somebody has written a leg that re-runs the
    // DELETE's own work and that no evidence could ever show had run.
    const result = await deleteChannelContent(CHANNEL, { dryRun: true });

    expect(result.performedByDatabase).toContain('posts.boostOf');
    expect(result.performedByDatabase).toContain('posts.quoteOf');
    expect(Object.keys(result.steps)).not.toContain('posts.boostOf');
    expect(Object.keys(result.steps)).not.toContain('posts.quoteOf');
  });

  it('reports a column classified under two scopes as locally executed, with the local count', async () => {
    // `notifications.entity_id` holds a post id under one `entity_type` and an
    // account id under another, so one key carries both a delegated half and a
    // local one. The local count is the informative answer; a bare "delegated"
    // label would drop it.
    const result = await deleteChannelContent(CHANNEL, { dryRun: true });

    expect(Object.keys(result.steps)).toContain('notifications.entityId');
    expect(result.delegated).not.toContain('notifications.entityId');
  });
});

describe('ChannelDeletionService — what happens to real rows', () => {
  it("destroys the channel posts and a stranger's boost of one, and keeps their quote", async () => {
    const channelPost = await seedChannelPost();
    const boost = await seedPost(scope, {
      oxyUserId: STRANGER,
      type: 'boost',
      boostOf: channelPost.id,
    });
    const quote = await seedPost(scope, { oxyUserId: STRANGER, quoteOf: channelPost.id });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(await postExists(channelPost.id), 'the channel post is destroyed').toBe(false);
    expect(
      await postExists(boost.id),
      'a boost renders entirely from its original, so a surviving one is a blank card',
    ).toBe(false);

    const survivingQuote = await readPostRow(quote.id);
    expect(survivingQuote, 'the quoter wrote their own words and keeps them').toBeDefined();
    expect(survivingQuote?.quoteOf, 'only the pointer goes').toBeNull();
  });

  it('never reattributes a channel post to the person who wrote it', async () => {
    // The one rule that is not about referential integrity, and the one the
    // schema does NOT hold up: `written_by_oxy_user_id` carries no constraint, so
    // nothing in the database would stop a reattributing UPDATE. With `signPosts`
    // off, handing the post to its writer retroactively publishes who wrote what.
    const signed = await seedChannelPost({ writtenByOxyUserId: WRITER });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(await postExists(signed.id), 'the post is destroyed').toBe(false);
    const reattributed = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.writtenByOxyUserId, WRITER));
    expect(reattributed, "no post may be left standing in the writer's name").toEqual([]);
  });

  it('counts the destroyed posts that had a human behind them', async () => {
    await seedChannelPost({ writtenByOxyUserId: WRITER });
    await seedChannelPost();

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(result.steps['posts.writtenByOxyUserId']).toBe(1);
    expect(result.steps['posts.oxyUserId']).toBe(2);
  });

  it('deletes rows that exist only for the channel', async () => {
    await getDb().insert(notifications).values({
      recipientId: CHANNEL,
      actorId: STRANGER,
      type: 'like',
      entityType: 'profile',
      entityId: CHANNEL,
    });
    await getDb().insert(mutes).values({ userId: VIEWER, mutedId: CHANNEL });
    await getDb().insert(lanes).values({
      ownerId: CHANNEL,
      name: `${SCOPE_PREFIX}lane`,
      nameLower: `${SCOPE_PREFIX}lane`,
    });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(
      await getDb()
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.recipientId, CHANNEL)),
    ).toEqual([]);
    expect(
      await getDb().select({ id: mutes.id }).from(mutes).where(eq(mutes.mutedId, CHANNEL)),
    ).toEqual([]);
    expect(
      await getDb().select({ id: lanes.id }).from(lanes).where(eq(lanes.ownerId, CHANNEL)),
    ).toEqual([]);
  });

  it("scrubs an ENTRY out of somebody else's row without destroying the row", async () => {
    // The distinction the whole design rests on, in its three storage shapes: a
    // junction row, an array column, and a nullable pointer. Deleting the owning
    // row in any of them destroys a third party's data to remove the channel's.
    const [list] = await getDb()
      .insert(accountLists)
      .values({ ownerOxyUserId: VIEWER, title: 'a list' })
      .returning({ id: accountLists.id });
    await getDb().insert(accountListMembers).values([
      { listId: list.id, oxyUserId: CHANNEL, position: 0 },
      { listId: list.id, oxyUserId: STRANGER, position: 1 },
    ]);
    const [trend] = await getDb()
      .insert(trending)
      .values({
        type: 'hashtag',
        name: `${SCOPE_PREFIX}term`,
        score: 1,
        rank: 1,
        calculatedAt: new Date(),
        actorIds: [CHANNEL, STRANGER],
      })
      .returning({ id: trending.id });
    await getDb()
      .insert(userSettings)
      .values({ oxyUserId: VIEWER, privacyRestrictedUsers: [CHANNEL, STRANGER] });
    const [connection] = await getDb()
      .insert(mcpConnections)
      .values({
        oxyUserId: VIEWER,
        clientId: 'a-client',
        clientLabel: 'a client',
        scopes: ['read'],
        refreshTokenHash: 'a-hash',
        jti: 'a-jti',
        activeOxyUserId: CHANNEL,
      })
      .returning({ id: mcpConnections.id });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    const members = await getDb()
      .select({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, list.id));
    expect(
      members.map((row) => row.oxyUserId),
      'the list survives one fewer member',
    ).toEqual([STRANGER]);

    const [survivingTrend] = await getDb()
      .select({ actorIds: trending.actorIds })
      .from(trending)
      .where(eq(trending.id, trend.id));
    expect(survivingTrend.actorIds, 'the trend belongs to the term, not the account').toEqual([
      STRANGER,
    ]);

    const [settings] = await getDb()
      .select({ restricted: userSettings.privacyRestrictedUsers })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, VIEWER));
    expect(settings.restricted, 'their settings row is theirs').toEqual([STRANGER]);

    const [survivingConnection] = await getDb()
      .select({ owner: mcpConnections.oxyUserId, active: mcpConnections.activeOxyUserId })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    expect(
      survivingConnection,
      "revoking a person's connector over an account they merely switched to would be the bug",
    ).toEqual({ owner: VIEWER, active: null });
  });

  it('keeps a report about a destroyed post', async () => {
    // Deleting it would BREAK something rather than merely lose an audit trail:
    // an inbound CrowdSource decision that resolves to no local report leaves
    // `ModerationDecisionWorker` retrying until it expires.
    const channelPost = await seedChannelPost();
    const [report] = await getDb()
      .insert(reports)
      .values({
        reportedType: 'post',
        reportedId: channelPost.id,
        reporter: STRANGER,
        categories: ['spam'],
      })
      .returning({ id: reports.id });

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(result.retained).toContain('reports.reportedId');
    const survivors = await getDb()
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.id, report.id));
    expect(survivors, 'the report outlives the post it is about').toHaveLength(1);
  });

  it('repairs the counter on a surviving post the channel had liked', async () => {
    const strangersPost = await seedPost(scope, { oxyUserId: STRANGER });
    await getDb().update(posts).set({ statsLikesCount: 3 }).where(eq(posts.id, strangersPost.id));
    await getDb().insert(likes).values({ userId: CHANNEL, postId: strangersPost.id });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(
      await getDb().select({ id: likes.id }).from(likes).where(eq(likes.userId, CHANNEL)),
    ).toEqual([]);
    const [survivor] = await getDb()
      .select({ n: posts.statsLikesCount })
      .from(posts)
      .where(eq(posts.id, strangersPost.id));
    expect(survivor.n, 'a surviving post must not keep a count that includes a deleted record').toBe(
      2,
    );
  });

  it('repairs the counter on a surviving post the channel had boosted', async () => {
    const strangersPost = await seedPost(scope, { oxyUserId: STRANGER });
    await getDb().update(posts).set({ statsBoostsCount: 2 }).where(eq(posts.id, strangersPost.id));
    await seedChannelPost({ type: 'boost', boostOf: strangersPost.id });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    const [survivor] = await getDb()
      .select({ n: posts.statsBoostsCount })
      .from(posts)
      .where(eq(posts.id, strangersPost.id));
    expect(survivor.n).toBe(1);
  });
});

describe('ChannelDeletionService — the run contract', () => {
  it('a dry run reads and reports without writing or federating', async () => {
    const channelPost = await seedChannelPost();
    await getDb().insert(mutes).values({ userId: VIEWER, mutedId: CHANNEL });

    const result = await deleteChannelContent(CHANNEL, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.steps['posts.oxyUserId'], 'a dry run still COUNTS what it would remove').toBe(1);
    expect(await postExists(channelPost.id), 'and removes none of it').toBe(true);
    expect(
      await getDb().select({ id: mutes.id }).from(mutes).where(eq(mutes.mutedId, CHANNEL)),
    ).toHaveLength(1);
    expect(federateDelete).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run finds nothing and does not throw', async () => {
    await seedChannelPost();
    await deleteChannelContent(CHANNEL, { dryRun: false });

    const second = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(second.steps['posts.oxyUserId']).toBe(0);
    expect(second.preview.posts).toBe(0);
  });

  it('previews without touching anything', async () => {
    const channelPost = await seedChannelPost();
    await seedPost(scope, { oxyUserId: STRANGER, type: 'boost', boostOf: channelPost.id });
    await seedPost(scope, { oxyUserId: STRANGER, quoteOf: channelPost.id });

    const preview = await previewChannelDeletion(CHANNEL);

    expect(preview).toMatchObject({
      channelOxyUserId: CHANNEL,
      posts: 1,
      boostsByOthers: 1,
      quotesByOthersKept: 1,
      // A channel takes no replies at five enforced sites; a non-zero here is a
      // finding, not a number to accept.
      replies: 0,
    });
    expect(await postExists(channelPost.id)).toBe(true);
  });
});

describe('ChannelDeletionService — the account-kind gate', () => {
  const entryPoints: Array<[string, (id: string) => Promise<unknown>]> = [
    ['deleteChannelContent', (id) => deleteChannelContent(id, { dryRun: false })],
    ['previewChannelDeletion', (id) => previewChannelDeletion(id)],
  ];

  for (const [name, run] of entryPoints) {
    it(`${name} refuses a personal account, and destroys nothing`, async () => {
      const personalPost = await seedPost(scope, { oxyUserId: CHANNEL });
      oxyKind.mockResolvedValue('personal');

      await expect(run(CHANNEL)).rejects.toBeInstanceOf(NotAChannelAccountError);
      expect(await postExists(personalPost.id), "a person's writing survives").toBe(true);
    });

    it(`${name} refuses an account whose kind will not resolve`, async () => {
      // Fail-soft `null` is an ANSWER the caller has to decide about, and the two
      // directions are not comparable: refusing delays an administrative action,
      // allowing destroys the wrong account's posts irreversibly.
      const post = await seedPost(scope, { oxyUserId: CHANNEL });
      oxyKind.mockResolvedValue(null);

      await expect(run(CHANNEL)).rejects.toBeInstanceOf(NotAChannelAccountError);
      expect(await postExists(post.id)).toBe(true);
    });

    it(`${name} refuses when the kind lookup itself fails`, async () => {
      const post = await seedPost(scope, { oxyUserId: CHANNEL });
      oxyKind.mockRejectedValue(new Error('identity is down'));

      await expect(run(CHANNEL)).rejects.toBeInstanceOf(NotAChannelAccountError);
      expect(await postExists(post.id)).toBe(true);
    });
  }

  it('proceeds for a channel — without this the gate could be refusing everything', async () => {
    // The control. Every assertion above is satisfied by a function that always
    // throws, so one of them has to prove the gate lets a channel through.
    const post = await seedChannelPost();

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(await postExists(post.id)).toBe(false);
  });
});

describe('ChannelDeletionService — the keyset loop', () => {
  /**
   * `POST_BATCH_SIZE` is 200 and a channel archive is the one input guaranteed to
   * exceed it, so a loop nothing ever pushes past one batch has BOTH of its
   * properties unverified: that it terminates, and that consecutive batches do
   * not overlap.
   *
   * The non-overlap assertion is made in a DRY RUN on purpose. A live run deletes
   * as it goes, so a cursor that never advanced would still converge and still
   * report 201 — the deletion hides the bug. Nothing is removed in a dry run, so
   * the only thing keeping the count at exactly 201 is the keyset moving
   * correctly; a batch re-visiting rows shows up immediately as an inflated
   * count, and a cursor that does not move at all cannot terminate.
   */
  const OVER_ONE_BATCH = 201;

  async function seedBulkChannelPosts(): Promise<void> {
    // A bulk insert rather than 201 fixture calls: this test is about the loop,
    // and 201 round trips through the record writer would make it about the
    // writer's throughput instead.
    await getDb()
      .insert(posts)
      .values(
        Array.from({ length: OVER_ONE_BATCH }, () => ({
          oxyUserId: CHANNEL,
          type: 'text' as const,
          visibility: 'public' as const,
          status: 'published' as const,
        })),
      );
  }

  it('walks past one batch without visiting a post twice', async () => {
    await seedBulkChannelPosts();

    const dry = await deleteChannelContent(CHANNEL, { dryRun: true });

    expect(
      dry.steps['posts.oxyUserId'],
      'each post must be counted exactly once — a cursor that does not advance re-reads the same rows',
    ).toBe(OVER_ONE_BATCH);
  });

  it('destroys every post across every batch', async () => {
    await seedBulkChannelPosts();

    const result = await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(result.steps['posts.oxyUserId']).toBe(OVER_ONE_BATCH);
    const survivors = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.oxyUserId, CHANNEL));
    expect(survivors, 'a channel bigger than one batch must not keep a tail').toEqual([]);
  });
});

describe('ChannelDeletionService — federation ordering', () => {
  /**
   * Two orderings, and BOTH are only observable from inside the mock, because
   * both are about what still exists at the moment the call is made:
   *
   *  - a per-post Tombstone goes out while its post is still there. Sent after the
   *    `DELETE`, a crash between the two leaves remote servers holding a Tombstone
   *    for a post that is still live locally, on every retry.
   *  - the actor `Delete` goes out while the `federated_follows` rows are still
   *    there. `deliverToFollowers` resolves its inboxes FROM those rows, which the
   *    account phase removes — sent afterwards it reaches nobody, silently.
   *
   * Asserting only "it was called" would pass against both bugs, which is why the
   * mocks read the database rather than counting calls.
   */
  const REMOTE = 'https://remote.example/users/follower';

  async function seedRemoteFollower(): Promise<void> {
    await getDb().insert(federatedFollows).values({
      localUserId: CHANNEL,
      remoteActorUri: REMOTE,
      direction: 'inbound',
      status: 'accepted',
    });
  }

  it('ROLLS THE BATCH BACK and REFUSES to report success — the posts survive and the caller is told', async () => {
    /**
     * INJECTION (3) from the mocked suite this file replaced, rebuilt on a REAL
     * failure instead of a rejecting double.
     *
     * A batch that throws is rolled back, so its posts SURVIVE, and the walk
     * continues to the next batch. What stops that reading as a completed
     * deletion is that `deleteChannelContent` THROWS at the end when
     * `run.failures` is non-empty, naming the batch — the failure is carried by
     * the exception, not by the returned result.
     *
     * That fact is worth pinning precisely because it is easy to get backwards:
     * the failure list is otherwise internal, read once for a summary, and a
     * reader who stops at the `if (run.failures.length > 0)` line — as I did —
     * concludes the result is silently clean. It is not; the function never
     * returns one.
     *
     * THE ROW ASSERTION IS THE ONE THAT MATTERS and needs no instrumentation:
     * the post is either there or it is not. Mutating the batch to commit on
     * error reds it while the throw still fires.
     *
     * The failure is a REAL Postgres error, raised by a trigger scoped to one
     * probe recipient id, on the `notifications` delete the cascade performs
     * inside the batch transaction. A mocked rejection would only prove the
     * catch recognises a shape the test invented. The trigger is created and
     * dropped inside this case so it cannot reach another file, and so the
     * teardown's own delete does not trip it.
     */
    const db = getDb();
    const channelPost = await seedChannelPost();
    await db.insert(notifications).values({
      recipientId: `${SCOPE_PREFIX}batch-failure-probe`,
      actorId: STRANGER,
      type: 'like',
      entityType: 'post',
      entityId: channelPost.id,
    });
    await db.execute(sql`
      create or replace function channel_deletion_batch_failure_probe() returns trigger as $$
      begin
        if old.recipient_id = ${sql.raw(`'${SCOPE_PREFIX}batch-failure-probe'`)} then
          raise exception 'channel deletion batch probe';
        end if;
        return old;
      end;
      $$ language plpgsql;
    `);
    await db.execute(sql`
      create or replace trigger channel_deletion_batch_failure_probe_trigger
      before delete on notifications
      for each row execute function channel_deletion_batch_failure_probe();
    `);

    try {
      await expect(deleteChannelContent(CHANNEL, { dryRun: false })).rejects.toThrow(
        /cascade step\(s\) failed/,
      );
    } finally {
      await db.execute(sql`drop trigger if exists channel_deletion_batch_failure_probe_trigger on notifications`);
      await db.execute(sql`drop function if exists channel_deletion_batch_failure_probe()`);
    }

    // THE PROPERTY: the transaction rolled back, so the post is still there —
    // and the caller was told rather than handed a clean-looking report.
    expect(await postExists(channelPost.id), 'a rolled-back batch must leave its posts').toBe(true);
  });

  it('sends a post Tombstone while the post still exists', async () => {
    await seedRemoteFollower();
    const channelPost = await seedChannelPost();
    const postAliveAtCallTime: boolean[] = [];
    federateDelete.mockImplementation(async (post: { id: string }) => {
      postAliveAtCallTime.push(await postExists(post.id));
    });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(federateDelete, 'the channel has an accepted inbound follower').toHaveBeenCalledTimes(1);
    expect(
      postAliveAtCallTime,
      'a Tombstone sent after the DELETE strands remote copies on every retry',
    ).toEqual([true]);
    expect(await postExists(channelPost.id)).toBe(false);
  });

  it('sends the actor Delete while the follow rows it addresses are still there', async () => {
    await seedRemoteFollower();
    await seedChannelPost();
    const followersAtCallTime: number[] = [];
    deliverToFollowers.mockImplementation(async () => {
      const rows = await getDb()
        .select({ id: federatedFollows.id })
        .from(federatedFollows)
        .where(eq(federatedFollows.localUserId, CHANNEL));
      followersAtCallTime.push(rows.length);
    });

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(
      followersAtCallTime,
      'deliverToFollowers resolves inboxes from these rows; after the account phase it reaches nobody',
    ).toEqual([1]);
    expect(
      await getDb()
        .select({ id: federatedFollows.id })
        .from(federatedFollows)
        .where(eq(federatedFollows.localUserId, CHANNEL)),
      'and they are gone by the end of the run',
    ).toEqual([]);
  });

  it('federates nothing when the channel has no remote followers', async () => {
    // The control, and a real decision rather than an optimisation: with nobody to
    // deliver to, resolving the username would be a round trip to Oxy for no
    // delivery — and the resolve is what THROWS when identity is unavailable.
    await seedChannelPost();

    await deleteChannelContent(CHANNEL, { dryRun: false });

    expect(federateDelete).not.toHaveBeenCalled();
    expect(deliverToFollowers).not.toHaveBeenCalled();
  });

  it('aborts before deleting anything when the channel username will not resolve', async () => {
    await seedRemoteFollower();
    const channelPost = await seedChannelPost();
    getUserById.mockResolvedValue({ username: '  ' });

    await expect(deleteChannelContent(CHANNEL, { dryRun: false })).rejects.toThrow(
      /no resolvable username/,
    );
    expect(
      await postExists(channelPost.id),
      'the canonical Note ids a remote server matches are minted from that username',
    ).toBe(true);
  });
});
