/**
 * THE STEPS: the one place an erasure-map entry's Postgres shape is written down.
 *
 * Keyed exactly like `ACCOUNT_ERASURE_MAP` (`table.column`). The coverage test
 * holds the two together: every executable map entry has a step here, and every
 * step here has a map entry. `database` and `retain` entries have no step on
 * purpose (see `erasureMap.ts`). `posts.oxyUserId` has no step here either,
 * because the post walk in `erasePosts.ts` performs it. It is named in
 * {@link STEPS_PERFORMED_ELSEWHERE} so the binding stays exhaustive.
 *
 * Every step is idempotent: its predicate names the account, and a second run
 * over rows that are already gone or already anonymised matches nothing. Large
 * deletes go in bounded batches (`deleteInBatches`), so one account with a large
 * footprint never holds a single long transaction.
 *
 * Each step has two halves: `count` (the dry run, strictly read-only) and
 * `apply` (the live write). Both return a row count.
 */

import { and, count, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getDb } from '../../db/postgres';
import { articles } from '../../db/schema/articles';
import { blocklistProposals } from '../../db/schema/blocklist';
import { laneMutes, lanes } from '../../db/schema/channels';
import { authorFollowerSnapshots, notifications, pushTokens, trending } from '../../db/schema/discovery';
import {
  bookmarks,
  entityFollows,
  likes,
  muteWords,
  mutes,
  pokes,
  postSubscriptions,
} from '../../db/schema/engagement';
import {
  actorKeyPairs,
  federatedActors,
  federatedFollows,
  federatedIdentityLinks,
  federationDeliveryQueue,
} from '../../db/schema/federation';
import {
  customFeedMembers,
  customFeeds,
  feedGenerators,
  feedInteractions,
  feedLikes,
  feedReviews,
  userFeedPreferences,
} from '../../db/schema/feeds';
import { postgates, threadgates } from '../../db/schema/gates';
import { postImports } from '../../db/schema/imports';
import {
  mentionJobApplicationNotes,
  mentionJobApplications,
  mentionJobs,
} from '../../db/schema/jobs';
import {
  accountListMembers,
  accountLists,
  starterPackMembers,
  starterPackUses,
  starterPacks,
} from '../../db/schema/lists';
import { mcpAuthCodes, mcpConnections, mcpEffectReceipts } from '../../db/schema/mcp';
import { contentLabels, labelers, reports } from '../../db/schema/moderation';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../db/schema/mtn';
import { endorsementOutbox, engagementOutbox } from '../../db/schema/outbox';
import { pollVotes, polls } from '../../db/schema/polls';
import {
  postAuthorships,
  postCorrections,
  postMentions,
  postRecentRepliers,
} from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { userBehaviorAuthors, userBehaviors, userSettings } from '../../db/schema/userProfile';
import { recomputeRecentRepliers } from '../PostRecentReplierService';
import { ERASED_ACCOUNT_SENTINEL, type ErasurePhase } from './erasureMap';
import { ERASURE_DELETE_BATCH } from './erasureLimits';

/** What every step is pointed at. */
export interface ErasureContext {
  readonly oxyUserId: string;
}

export interface ErasureStep {
  readonly phase: ErasurePhase;
  /** Tiebreaker within a phase; otherwise steps run in the order they are declared. */
  readonly order?: number;
  /** Rows the step would affect. Read-only. */
  readonly count: (ctx: ErasureContext) => Promise<number>;
  /** The live write. Returns rows affected. */
  readonly apply: (ctx: ErasureContext) => Promise<number>;
}


async function countRows(table: PgTable, where: SQL): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(table).where(where);
  return row.n;
}

/**
 * Delete every row matching `where`, `ERASURE_DELETE_BATCH` at a time. Keyed on
 * the primary key through a subquery, so each statement is bounded however many
 * rows match. Converges: it loops until a batch comes back short.
 */
