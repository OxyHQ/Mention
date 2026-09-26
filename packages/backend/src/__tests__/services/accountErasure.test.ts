import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, getTableColumns, getTableName, is, like, or, sql } from 'drizzle-orm';
import { PgTable, type PgColumn } from 'drizzle-orm/pg-core';

/**
 * `eraseOxyUser` / `processAccountErasure` against REAL ROWS (OxyHQ/Mention#1169).
 *
 * One account (ERASED) is given data in every category the erasure map names, and
 * a second account (OTHER) interacts with it: replies to it, boosts and quotes it,
 * lists it, mutes it, restricts it, reports it. The erasure runs twice. The
 * assertions are about what the database holds afterwards:
 *
 *  - GENERIC: for every executable map entry, no row still names ERASED in that
 *    column. Driven by the map itself, so a new entry is checked with no test edit.
 *  - SPECIFIC: what survives, and in what form (OTHER's reply keeps its words with
 *    no parent, its quote keeps its words with no pointer, counters on OTHER's
 *    posts drop by exactly ERASED's engagement, retained reports are still there).
 *  - FEDERATION: a Delete for each public post and a Delete of the actor were
 *    handed to delivery, and nothing for a draft.
 *
 * Only the remote edges are mocked: Oxy's user lookup and the ActivityPub delivery
 * fan-out.
 */

const deliverToFollowers = vi.hoisted(() => vi.fn(async () => undefined));
const getUserById = vi.hoisted(() => vi.fn());

vi.mock('../../connectors/activitypub/delivery.service', () => ({
  deliveryService: { deliverToFollowers },
}));
vi.mock('../../connectors/activitypub/follow.service', () => ({
  followService: {
    buildDeleteActivity: (username: string, postId: string) => ({
      id: `https://mention.test/ap/users/${username}/posts/${postId}/delete`,
      type: 'Delete',
    }),
  },
}));
/**
 * The erasure's batch sizes, shrunk so every chunked path (keyset post batches,
 * the chunked boost closure, bounded DELETEs) runs on a dozen rows. Seeding past
 * the real sizes (a thousand) is what made this file time out on a loaded CI
 * runner (OxyHQ/Mention#1178); the code under test is identical, only the
 * numbers it is handed differ.
 */
vi.mock('../../services/accountErasure/erasureLimits', () => ({
  ERASURE_POST_BATCH: 2,
  ERASURE_BOOST_CHUNK: 10,
  ERASURE_DELETE_BATCH: 10,
}));
vi.mock('../../utils/oxyHelpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/oxyHelpers')>()),
  getServiceOxyClient: () => ({ getUserById }),
}));

import * as schema from '../../db/schema';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { accountErasures } from '../../db/schema/accountErasures';
import { bookmarks, entityFollows, likes, mutes } from '../../db/schema/engagement';
import { accountListMembers, accountLists, starterPackMembers, starterPacks } from '../../db/schema/lists';
import { customFeedMembers, customFeeds, feedInteractions } from '../../db/schema/feeds';
import { notifications, trending } from '../../db/schema/discovery';
import { userBehaviors, userSettings } from '../../db/schema/userProfile';
import { mcpConnections } from '../../db/schema/mcp';
import { contentLabels, labelers, reports } from '../../db/schema/moderation';
import { mentionSignedRecords, mentionUserNodes } from '../../db/schema/mtn';
import { federatedFollows, federationDeliveryQueue } from '../../db/schema/federation';
import { mentionJobApplicationNotes, mentionJobApplications, mentionJobs } from '../../db/schema/jobs';
import { pollOptions, pollVotes, polls } from '../../db/schema/polls';
import { clearServiceScope, seedPost, serviceScope } from '../helpers/serviceFixtures';
import { recordAccountErasureRequest } from '../../db/accountErasures/accountErasureRepository';
import {
  eraseOxyUser,
  previewAccountErasure,
  processAccountErasure,
} from '../../services/accountErasure/AccountErasureService';
import { ACCOUNT_ERASURE_MAP, ERASED_ACCOUNT_SENTINEL, erasureKey } from '../../services/accountErasure/erasureMap';
import { ERASURE_STEPS } from '../../services/accountErasure/erasureSteps';
import {
  ERASURE_BOOST_CHUNK,
  ERASURE_DELETE_BATCH,
} from '../../services/accountErasure/erasureLimits';
import { PostType, PostVisibility } from '@mention/shared-types';

const scope = serviceScope('account-erasure');
const ERASED = scope.user('erased');
const OTHER = scope.user('other');
const PREFIX = `oxy-${scope.name}-`;
const USERNAME = 'erasedperson';