export async function deleteInBatches(table: PgTable, pk: PgColumn, where: SQL): Promise<number> {
  const db = getDb();
  let total = 0;
  for (;;) {
    const batch = db.select({ pk }).from(table).where(where).limit(ERASURE_DELETE_BATCH);
    const removed = await db
      .delete(table)
      .where(inArray(pk, batch))
      .returning({ one: sql<number>`1` });
    total += removed.length;
    if (removed.length < ERASURE_DELETE_BATCH) return total;
  }
}

function deleteRows(
  phase: ErasurePhase,
  table: PgTable,
  pk: PgColumn,
  where: (ctx: ErasureContext) => SQL,
  order?: number,
): ErasureStep {
  return {
    phase,
    order,
    count: (ctx) => countRows(table, where(ctx)),
    apply: (ctx) => deleteInBatches(table, pk, where(ctx)),
  };
}

/** `column = <the account>`. */
function accountIs(column: PgColumn) {
  return (ctx: ErasureContext): SQL => eq(column, ctx.oxyUserId);
}

/** Rows whose `text[]` column still contains the account. */
function arrayHas(column: PgColumn) {
  return (ctx: ErasureContext): SQL => sql`${column} && ${sql.param([ctx.oxyUserId])}::text[]`;
}

/**
 * Remove the account from an array column, keeping the row. `array_remove` is one
 * statement (two concurrent erasures cannot lose each other's edit) and is
 * idempotent.
 */
function pullFromArray(table: PgTable, column: PgColumn, pk: PgColumn): ErasureStep {
  const where = arrayHas(column);
  return {
    phase: 'account',
    count: (ctx) => countRows(table, where(ctx)),
    apply: async (ctx) => {
      const changed = await getDb()
        .update(table)
        .set({ [columnKey(table, column)]: sql`array_remove(${column}, ${ctx.oxyUserId})` })
        .where(where(ctx))
        .returning({ pk });
      return changed.length;
    },
  };
}

/** Replace the account id with `value` (NULL or the sentinel), keeping the row. */
function replaceAccount(
  table: PgTable,
  column: PgColumn,
  pk: PgColumn,
  value: string | null,
  extra?: (ctx: ErasureContext) => SQL | undefined,
): ErasureStep {
  const where = (ctx: ErasureContext): SQL => and(eq(column, ctx.oxyUserId), extra?.(ctx)) ?? eq(column, ctx.oxyUserId);
  return {
    phase: 'account',
    count: (ctx) => countRows(table, where(ctx)),
    apply: async (ctx) => {
      const changed = await getDb()
        .update(table)
        .set({ [columnKey(table, column)]: value })
        .where(where(ctx))
        .returning({ pk });
      return changed.length;
    },
  };
}

/**
 * The drizzle PROPERTY name of `column` on `table`, which is what `.set()` is
 * keyed by. Resolved by identity rather than by `column.name`, so a column that
 * does not belong to the table throws here instead of writing nothing.
 */
function columnKey(table: PgTable, column: PgColumn): string {
  for (const [key, candidate] of Object.entries(table)) {
    if (candidate === column) return key;
  }
  throw new Error('erasure step: column does not belong to its table');
}

/**
 * Delete a batch of the account's likes and take them off the counters of the
 * posts they were counted on, in ONE statement. A data-modifying CTE commits the
 * delete and the decrement together, so a crash cannot leave a like deleted and
 * still counted, or a retry decrement twice. `greatest(0, …)` matches the live
 * unlike path, so a counter that already lags cannot go negative.
 */
async function eraseLikesBatch(oxyUserId: string): Promise<number> {
  const [row] = await getDb().execute<{ removed: number }>(sql`
    with gone as (
      delete from ${likes}
      where id in (select id from ${likes} where user_id = ${oxyUserId} limit ${ERASURE_DELETE_BATCH})
      returning post_id, value
    ), agg as (
      select post_id,
             count(*) filter (where value = 1)::int as up,
             count(*) filter (where value = -1)::int as down
      from gone group by post_id
    ), repaired as (
      update ${posts}
      set stats_likes_count = greatest(0, ${posts}.stats_likes_count - agg.up),
          stats_downvotes_count = greatest(0, ${posts}.stats_downvotes_count - agg.down)
      from agg where ${posts}.id = agg.post_id
      returning 1
    )
    select (select count(*) from gone)::int as removed
  `);
  return Number(row?.removed ?? 0);
}

/** The same shape for saves: `bookmarks` → `posts.stats_saves_count`. */
async function eraseBookmarksBatch(oxyUserId: string): Promise<number> {
  const [row] = await getDb().execute<{ removed: number }>(sql`
    with gone as (
      delete from ${bookmarks}
      where id in (select id from ${bookmarks} where user_id = ${oxyUserId} limit ${ERASURE_DELETE_BATCH})
      returning post_id
    ), agg as (
      select post_id, count(*)::int as saves from gone group by post_id
    ), repaired as (
      update ${posts}
      set stats_saves_count = greatest(0, ${posts}.stats_saves_count - agg.saves)
      from agg where ${posts}.id = agg.post_id
      returning 1
    )
    select (select count(*) from gone)::int as removed
  `);
  return Number(row?.removed ?? 0);
}

async function untilShort(batch: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const removed = await batch();
    total += removed;
    if (removed < ERASURE_DELETE_BATCH) return total;
  }
}

/**
 * Remove the account from other people's reply-avatar strips and recompute each
 * strip from the surviving replies, so the next replier takes the slot.
 */
async function eraseRecentRepliers(oxyUserId: string): Promise<number> {
  const db = getDb();
  let total = 0;
  for (;;) {
    const rows = await db
      .select({ id: postRecentRepliers.id, postId: postRecentRepliers.postId })
      .from(postRecentRepliers)
      .where(eq(postRecentRepliers.oxyUserId, oxyUserId))
      .limit(ERASURE_DELETE_BATCH);
    if (rows.length === 0) return total;
    const postIds = [...new Set(rows.map((row) => row.postId))];
    await db.transaction(async (tx) => {
      await tx.delete(postRecentRepliers).where(inArray(postRecentRepliers.id, rows.map((row) => row.id)));
      for (const postId of postIds) await recomputeRecentRepliers(postId, tx);
    });
    total += rows.length;
  }
}

/**
 * Reports the account filed. Undelivered ones are deleted (nothing downstream
 * holds them); delivered ones keep their row for CrowdSource's decision to land
 * on, with the reporter replaced per row and the free-text details cleared.
 */
async function eraseFiledReports(oxyUserId: string): Promise<number> {
  const db = getDb();
  const undelivered = and(eq(reports.reporter, oxyUserId), sql`${reports.crowdSourceReportId} is null`);
  const deleted = undelivered ? await deleteInBatches(reports, reports.id, undelivered) : 0;
  const anonymised = await db
    .update(reports)
    .set({ reporter: sql`'erased:' || ${reports.id}`, details: null })
    .where(eq(reports.reporter, oxyUserId))
    .returning({ id: reports.id });
  return deleted + anonymised.length;
}

/**
 * Labelers the account created. An official labeler is platform moderation and
 * is kept with its creator anonymised; any other is deleted, and its definitions
 * and applied labels cascade.
 */
async function eraseLabelers(oxyUserId: string): Promise<number> {
  const db = getDb();
  const official = await db
    .update(labelers)
    .set({ creatorId: ERASED_ACCOUNT_SENTINEL })
    .where(and(eq(labelers.creatorId, oxyUserId), eq(labelers.isOfficial, true)))
    .returning({ id: labelers.id });
  const removed = await deleteInBatches(
    labelers,
    labelers.id,
    and(eq(labelers.creatorId, oxyUserId), eq(labelers.isOfficial, false)) ?? eq(labelers.creatorId, oxyUserId),
  );
  return official.length + removed;
}

/**
 * The account's lists, after other people's follows of them. `entity_follows`
 * names a list by a plain id with no foreign key, so those rows would otherwise
 * point at nothing.
 */