const tablesByName = new Map<string, PgTable>(
  Object.values(schema)
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => [getTableName(table), table]),
);

function columnOf(table: string, column: string): { table: PgTable; column: PgColumn } {
  const t = tablesByName.get(table);
  if (!t) throw new Error(`no table ${table}`);
  const c = (getTableColumns(t) as Record<string, PgColumn>)[column];
  if (!c) throw new Error(`no column ${table}.${column}`);
  return { table: t, column: c };
}

/** Rows in `table.column` still naming `account` (array columns by containment). */
async function rowsNaming(table: string, column: string, account: string): Promise<number> {
  const { table: t, column: c } = columnOf(table, column);
  const where =
    c.columnType === 'PgArray'
      ? sql`${c} && ${sql.param([account])}::text[]`
      : sql`${c} = ${account}`;
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(t).where(where);
  return row.n;
}

async function readPost(id: string) {
  const [row] = await getDb()
    .select({
      id: posts.id,
      parentPostId: posts.parentPostId,
      quoteOf: posts.quoteOf,
      isReply: posts.isReply,
      likes: posts.statsLikesCount,
      downvotes: posts.statsDownvotesCount,
      saves: posts.statsSavesCount,
      comments: posts.statsCommentsCount,
      boosts: posts.statsBoostsCount,
    })
    .from(posts)
    .where(eq(posts.id, id));
  return row;
}

interface Seeded {
  erasedPublic: string;
  erasedDraft: string;
  erasedReply: string;
  erasedBoost: string;
  otherPost: string;
  otherPost2: string;
  otherReplyToErased: string;
  otherBoostOfErased: string;
  otherQuoteOfErased: string;
  otherMentioning: string;
  otherListId: string;
  deliveredReportId: string;
  reportAboutErasedId: string;
  officialLabelerId: string;
}