async function eraseOwnedLists(oxyUserId: string): Promise<number> {
  const owned = getDb()
    .select({ id: accountLists.id })
    .from(accountLists)
    .where(eq(accountLists.ownerOxyUserId, oxyUserId));
  await deleteInBatches(
    entityFollows,
    entityFollows.id,
    and(eq(entityFollows.entityType, 'list'), inArray(entityFollows.entityId, owned)) ??
      eq(entityFollows.entityType, 'list'),
  );
  return deleteInBatches(accountLists, accountLists.id, eq(accountLists.ownerOxyUserId, oxyUserId));
}

/**
 * The account's MTN node rows. A self-hosted node is deleted; a managed vault is
 * revoked so the node-fleet reconciler tears its volume down from the row.
 */
async function eraseUserNodes(oxyUserId: string): Promise<number> {
  const revoked = await getDb()
    .update(mentionUserNodes)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(mentionUserNodes.oxyUserId, oxyUserId),
        eq(mentionUserNodes.managed, true),
        ne(mentionUserNodes.status, 'revoked'),
      ),
    )
    .returning({ id: mentionUserNodes.id });
  const removed = await deleteInBatches(
    mentionUserNodes,
    mentionUserNodes.id,
    and(eq(mentionUserNodes.oxyUserId, oxyUserId), eq(mentionUserNodes.managed, false)) ??
      eq(mentionUserNodes.oxyUserId, oxyUserId),
  );
  return revoked.length + removed;
}

/**
 * `activity_json->>'type' = 'Delete'` rows are spared: a re-run must not cancel
 * the Deletes an earlier attempt of this erasure queued.
 */
function drainablePredicate(ctx: ErasureContext): SQL {
  return sql`${federationDeliveryQueue.senderOxyUserId} = ${ctx.oxyUserId}
    and coalesce(${federationDeliveryQueue.activityJson} ->> 'type', '') <> 'Delete'`;
}

/** Rows not owned by the account whose column names it. */
function notOwnPost(ctx: ErasureContext): SQL {
  return or(sql`${posts.oxyUserId} is null`, ne(posts.oxyUserId, ctx.oxyUserId)) ?? ne(posts.oxyUserId, ctx.oxyUserId);
}

/**
 * Map keys the post walk performs, not a step here. Listed so the coverage test
 * can require that every executable map entry is bound SOMEWHERE.
 */
export const STEPS_PERFORMED_ELSEWHERE: ReadonlyMap<string, string> = new Map([
  ['posts.oxyUserId', 'erasePosts.ts: the keyset walk'],
]);

export const ERASURE_STEPS: Readonly<Record<string, ErasureStep>> = {
  // --- drain ------------------------------------------------------------------
  'federation_delivery_queue.senderOxyUserId': deleteRows(
    'drain',
    federationDeliveryQueue,
    federationDeliveryQueue.id,
    drainablePredicate,
  ),

  // --- posts-adjacent, after the walk ------------------------------------------
  'post_authorships.oxyUserId': deleteRows('account', postAuthorships, postAuthorships.id, accountIs(postAuthorships.oxyUserId)),
  'posts.writtenByOxyUserId': replaceAccount(posts, posts.writtenByOxyUserId, posts.id, null, notOwnPost),
  'posts.contentRoomHost': replaceAccount(posts, posts.contentRoomHost, posts.id, null, notOwnPost),
  'post_corrections.correctedByOxyUserId': replaceAccount(
    postCorrections,
    postCorrections.correctedByOxyUserId,
    postCorrections.id,
    ERASED_ACCOUNT_SENTINEL,
  ),
  'post_imports.oxyUserId': deleteRows('account', postImports, postImports.postId, accountIs(postImports.oxyUserId)),
  'post_mentions.oxyUserId': deleteRows('account', postMentions, postMentions.id, accountIs(postMentions.oxyUserId)),
  'post_subscriptions.subscriberId': deleteRows('account', postSubscriptions, postSubscriptions.id, accountIs(postSubscriptions.subscriberId)),
  'post_subscriptions.authorId': deleteRows('account', postSubscriptions, postSubscriptions.id, accountIs(postSubscriptions.authorId)),
  'polls.createdBy': deleteRows('account', polls, polls.id, accountIs(polls.createdBy)),
  'articles.createdBy': deleteRows('account', articles, articles.id, accountIs(articles.createdBy)),
  'postgates.createdBy': deleteRows('account', postgates, postgates.id, accountIs(postgates.createdBy)),
  'threadgates.createdBy': deleteRows('account', threadgates, threadgates.id, accountIs(threadgates.createdBy)),

  // --- engagement -------------------------------------------------------------
  'likes.userId': {
    phase: 'engagement',
    count: (ctx) => countRows(likes, eq(likes.userId, ctx.oxyUserId)),
    apply: (ctx) => untilShort(() => eraseLikesBatch(ctx.oxyUserId)),
  },
  'bookmarks.userId': {
    phase: 'engagement',
    count: (ctx) => countRows(bookmarks, eq(bookmarks.userId, ctx.oxyUserId)),
    apply: (ctx) => untilShort(() => eraseBookmarksBatch(ctx.oxyUserId)),
  },
  'poll_votes.userId': deleteRows('engagement', pollVotes, pollVotes.id, accountIs(pollVotes.userId)),
  'feed_interactions.userId': deleteRows('engagement', feedInteractions, feedInteractions.id, accountIs(feedInteractions.userId)),
  'post_recent_repliers.oxyUserId': {
    phase: 'engagement',
    count: (ctx) => countRows(postRecentRepliers, eq(postRecentRepliers.oxyUserId, ctx.oxyUserId)),
    apply: (ctx) => eraseRecentRepliers(ctx.oxyUserId),
  },

  // --- account ----------------------------------------------------------------
  'user_settings.oxyUserId': deleteRows('account', userSettings, userSettings.id, accountIs(userSettings.oxyUserId)),
  'user_settings.privacyRestrictedUsers': pullFromArray(userSettings, userSettings.privacyRestrictedUsers, userSettings.id),
  'user_feed_preferences.oxyUserId': deleteRows('account', userFeedPreferences, userFeedPreferences.id, accountIs(userFeedPreferences.oxyUserId)),
  'user_behaviors.oxyUserId': deleteRows('account', userBehaviors, userBehaviors.id, accountIs(userBehaviors.oxyUserId)),
  'user_behavior_authors.authorId': deleteRows('account', userBehaviorAuthors, userBehaviorAuthors.id, accountIs(userBehaviorAuthors.authorId)),
  'user_behaviors.hiddenAuthors': pullFromArray(userBehaviors, userBehaviors.hiddenAuthors, userBehaviors.id),
  'user_behaviors.mutedAuthors': pullFromArray(userBehaviors, userBehaviors.mutedAuthors, userBehaviors.id),
  'user_behaviors.blockedAuthors': pullFromArray(userBehaviors, userBehaviors.blockedAuthors, userBehaviors.id),
  'author_follower_snapshots.oxyUserId': deleteRows('account', authorFollowerSnapshots, authorFollowerSnapshots.id, accountIs(authorFollowerSnapshots.oxyUserId)),
  'mutes.userId': deleteRows('account', mutes, mutes.id, accountIs(mutes.userId)),
  'mutes.mutedId': deleteRows('account', mutes, mutes.id, accountIs(mutes.mutedId)),
  'mute_words.userId': deleteRows('account', muteWords, muteWords.id, accountIs(muteWords.userId)),
  'pokes.pokerId': deleteRows('account', pokes, pokes.id, accountIs(pokes.pokerId)),
  'pokes.pokedId': deleteRows('account', pokes, pokes.id, accountIs(pokes.pokedId)),
  'entity_follows.userId': deleteRows('account', entityFollows, entityFollows.id, accountIs(entityFollows.userId)),
  'notifications.recipientId': deleteRows('account', notifications, notifications.id, accountIs(notifications.recipientId)),
  'notifications.actorId': deleteRows('account', notifications, notifications.id, accountIs(notifications.actorId)),
  'notifications.entityId': deleteRows(
    'account',
    notifications,
    notifications.id,
    (ctx) => and(eq(notifications.entityType, 'profile'), eq(notifications.entityId, ctx.oxyUserId)) ?? eq(notifications.entityId, ctx.oxyUserId),
  ),
  'push_tokens.userId': deleteRows('account', pushTokens, pushTokens.id, accountIs(pushTokens.userId)),
  'account_lists.ownerOxyUserId': {
    phase: 'account',
    count: (ctx) => countRows(accountLists, eq(accountLists.ownerOxyUserId, ctx.oxyUserId)),
    apply: (ctx) => eraseOwnedLists(ctx.oxyUserId),
  },
  'account_list_members.oxyUserId': deleteRows('account', accountListMembers, accountListMembers.id, accountIs(accountListMembers.oxyUserId)),
  'starter_packs.ownerOxyUserId': deleteRows('account', starterPacks, starterPacks.id, accountIs(starterPacks.ownerOxyUserId)),
  'starter_pack_members.oxyUserId': deleteRows('account', starterPackMembers, starterPackMembers.id, accountIs(starterPackMembers.oxyUserId)),
  'starter_pack_uses.oxyUserId': deleteRows('account', starterPackUses, starterPackUses.id, accountIs(starterPackUses.oxyUserId)),
  'custom_feeds.ownerOxyUserId': deleteRows('account', customFeeds, customFeeds.id, accountIs(customFeeds.ownerOxyUserId)),
  'custom_feed_members.oxyUserId': deleteRows('account', customFeedMembers, customFeedMembers.id, accountIs(customFeedMembers.oxyUserId)),
  'feed_likes.userId': deleteRows('account', feedLikes, feedLikes.id, accountIs(feedLikes.userId)),
  'feed_reviews.reviewerId': deleteRows('account', feedReviews, feedReviews.id, accountIs(feedReviews.reviewerId)),
  'feed_generators.createdBy': deleteRows('account', feedGenerators, feedGenerators.id, accountIs(feedGenerators.createdBy)),
  // Labelers before the labels: deleting a labeler takes its labels with it, and
  // the anonymise step below must only see labels under OTHER labelers.
  'labelers.creatorId': {
    phase: 'account',
    order: -1,
    count: (ctx) => countRows(labelers, eq(labelers.creatorId, ctx.oxyUserId)),
    apply: (ctx) => eraseLabelers(ctx.oxyUserId),
  },
  'content_labels.createdBy': replaceAccount(contentLabels, contentLabels.createdBy, contentLabels.id, ERASED_ACCOUNT_SENTINEL),
  'content_labels.targetId': deleteRows(
    'account',
    contentLabels,
    contentLabels.id,
    (ctx) => and(eq(contentLabels.targetType, 'user'), eq(contentLabels.targetId, ctx.oxyUserId)) ?? eq(contentLabels.targetId, ctx.oxyUserId),
  ),
  // Mutes of the account's lanes go before the lanes, so none is left to the
  // `lane_id` cascade alone (the two account columns carry no constraint).
  'lane_mutes.laneOwnerOxyUserId': deleteRows('account', laneMutes, laneMutes.id, accountIs(laneMutes.laneOwnerOxyUserId), -1),
  'lane_mutes.viewerOxyUserId': deleteRows('account', laneMutes, laneMutes.id, accountIs(laneMutes.viewerOxyUserId), -1),
  'lanes.ownerId': deleteRows('account', lanes, lanes.id, accountIs(lanes.ownerId)),
  'trending.actorIds': pullFromArray(trending, trending.actorIds, trending.id),
  'engagement_outbox.payloadActorOxyUserId': deleteRows('account', engagementOutbox, engagementOutbox.id, accountIs(engagementOutbox.payloadActorOxyUserId)),
  'engagement_outbox.payloadPostOwnerOxyUserId': deleteRows('account', engagementOutbox, engagementOutbox.id, accountIs(engagementOutbox.payloadPostOwnerOxyUserId)),
  'endorsement_outbox.pendingRemoveOwnerId': deleteRows('account', endorsementOutbox, endorsementOutbox.id, accountIs(endorsementOutbox.pendingRemoveOwnerId)),
  'endorsement_outbox.pendingRemoveMemberIds': pullFromArray(endorsementOutbox, endorsementOutbox.pendingRemoveMemberIds, endorsementOutbox.id),
  'mcp_connections.oxyUserId': deleteRows('account', mcpConnections, mcpConnections.id, accountIs(mcpConnections.oxyUserId)),
  'mcp_connections.activeOxyUserId': replaceAccount(mcpConnections, mcpConnections.activeOxyUserId, mcpConnections.id, null),
  'mcp_auth_codes.oxyUserId': deleteRows('account', mcpAuthCodes, mcpAuthCodes.id, accountIs(mcpAuthCodes.oxyUserId)),
  'mcp_effect_receipts.oxyUserId': deleteRows('account', mcpEffectReceipts, mcpEffectReceipts.id, accountIs(mcpEffectReceipts.oxyUserId)),
  'mention_jobs.employerOxyUserId': deleteRows('account', mentionJobs, mentionJobs.id, accountIs(mentionJobs.employerOxyUserId), -1),
  'mention_jobs.authorOxyUserId': replaceAccount(mentionJobs, mentionJobs.authorOxyUserId, mentionJobs.id, ERASED_ACCOUNT_SENTINEL),
  'mention_job_applications.applicantOxyUserId': deleteRows(
    'account',
    mentionJobApplications,
    mentionJobApplications.id,
    accountIs(mentionJobApplications.applicantOxyUserId),
    -1,
  ),
  'mention_job_applications.assignedToOxyUserId': replaceAccount(
    mentionJobApplications,
    mentionJobApplications.assignedToOxyUserId,
    mentionJobApplications.id,
    null,
  ),
  'mention_job_application_notes.authorOxyUserId': replaceAccount(
    mentionJobApplicationNotes,
    mentionJobApplicationNotes.authorOxyUserId,
    mentionJobApplicationNotes.id,
    ERASED_ACCOUNT_SENTINEL,
  ),
  'reports.reporter': {
    phase: 'account',
    count: (ctx) => countRows(reports, eq(reports.reporter, ctx.oxyUserId)),
    apply: (ctx) => eraseFiledReports(ctx.oxyUserId),
  },
  'blocklist_proposals.decidedBy': replaceAccount(
    blocklistProposals,
    blocklistProposals.decidedBy,
    blocklistProposals.id,
    ERASED_ACCOUNT_SENTINEL,
  ),
  'mention_signed_records.oxyUserId': deleteRows('account', mentionSignedRecords, mentionSignedRecords.id, accountIs(mentionSignedRecords.oxyUserId)),
  'mention_repo_heads.oxyUserId': deleteRows('account', mentionRepoHeads, mentionRepoHeads.id, accountIs(mentionRepoHeads.oxyUserId)),
  'mention_node_ingest_witnesses.oxyUserId': deleteRows(
    'account',
    mentionNodeIngestWitnesses,
    mentionNodeIngestWitnesses.id,
    accountIs(mentionNodeIngestWitnesses.oxyUserId),
  ),
  'mention_user_nodes.oxyUserId': {
    phase: 'account',
    count: (ctx) =>
      countRows(
        mentionUserNodes,
        and(
          eq(mentionUserNodes.oxyUserId, ctx.oxyUserId),
          or(eq(mentionUserNodes.managed, false), ne(mentionUserNodes.status, 'revoked')),
        ) ?? eq(mentionUserNodes.oxyUserId, ctx.oxyUserId),
      ),
    apply: (ctx) => eraseUserNodes(ctx.oxyUserId),
  },

  // --- federation, after the actor Delete -------------------------------------
  'federated_follows.localUserId': deleteRows('federation', federatedFollows, federatedFollows.id, accountIs(federatedFollows.localUserId)),
  'federated_identity_links.oxyUserId': deleteRows('federation', federatedIdentityLinks, federatedIdentityLinks.id, accountIs(federatedIdentityLinks.oxyUserId)),
  'federated_actors.oxyUserId': deleteRows('federation', federatedActors, federatedActors.id, accountIs(federatedActors.oxyUserId)),
  'actor_key_pairs.oxyUserId': deleteRows('federation', actorKeyPairs, actorKeyPairs.id, accountIs(actorKeyPairs.oxyUserId)),
};