async function seedEverything(): Promise<Seeded> {
  const db = getDb();

  const otherPost = await seedPost(scope, { oxyUserId: OTHER });
  const otherPost2 = await seedPost(scope, { oxyUserId: OTHER });
  const erasedPublic = await seedPost(scope, { oxyUserId: ERASED });
  const erasedDraft = await seedPost(scope, { oxyUserId: ERASED, status: 'draft' });
  const erasedReply = await seedPost(scope, { oxyUserId: ERASED, parentPostId: otherPost.id });
  const erasedBoost = await seedPost(scope, {
    oxyUserId: ERASED,
    type: PostType.BOOST,
    boostOf: otherPost2.id,
    content: { variants: [] },
  });
  await seedPost(scope, { oxyUserId: ERASED, quoteOf: otherPost.id, visibility: PostVisibility.FOLLOWERS });

  const otherReplyToErased = await seedPost(scope, { oxyUserId: OTHER, parentPostId: erasedPublic.id });
  const otherBoostOfErased = await seedPost(scope, {
    oxyUserId: OTHER,
    type: PostType.BOOST,
    boostOf: erasedPublic.id,
    content: { variants: [] },
  });
  const otherQuoteOfErased = await seedPost(scope, { oxyUserId: OTHER, quoteOf: erasedPublic.id });
  const otherMentioning = await seedPost(scope, { oxyUserId: OTHER, mentions: [ERASED] });

  // Counters on OTHER's posts that ERASED contributed to.
  await db
    .update(posts)
    .set({ statsLikesCount: 2, statsSavesCount: 1, statsCommentsCount: 1 })
    .where(eq(posts.id, otherPost.id));
  await db
    .update(posts)
    .set({ statsBoostsCount: 1, statsDownvotesCount: 1 })
    .where(eq(posts.id, otherPost2.id));

  await db.insert(likes).values([
    { userId: ERASED, postId: otherPost.id, value: 1 },
    { userId: OTHER, postId: otherPost.id, value: 1 },
    { userId: ERASED, postId: otherPost2.id, value: -1 },
    { userId: OTHER, postId: erasedPublic.id, value: 1 },
  ]);
  await db.insert(bookmarks).values({ userId: ERASED, postId: otherPost.id });

  // A poll on OTHER's post that ERASED voted in.
  const [poll] = await db
    .insert(polls)
    .values({ question: 'q', postId: otherPost.id, createdBy: OTHER, endsAt: new Date(Date.now() + 86_400_000) })
    .returning({ id: polls.id });
  const [option] = await db
    .insert(pollOptions)
    .values({ pollId: poll.id, position: 0, text: 'yes' })
    .returning({ id: pollOptions.id });
  await db.insert(pollVotes).values({ optionId: option.id, pollId: poll.id, userId: ERASED });

  await db.insert(feedInteractions).values({
    userId: ERASED,
    feedDescriptor: 'for_you',
    postUri: otherPost.id,
    event: 'impression',
  });

  await db.insert(userSettings).values([
    { oxyUserId: ERASED },
    { oxyUserId: OTHER, privacyRestrictedUsers: [ERASED, `${PREFIX}third`] },
  ]);
  await db.insert(userBehaviors).values([
    { oxyUserId: ERASED },
    { oxyUserId: OTHER, hiddenAuthors: [ERASED] },
  ]);
  await db.insert(mutes).values([
    { userId: ERASED, mutedId: OTHER },
    { userId: OTHER, mutedId: ERASED },
  ]);

  const [erasedList] = await db
    .insert(accountLists)
    .values({ ownerOxyUserId: ERASED, title: 'mine' })
    .returning({ id: accountLists.id });
  await db.insert(accountListMembers).values({ listId: erasedList.id, oxyUserId: OTHER, position: 0 });
  await db.insert(entityFollows).values([
    { userId: OTHER, entityType: 'list', entityId: erasedList.id },
    { userId: ERASED, entityType: 'hashtag', entityId: 'cats' },
  ]);
  const [otherList] = await db
    .insert(accountLists)
    .values({ ownerOxyUserId: OTHER, title: 'theirs' })
    .returning({ id: accountLists.id });
  await db.insert(accountListMembers).values([
    { listId: otherList.id, oxyUserId: ERASED, position: 0 },
    { listId: otherList.id, oxyUserId: `${PREFIX}third`, position: 1 },
  ]);

  const [otherPack] = await db
    .insert(starterPacks)
    .values({ ownerOxyUserId: OTHER, name: 'pack' })
    .returning({ id: starterPacks.id });
  await db.insert(starterPackMembers).values({ packId: otherPack.id, oxyUserId: ERASED, position: 0 });
  await db.insert(starterPacks).values({ ownerOxyUserId: ERASED, name: 'my pack' });

  const [otherFeed] = await db
    .insert(customFeeds)
    .values({ ownerOxyUserId: OTHER, title: 'feed' })
    .returning({ id: customFeeds.id });
  await db.insert(customFeedMembers).values({ feedId: otherFeed.id, oxyUserId: ERASED, position: 0 });
  await db.insert(customFeeds).values({ ownerOxyUserId: ERASED, title: 'my feed' });

  await db.insert(notifications).values([
    { recipientId: ERASED, actorId: OTHER, type: 'like', entityId: erasedPublic.id, entityType: 'post' },
    { recipientId: OTHER, actorId: ERASED, type: 'follow', entityId: OTHER, entityType: 'profile' },
    { recipientId: OTHER, actorId: `${PREFIX}third`, type: 'mention', entityId: ERASED, entityType: 'profile' },
  ]);

  await db.insert(mcpConnections).values([
    { oxyUserId: ERASED, clientId: 'c', clientLabel: 'Claude', scopes: ['read'], refreshTokenHash: 'h1', jti: `${PREFIX}j1` },
    {
      oxyUserId: OTHER,
      activeOxyUserId: ERASED,
      clientId: 'c',
      clientLabel: 'Claude',
      scopes: ['read'],
      refreshTokenHash: 'h2',
      jti: `${PREFIX}j2`,
    },
  ]);

  // Reports: one undelivered (deleted), one delivered (anonymised), one ABOUT the account (kept).
  await db.insert(reports).values({ reportedType: 'post', reportedId: otherPost.id, reporter: ERASED, categories: ['spam'] });
  const [delivered] = await db
    .insert(reports)
    .values({
      reportedType: 'post',
      reportedId: otherPost2.id,
      reporter: ERASED,
      categories: ['spam'],
      details: 'my own words',
      crowdSourceReportId: `${PREFIX}cs-1`,
    })
    .returning({ id: reports.id });
  const [aboutErased] = await db
    .insert(reports)
    .values({ reportedType: 'user', reportedId: ERASED, reporter: OTHER, categories: ['harassment'] })
    .returning({ id: reports.id });

  // Labelers: ERASED's own (deleted with its labels) and an official one (kept, anonymised).
  const [ownLabeler] = await db
    .insert(labelers)
    .values({ name: 'mine', creatorId: ERASED })
    .returning({ id: labelers.id });
  await db.insert(contentLabels).values({
    labelerId: ownLabeler.id,
    targetType: 'post',
    targetId: otherPost.id,
    labelSlug: 'nsfw',
    createdBy: ERASED,
  });
  const [official] = await db
    .insert(labelers)
    .values({ name: 'official', creatorId: ERASED, isOfficial: true })
    .returning({ id: labelers.id });
  await db.insert(contentLabels).values({
    labelerId: official.id,
    targetType: 'post',
    targetId: otherPost2.id,
    labelSlug: 'spam',
    createdBy: ERASED,
  });

  await db.insert(trending).values({
    type: 'hashtag',
    name: `${PREFIX}trend`,
    score: 1,
    rank: 1,
    calculatedAt: new Date(),
    actorIds: [ERASED, OTHER],
  });

  await db.insert(mentionSignedRecords).values({
    subjectDid: `did:mention:${ERASED}`,
    oxyUserId: ERASED,
    type: 'app_record',
    envelope: { text: 'signed post body' },
    publicKey: 'pk',
  });
  await db.insert(mentionUserNodes).values({
    oxyUserId: ERASED,
    endpoint: 'https://vault.example/erased',
    nodePublicKey: 'npk',
    managed: true,
    controller: 'oxy',
  });

  // Jobs: ERASED applied to OTHER's job, and wrote a note on another applicant as OTHER's operator.
  const [job] = await db
    .insert(mentionJobs)
    .values({
      employerOxyUserId: OTHER,
      authorOxyUserId: ERASED,
      title: 'job',
      description: 'd',
      slug: `${PREFIX}job`,
      applicationMode: 'mention',
    })
    .returning({ id: mentionJobs.id });
  await db.insert(mentionJobApplications).values({ jobId: job.id, applicantOxyUserId: ERASED, coverNote: 'hire me' });
  const [third] = await db
    .insert(mentionJobApplications)
    .values({ jobId: job.id, applicantOxyUserId: `${PREFIX}third`, assignedToOxyUserId: ERASED })
    .returning({ id: mentionJobApplications.id });
  await db
    .insert(mentionJobApplicationNotes)
    .values({ applicationId: third.id, authorOxyUserId: ERASED, note: 'strong candidate' });

  // Federation: a remote follower, a queued Create (cancelled) and a queued Delete (kept).
  await db.insert(federatedFollows).values({
    localUserId: ERASED,
    remoteActorUri: 'https://remote.example/users/fan',
    direction: 'inbound',
    status: 'accepted',
  });
  await db.insert(federationDeliveryQueue).values([
    {
      activityJson: { type: 'Create', id: `${PREFIX}create` },
      targetInbox: 'https://remote.example/inbox',
      senderOxyUserId: ERASED,
      nextAttemptAt: new Date(),
    },
    {
      activityJson: { type: 'Delete', id: `${PREFIX}delete` },
      targetInbox: 'https://remote.example/inbox',
      senderOxyUserId: ERASED,
      nextAttemptAt: new Date(),
    },
  ]);

  return {
    erasedPublic: erasedPublic.id,
    erasedDraft: erasedDraft.id,
    erasedReply: erasedReply.id,
    erasedBoost: erasedBoost.id,
    otherPost: otherPost.id,
    otherPost2: otherPost2.id,
    otherReplyToErased: otherReplyToErased.id,
    otherBoostOfErased: otherBoostOfErased.id,
    otherQuoteOfErased: otherQuoteOfErased.id,
    otherMentioning: otherMentioning.id,
    otherListId: otherList.id,
    deliveredReportId: delivered.id,
    reportAboutErasedId: aboutErased.id,
    officialLabelerId: official.id,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  const p = `${PREFIX}%`;
  await db.delete(federationDeliveryQueue).where(like(federationDeliveryQueue.senderOxyUserId, p));
  await db.delete(federatedFollows).where(like(federatedFollows.localUserId, p));
  await db.delete(mentionJobs).where(like(mentionJobs.slug, p));
  await db.delete(mentionUserNodes).where(like(mentionUserNodes.oxyUserId, p));
  await db.delete(mentionSignedRecords).where(like(mentionSignedRecords.oxyUserId, p));
  await db.delete(trending).where(like(trending.name, p));
  await db.delete(labelers).where(or(like(labelers.creatorId, p), eq(labelers.creatorId, ERASED_ACCOUNT_SENTINEL)));
  await db.delete(reports).where(or(like(reports.reporter, p), like(reports.reportedId, p), like(reports.crowdSourceReportId, p)));
  await db.delete(mcpConnections).where(like(mcpConnections.jti, p));
  await db.delete(notifications).where(or(like(notifications.recipientId, p), like(notifications.actorId, p)));
  await db.delete(customFeeds).where(like(customFeeds.ownerOxyUserId, p));
  await db.delete(starterPacks).where(like(starterPacks.ownerOxyUserId, p));
  await db.delete(entityFollows).where(like(entityFollows.userId, p));
  await db.delete(accountLists).where(like(accountLists.ownerOxyUserId, p));
  await db.delete(mutes).where(like(mutes.userId, p));
  await db.delete(userBehaviors).where(like(userBehaviors.oxyUserId, p));
  await db.delete(userSettings).where(like(userSettings.oxyUserId, p));
  await db.delete(feedInteractions).where(like(feedInteractions.userId, p));
  await db.delete(polls).where(like(polls.createdBy, p));
  await db.delete(bookmarks).where(like(bookmarks.userId, p));
  await db.delete(likes).where(like(likes.userId, p));
  await db.delete(accountErasures).where(like(accountErasures.oxyUserId, p));
  await clearServiceScope(scope);
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  getUserById.mockRejectedValue(Object.assign(new Error('Profile not found'), { status: 404 }));
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closePostgres();
});

/**
 * The one test given more than vitest's default five seconds, because its work is
 * inherently large rather than slow: it seeds every mapped category (about forty
 * tables), previews (one count per map entry), erases twice (every step, twice),
 * and then checks every map column for the account, around five hundred
 * sequential round trips in all. Measured: about 1 s alone, 3.4 s on a CI runner
 * sharing Postgres with nine other workers (OxyHQ/Mention#1178). Everything else
 * in this file runs on a dozen rows (see the `erasureLimits` mock) and keeps the
 * default.
 */
const FULL_PASS_TIMEOUT_MS = 20_000;

describe('eraseOxyUser on real rows', () => {
  it('erases every mapped category, keeps what the map keeps, and is a no-op the second time', async () => {
    const seeded = await seedEverything();

    const preview = await previewAccountErasure(ERASED);
    expect(preview['posts.oxyUserId']).toBe(5);
    expect(preview['likes.userId']).toBe(2);

    const first = await eraseOxyUser(ERASED, { reason: 'account.deleted', eventId: 'evt-1', username: USERNAME });
    expect(first.counts['posts.oxyUserId']).toBe(5);
    expect(first.counts['likes.userId']).toBe(2);
    expect(first.counts['federation.actorDelete']).toBe(1);

    // GENERIC: no executable map column still names the erased account.
    const leftovers: string[] = [];
    for (const entry of ACCOUNT_ERASURE_MAP) {
      if (!ERASURE_STEPS[erasureKey(entry)] && erasureKey(entry) !== 'posts.oxyUserId') continue;
      if (entry.disposition === 'revoke') continue; // asserted below: revoked, not deleted
      // The erasure's own queued Deletes are kept on purpose; asserted below.
      if (erasureKey(entry) === 'federation_delivery_queue.senderOxyUserId') continue;
      const n = await rowsNaming(entry.table, entry.column, ERASED);
      if (n > 0) leftovers.push(`${erasureKey(entry)}: ${n}`);
    }
    expect(leftovers, 'rows still naming the erased account').toEqual([]);

    // Posts: the account's are gone, OTHER's boost of one is gone.
    for (const id of [seeded.erasedPublic, seeded.erasedDraft, seeded.erasedReply, seeded.erasedBoost, seeded.otherBoostOfErased]) {
      expect(await readPost(id), id).toBeUndefined();
    }
    // OTHER's reply keeps its words, loses its parent, and stays a reply.
    const reply = await readPost(seeded.otherReplyToErased);
    expect(reply?.parentPostId).toBeNull();
    expect(reply?.isReply).toBe(true);
    // OTHER's quote keeps its words and loses the pointer.
    expect((await readPost(seeded.otherQuoteOfErased))?.quoteOf).toBeNull();
    // OTHER's post that mentioned the account survives.
    expect(await readPost(seeded.otherMentioning)).toBeDefined();

    // Counters on OTHER's posts drop by exactly ERASED's contribution.
    expect(await readPost(seeded.otherPost)).toMatchObject({ likes: 1, saves: 0, comments: 0 });
    expect(await readPost(seeded.otherPost2)).toMatchObject({ boosts: 0, downvotes: 0 });

    // OTHER's own engagement survives.
    const otherLikes = await getDb().select({ id: likes.id }).from(likes).where(eq(likes.userId, OTHER));
    expect(otherLikes).toHaveLength(1); // the like on ERASED's post went with the post

    // Arrays keep everyone else.
    const [otherSettings] = await getDb()
      .select({ restricted: userSettings.privacyRestrictedUsers })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, OTHER));
    expect(otherSettings.restricted).toEqual([`${PREFIX}third`]);
    const [trend] = await getDb().select({ actorIds: trending.actorIds }).from(trending).where(eq(trending.name, `${PREFIX}trend`));
    expect(trend.actorIds).toEqual([OTHER]);

    // OTHER's list survives with the other member; follows of ERASED's list are gone.
    const members = await getDb()
      .select({ oxyUserId: accountListMembers.oxyUserId })
      .from(accountListMembers)
      .where(eq(accountListMembers.listId, seeded.otherListId));
    expect(members.map((m) => m.oxyUserId)).toEqual([`${PREFIX}third`]);
    const listFollows = await getDb()
      .select({ id: entityFollows.id })
      .from(entityFollows)
      .where(and(eq(entityFollows.userId, OTHER), eq(entityFollows.entityType, 'list')));
    expect(listFollows).toHaveLength(0);

    // Notifications ABOUT the account from a third party are gone too.
    const aboutProfile = await getDb()
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.entityType, 'profile'), eq(notifications.entityId, ERASED)));
    expect(aboutProfile).toHaveLength(0);

    // OTHER's bundled connector survives with the pointer cleared.
    const [bundle] = await getDb()
      .select({ active: mcpConnections.activeOxyUserId })
      .from(mcpConnections)
      .where(eq(mcpConnections.oxyUserId, OTHER));
    expect(bundle.active).toBeNull();

    // Reports: undelivered gone, delivered anonymised without its details, the report ABOUT the account kept.
    const filed = await getDb()
      .select({ id: reports.id, reporter: reports.reporter, details: reports.details })
      .from(reports)
      .where(eq(reports.id, seeded.deliveredReportId));
    expect(filed).toEqual([{ id: seeded.deliveredReportId, reporter: `erased:${seeded.deliveredReportId}`, details: null }]);
    const about = await getDb().select({ id: reports.id }).from(reports).where(eq(reports.id, seeded.reportAboutErasedId));
    expect(about).toHaveLength(1);

    // The official labeler and its label stay, attributed to nobody.
    const [officialRow] = await getDb()
      .select({ creatorId: labelers.creatorId })
      .from(labelers)
      .where(eq(labelers.id, seeded.officialLabelerId));
    expect(officialRow.creatorId).toBe(ERASED_ACCOUNT_SENTINEL);
    const officialLabels = await getDb()
      .select({ createdBy: contentLabels.createdBy })
      .from(contentLabels)
      .where(eq(contentLabels.labelerId, seeded.officialLabelerId));
    expect(officialLabels).toEqual([{ createdBy: ERASED_ACCOUNT_SENTINEL }]);

    // Jobs: the application is gone; the employer's job and note stay, anonymised.
    const [job] = await getDb()
      .select({ author: mentionJobs.authorOxyUserId })
      .from(mentionJobs)
      .where(eq(mentionJobs.slug, `${PREFIX}job`));
    expect(job.author).toBe(ERASED_ACCOUNT_SENTINEL);
    const notes = await getDb().select({ author: mentionJobApplicationNotes.authorOxyUserId }).from(mentionJobApplicationNotes)
      .innerJoin(mentionJobApplications, eq(mentionJobApplications.id, mentionJobApplicationNotes.applicationId))
      .where(eq(mentionJobApplications.applicantOxyUserId, `${PREFIX}third`));
    expect(notes).toEqual([{ author: ERASED_ACCOUNT_SENTINEL }]);

    // MTN: the chain is gone; the managed vault is revoked for teardown, not deleted.
    const [vault] = await getDb()
      .select({ status: mentionUserNodes.status })
      .from(mentionUserNodes)
      .where(eq(mentionUserNodes.oxyUserId, ERASED));
    expect(vault.status).toBe('revoked');

    // Federation: the queued Create is cancelled, the queued Delete is not.
    const queued = await getDb()
      .select({ type: sql<string>`${federationDeliveryQueue.activityJson} ->> 'type'` })
      .from(federationDeliveryQueue)
      .where(eq(federationDeliveryQueue.senderOxyUserId, ERASED));
    expect(queued).toEqual([{ type: 'Delete' }]);

    // Delete(Note) for the public post and the reply; nothing for the draft or the
    // followers-only quote; then the actor Delete.
    const sentIds = deliverToFollowers.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(sentIds).toContain(`https://mention.test/ap/users/${USERNAME}/posts/${seeded.erasedPublic}/delete`);
    expect(sentIds).toContain(`https://mention.test/ap/users/${USERNAME}/posts/${seeded.erasedReply}/delete`);
    expect(sentIds.some((id) => id.includes(seeded.erasedDraft))).toBe(false);
    expect(sentIds.some((id) => id.endsWith('#delete'))).toBe(true);
    for (const call of deliverToFollowers.mock.calls) {
      expect(call[1]).toBe(ERASED);
      expect(call[2]).toBe(USERNAME);
    }

    // SECOND RUN: nothing left to do, nothing changes.
    deliverToFollowers.mockClear();
    const second = await eraseOxyUser(ERASED, { reason: 'account.deleted', eventId: 'evt-1', username: USERNAME });
    const nonZero = Object.entries(second.counts).filter(
      ([key, value]) => value !== 0 && key !== 'caches.dropped',
    );
    expect(nonZero, 'a second run must find nothing').toEqual([]);
    expect(await readPost(seeded.otherPost)).toMatchObject({ likes: 1, saves: 0, comments: 0 });
    expect(deliverToFollowers).not.toHaveBeenCalled();
  }, FULL_PASS_TIMEOUT_MS);

  it('sends nothing to the fediverse without a handle, and still erases', async () => {
    await seedPost(scope, { oxyUserId: ERASED });
    await getDb().insert(federatedFollows).values({
      localUserId: ERASED,
      remoteActorUri: 'https://remote.example/users/fan2',
      direction: 'inbound',
      status: 'accepted',
    });

    const report = await eraseOxyUser(ERASED, { reason: 'account.deleted', eventId: 'evt-x' });

    expect(report.federated).toBe(false);
    expect(report.counts['posts.oxyUserId']).toBe(1);
    expect(deliverToFollowers).not.toHaveBeenCalled();
    expect(await rowsNaming('federated_follows', 'localUserId', ERASED)).toBe(0);
  });

  it('clears a boost closure larger than one chunk, deepest level first, and batches big deletes', async () => {
    const original = await seedPost(scope, { oxyUserId: ERASED });
    // One past a chunk, so the closure is cleared in chunks and a DELETE batch
    // comes back full at least once.
    const boosterCount = ERASURE_BOOST_CHUNK + 1;
    const interactionCount = ERASURE_DELETE_BATCH + 1;
    const boosters = Array.from({ length: boosterCount }, (_, index) => ({
      oxyUserId: `${PREFIX}booster-${index}`,
      type: PostType.BOOST,
      visibility: PostVisibility.PUBLIC,
      status: 'published' as const,
      boostOf: original.id,
    }));
    const boosts = await getDb().insert(posts).values(boosters).returning({ id: posts.id });
    // A boost of a boost: level two of the closure.
    await getDb().insert(posts).values({
      oxyUserId: `${PREFIX}booster-deep`,
      type: PostType.BOOST,
      visibility: PostVisibility.PUBLIC,
      status: 'published',
      boostOf: boosts[0].id,
    });
    await getDb().insert(feedInteractions).values(
      Array.from({ length: interactionCount }, (_, index) => ({
        userId: ERASED,
        feedDescriptor: 'for_you',
        postUri: `${PREFIX}uri-${index}`,
        event: 'impression',
      })),
    );

    const report = await eraseOxyUser(ERASED, { reason: 'account.deleted', eventId: 'evt-big' });

    expect(report.counts['posts.oxyUserId']).toBe(1);
    expect(report.counts['posts.boostsByOthers']).toBe(boosterCount + 1);
    expect(report.counts['feed_interactions.userId']).toBe(interactionCount);
    const [left] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(posts)
      .where(like(posts.oxyUserId, `${PREFIX}booster-%`));
    expect(left.n).toBe(0);
  });

  it('treats an account Mention never saw as a successful no-op', async () => {
    const report = await eraseOxyUser(`${PREFIX}stranger`, { reason: 'account.deleted', eventId: 'evt-s' });
    const nonZero = Object.entries(report.counts).filter(([key, value]) => value !== 0 && key !== 'caches.dropped');
    expect(nonZero).toEqual([]);
  });
});

describe('processAccountErasure: the ledger, the lease and resumption', () => {
  async function record(eventId: string, username: string | null = USERNAME) {
    return recordAccountErasureRequest({
      eventId,
      oxyUserId: ERASED,
      source: 'webhook',
      reason: 'account.deleted',
      occurredAt: new Date(),
      retained: false,
      username,
    });
  }

  async function ledger(eventId: string) {
    const [row] = await getDb()
      .select({
        status: accountErasures.status,
        attempts: accountErasures.attempts,
        counts: accountErasures.counts,
        lastError: accountErasures.lastError,
        completedAt: accountErasures.completedAt,
      })
      .from(accountErasures)
      .where(eq(accountErasures.eventId, eventId));
    return row;
  }

  it('completes, records counts, and answers already-completed for the same event', async () => {
    const post = await seedPost(scope, { oxyUserId: ERASED });
    await record(`${PREFIX}evt-a`);

    const first = await processAccountErasure(`${PREFIX}evt-a`);
    expect(first.outcome).toBe('completed');
    const row = await ledger(`${PREFIX}evt-a`);
    expect(row.status).toBe('completed');
    expect(row.attempts).toBe(1);
    expect(row.counts?.['posts.oxyUserId']).toBe(1);
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(await readPost(post.id)).toBeUndefined();

    expect((await processAccountErasure(`${PREFIX}evt-a`)).outcome).toBe('already-completed');
    expect((await ledger(`${PREFIX}evt-a`)).attempts).toBe(1);
  });

  it('dedupes a redelivered event and never re-points it at another account', async () => {
    const first = await record(`${PREFIX}evt-d`);
    const again = await record(`${PREFIX}evt-d`);
    expect(first.inserted).toBe(true);
    expect(again.inserted).toBe(false);

    await expect(
      recordAccountErasureRequest({
        eventId: `${PREFIX}evt-d`,
        oxyUserId: OTHER,
        source: 'reconciliation',
        reason: 'account.deleted',
        occurredAt: null,
        retained: false,
        username: null,
      }),
    ).rejects.toThrow(/different account/);
  });

  it('resumes after a crash midway: the failure is recorded and a re-run completes', async () => {
    const post = await seedPost(scope, { oxyUserId: ERASED });
    await getDb().insert(federatedFollows).values({
      localUserId: ERASED,
      remoteActorUri: 'https://remote.example/users/fan3',
      direction: 'inbound',
      status: 'accepted',
    });
    await getDb().insert(likes).values({ userId: ERASED, postId: post.id, value: 1 });
    await record(`${PREFIX}evt-c`);

    // The actor Delete runs AFTER the post walk; failing it simulates a crash
    // with half the account already gone.
    deliverToFollowers.mockImplementation(async (activity: { id?: string }) => {
      if (String(activity.id).endsWith('#delete')) throw new Error('delivery backend down');
    });
    await expect(processAccountErasure(`${PREFIX}evt-c`)).rejects.toThrow(/delivery backend down/);
    const failed = await ledger(`${PREFIX}evt-c`);
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toMatch(/delivery backend down/);
    expect(await readPost(post.id)).toBeUndefined();
    expect(await rowsNaming('federated_follows', 'localUserId', ERASED)).toBe(1);

    deliverToFollowers.mockImplementation(async () => undefined);
    const resumed = await processAccountErasure(`${PREFIX}evt-c`);
    expect(resumed.outcome).toBe('completed');
    const done = await ledger(`${PREFIX}evt-c`);
    expect(done.status).toBe('completed');
    expect(done.attempts).toBe(2);
    expect(await rowsNaming('federated_follows', 'localUserId', ERASED)).toBe(0);
  });

  it('refuses to run an event with no ledger row', async () => {
    expect((await processAccountErasure(`${PREFIX}evt-none`)).outcome).toBe('unknown-event');
  });

  it('lets only one run hold an account at a time', async () => {
    await record(`${PREFIX}evt-l1`);
    await record(`${PREFIX}evt-l2`);
    // Simulate a live run of the first event.
    await getDb()
      .update(accountErasures)
      .set({ status: 'running', leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(accountErasures.eventId, `${PREFIX}evt-l1`));

    expect((await processAccountErasure(`${PREFIX}evt-l1`)).outcome).toBe('busy');
    expect((await processAccountErasure(`${PREFIX}evt-l2`)).outcome).toBe('busy');

    // A lapsed lease is reclaimable.
    await getDb()
      .update(accountErasures)
      .set({ leaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(accountErasures.eventId, `${PREFIX}evt-l1`));
    expect((await processAccountErasure(`${PREFIX}evt-l1`)).outcome).toBe('completed');
  });

  it('uses the handle Oxy still returns when the event carried none', async () => {
    await seedPost(scope, { oxyUserId: ERASED });
    await getDb().insert(federatedFollows).values({
      localUserId: ERASED,
      remoteActorUri: 'https://remote.example/users/fan4',
      direction: 'inbound',
      status: 'accepted',
    });
    getUserById.mockResolvedValue({ username: 'archivedhandle' });
    await record(`${PREFIX}evt-u`, null);

    await processAccountErasure(`${PREFIX}evt-u`);

    expect(deliverToFollowers).toHaveBeenCalled();
    expect(deliverToFollowers.mock.calls.every((call) => call[2] === 'archivedhandle')).toBe(true);
    const [row] = await getDb()
      .select({ username: accountErasures.username })
      .from(accountErasures)
      .where(eq(accountErasures.eventId, `${PREFIX}evt-u`));
    expect(row.username).toBe('archivedhandle');
  });
});
