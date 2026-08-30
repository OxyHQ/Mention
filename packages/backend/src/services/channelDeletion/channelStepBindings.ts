/**
 * THE TABLE — the ONE place a manifest step's Postgres shape is written down.
 *
 * Kept in manifest order so the two files diff against each other, and because
 * within a phase the executor runs steps in that order.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { qualified } from '@oxyhq/db';
import { postAuthorships, postMentions, postRecentRepliers } from '../../db/schema/postContent';
import { articles } from '../../db/schema/articles';
import { polls, pollVotes } from '../../db/schema/polls';
import { postgates, threadgates } from '../../db/schema/gates';
import {
  authorFollowerSnapshots,
  notifications,
  pushTokens,
  trending,
} from '../../db/schema/discovery';
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
  customFeedMembers,
  customFeeds,
  feedGenerators,
  feedInteractions,
  feedLikes,
  feedReviews,
  userFeedPreferences,
} from '../../db/schema/feeds';
import { accountListMembers, accountLists, starterPackMembers, starterPackUses, starterPacks } from '../../db/schema/lists';
import { contentLabels, labelers, moderationEnforcements, reports } from '../../db/schema/moderation';
import { endorsementOutbox, engagementOutbox } from '../../db/schema/outbox';
import { repairFetchFailures } from '../../db/schema/adminScripts';
import { lanes, laneMutes } from '../../db/schema/channels';
import { actorKeyPairs, federatedActors, federatedFollows, federationDeliveryQueue } from '../../db/schema/federation';
import { mcpAuthCodes, mcpConnections } from '../../db/schema/mcp';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../db/schema/mtn';
import { userBehaviorAuthors, userBehaviors, userSettings } from '../../db/schema/userProfile';
import {
  accountEq,
  arrayContainsAccount,
  pullValue,
  type StepBinding,
} from './channelCascadeBinding';
import { countOrDelete, countRows, deleteBatchPosts } from './channelCascadeQueries';
import { postKeysOf } from './channelDeletionTargets';

/**
 * The ONE place a manifest step's Postgres shape is written down: which table,
 * which phase, and — where the step is not a plain delete — exactly how.
 *
 * Kept in manifest order so the two files diff against each other, and because
 * within a phase the executor runs steps in that order.
 *
 * A manifest step whose action is `'database'` has NO entry here, on purpose: it
 * is performed by a constraint, and a binding for it would be a query that
 * re-runs the `DELETE`'s own work and could never be shown to have run. A step
 * whose action is `'retain'` has none either — a binding for one would be a query
 * nobody may run.
 */
export const STEP_BINDINGS: Readonly<Record<string, StepBinding>> = {
  // --- Post references no foreign key can express, DELEGATED ------------------
  // `PostDeletionCascade.cascadePostReferences` is the live delete route's own
  // implementation of these dispositions, and its `POST_REFERENCE_DISPOSITION` is
  // a `Record` over the preflight's probe list — so a reference type added
  // upstream breaks ITS build until somebody decides. A second copy here would
  // destroy that property.
  'notifications.entityId|channel-posts': { delegated: true, leg: 'notifications.entity_id' },
  'content_labels.targetId|channel-posts': {
    delegated: true,
    leg: 'content_labels.target_id(post)',
  },
  'postgates.postId|channel-posts': { delegated: true, leg: 'postgates.post_id/post_uri' },
  'postgates.postUri|channel-post-uris': { delegated: true, leg: 'postgates.post_id/post_uri' },
  'threadgates.postId|channel-posts': { delegated: true, leg: 'threadgates.post_id/post_uri' },
  'threadgates.postUri|channel-post-uris': {
    delegated: true,
    leg: 'threadgates.post_id/post_uri',
  },
  'feed_interactions.postUri|channel-post-uris': {
    delegated: true,
    leg: 'feed_interactions.post_uri',
  },

  // --- Post references executed by the batch loop -----------------------------
  // Scoped to the batch's captured id set, so they cannot be ordinary phase steps
  // — the ids only exist inside the loop, and only until the `DELETE`.
  'moderation_enforcements.subjectId|channel-posts': {
    inBatch: true,
    run: (batch, dryRun) =>
      countOrDelete(
        moderationEnforcements,
        sql`${eq(moderationEnforcements.subjectType, 'post')} and ${inArray(
          moderationEnforcements.subjectId,
          batch.rows.map((row) => row.id),
        )}`,
        dryRun,
      ),
  },
  'repair_fetch_failures.postId|channel-posts': {
    inBatch: true,
    run: (batch, dryRun) =>
      countOrDelete(
        repairFetchFailures,
        inArray(repairFetchFailures.postId, batch.rows.map((row) => row.id)),
        dryRun,
      ),
  },
  // Somebody else's postgate listing a doomed post among its detached quotes: the
  // row is theirs and stays, only the entry goes. NOT delegated — the delegate
  // deletes the postgate rows that BELONG to a doomed post, which is a different
  // question from an entry naming one inside a stranger's row.
  'postgates.detachedQuoteUris|channel-post-uris': {
    inBatch: true,
    run: async (batch, dryRun) => {
      const keys = postKeysOf(batch.rows);
      const where = sql`${postgates.detachedQuoteUris} && ${sql.param(keys)}::text[]`;
      if (dryRun) return countRows(postgates, where);
      const changed = await getDb()
        .update(postgates)
        .set({
          detachedQuoteUris: sql`(select coalesce(array_agg(elem), '{}'::text[]) from unnest(${qualified(postgates.detachedQuoteUris)}) as elem where elem <> all(${sql.param(keys)}::text[]))`,
        })
        .where(where)
        .returning({ id: postgates.id });
      return changed.length;
    },
  },

  // --- The channel's own posts -----------------------------------------------
  // Both are performed by the batch loop's own `DELETE`, which is what fires every
  // `ON DELETE CASCADE` above it. `writtenByOxyUserId` is counted BEFORE that
  // statement, because afterwards there is nothing left to count — and the number
  // means something on its own: how many of the channel's posts had a human behind
  // them. It is never used to reattribute one.
  'posts.oxyUserId|channel-account': {
    inBatch: true,
    run: (batch, dryRun) => deleteBatchPosts(batch, dryRun),
  },
  'posts.writtenByOxyUserId|channel-posts': {
    inBatch: true,
    run: (batch) =>
      Promise.resolve(batch.channelPosts.filter((row) => row.writtenByOxyUserId != null).length),
  },
  'post_authorships.oxyUserId|channel-account': {
    phase: 'account',
    table: postAuthorships,
    where: accountEq(postAuthorships.oxyUserId),
  },
  'post_mentions.oxyUserId|channel-account': {
    phase: 'account',
    table: postMentions,
    where: accountEq(postMentions.oxyUserId),
  },

  // --- Lanes -----------------------------------------------------------------
  // The lanes go LAST in their phase, so the mutes keyed on the publisher have
  // already been swept by the time the row that cascades the rest disappears.
  'lanes.ownerId|channel-account': {
    phase: 'lanes',
    order: 1,
    table: lanes,
    where: accountEq(lanes.ownerId),
  },
  'lane_mutes.laneOwnerOxyUserId|channel-account': {
    phase: 'lanes',
    order: 0,
    table: laneMutes,
    where: accountEq(laneMutes.laneOwnerOxyUserId),
  },
  'lane_mutes.viewerOxyUserId|channel-account': {
    phase: 'lanes',
    order: 0,
    table: laneMutes,
    where: accountEq(laneMutes.viewerOxyUserId),
  },

  // --- Federation ------------------------------------------------------------
  'federation_delivery_queue.senderOxyUserId|channel-account': {
    phase: 'federation-drain',
    table: federationDeliveryQueue,
    where: accountEq(federationDeliveryQueue.senderOxyUserId),
  },
  'federated_follows.localUserId|channel-account': {
    phase: 'account',
    table: federatedFollows,
    where: accountEq(federatedFollows.localUserId),
  },
  'actor_key_pairs.oxyUserId|channel-account': {
    phase: 'account',
    table: actorKeyPairs,
    where: accountEq(actorKeyPairs.oxyUserId),
  },
  'federated_actors.oxyUserId|channel-account': {
    phase: 'account',
    table: federatedActors,
    where: accountEq(federatedActors.oxyUserId),
  },

  // --- Rows keyed on the channel ACCOUNT -------------------------------------
  'notifications.entityId|channel-account': {
    phase: 'account',
    table: notifications,
    where: (targets) =>
      and(
        eq(notifications.entityType, 'profile'),
        eq(notifications.entityId, targets.channelOxyUserId),
      ),
  },
  'notifications.recipientId|channel-account': {
    phase: 'account',
    table: notifications,
    where: accountEq(notifications.recipientId),
  },
  'notifications.actorId|channel-account': {
    phase: 'account',
    table: notifications,
    where: accountEq(notifications.actorId),
  },
  'content_labels.targetId|channel-account': {
    phase: 'account',
    table: contentLabels,
    where: (targets) =>
      and(eq(contentLabels.targetType, 'user'), eq(contentLabels.targetId, targets.channelOxyUserId)),
  },
  'content_labels.createdBy|channel-account': {
    phase: 'account',
    table: contentLabels,
    where: accountEq(contentLabels.createdBy),
  },
  'reports.reporter|channel-account': {
    phase: 'account',
    table: reports,
    where: accountEq(reports.reporter),
  },
  'user_settings.oxyUserId|channel-account': {
    phase: 'account',
    table: userSettings,
    where: accountEq(userSettings.oxyUserId),
  },
  // Another person's privacy settings naming the channel; their row is theirs so
  // only the entry goes.
  'user_settings.privacyRestrictedUsers|channel-account': {
    phase: 'account',
    table: userSettings,
    where: arrayContainsAccount(userSettings.privacyRestrictedUsers),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userSettings)
          .set({ privacyRestrictedUsers: pullValue(userSettings.privacyRestrictedUsers, targets) })
          .where(where)
          .returning({ id: userSettings.id })
      ).length,
  },
  'author_follower_snapshots.oxyUserId|channel-account': {
    phase: 'account',
    table: authorFollowerSnapshots,
    where: accountEq(authorFollowerSnapshots.oxyUserId),
  },
  'mention_signed_records.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionSignedRecords,
    where: accountEq(mentionSignedRecords.oxyUserId),
  },
  'mention_repo_heads.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionRepoHeads,
    where: accountEq(mentionRepoHeads.oxyUserId),
  },
  'mention_user_nodes.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionUserNodes,
    where: accountEq(mentionUserNodes.oxyUserId),
  },
  'mention_node_ingest_witnesses.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionNodeIngestWitnesses,
    where: accountEq(mentionNodeIngestWitnesses.oxyUserId),
  },
  'engagement_outbox.payloadActorOxyUserId|channel-account': {
    phase: 'account',
    table: engagementOutbox,
    where: accountEq(engagementOutbox.payloadActorOxyUserId),
  },
  'engagement_outbox.payloadPostOwnerOxyUserId|channel-account': {
    phase: 'account',
    table: engagementOutbox,
    where: accountEq(engagementOutbox.payloadPostOwnerOxyUserId),
  },
  'user_behaviors.oxyUserId|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: accountEq(userBehaviors.oxyUserId),
  },
  'user_behavior_authors.authorId|channel-account': {
    phase: 'account',
    table: userBehaviorAuthors,
    where: accountEq(userBehaviorAuthors.authorId),
  },
  'user_behaviors.hiddenAuthors|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: arrayContainsAccount(userBehaviors.hiddenAuthors),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userBehaviors)
          .set({ hiddenAuthors: pullValue(userBehaviors.hiddenAuthors, targets) })
          .where(where)
          .returning({ id: userBehaviors.id })
      ).length,
  },
  'user_behaviors.mutedAuthors|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: arrayContainsAccount(userBehaviors.mutedAuthors),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userBehaviors)
          .set({ mutedAuthors: pullValue(userBehaviors.mutedAuthors, targets) })
          .where(where)
          .returning({ id: userBehaviors.id })
      ).length,
  },
  'user_behaviors.blockedAuthors|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: arrayContainsAccount(userBehaviors.blockedAuthors),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userBehaviors)
          .set({ blockedAuthors: pullValue(userBehaviors.blockedAuthors, targets) })
          .where(where)
          .returning({ id: userBehaviors.id })
      ).length,
  },
  'user_feed_preferences.oxyUserId|channel-account': {
    phase: 'account',
    table: userFeedPreferences,
    where: accountEq(userFeedPreferences.oxyUserId),
  },
  'mutes.mutedId|channel-account': {
    phase: 'account',
    table: mutes,
    where: accountEq(mutes.mutedId),
  },
  'mutes.userId|channel-account': {
    phase: 'account',
    table: mutes,
    where: accountEq(mutes.userId),
  },
  'mute_words.userId|channel-account': {
    phase: 'account',
    table: muteWords,
    where: accountEq(muteWords.userId),
  },
  'likes.userId|channel-account': {
    phase: 'account',
    table: likes,
    where: accountEq(likes.userId),
  },
  'bookmarks.userId|channel-account': {
    phase: 'account',
    table: bookmarks,
    where: accountEq(bookmarks.userId),
  },
  'post_subscriptions.subscriberId|channel-account': {
    phase: 'account',
    table: postSubscriptions,
    where: accountEq(postSubscriptions.subscriberId),
  },
  'post_subscriptions.authorId|channel-account': {
    phase: 'account',
    table: postSubscriptions,
    where: accountEq(postSubscriptions.authorId),
  },
  'post_recent_repliers.oxyUserId|channel-account': {
    phase: 'account',
    table: postRecentRepliers,
    where: accountEq(postRecentRepliers.oxyUserId),
  },
  'entity_follows.userId|channel-account': {
    phase: 'account',
    table: entityFollows,
    where: accountEq(entityFollows.userId),
  },
  'feed_interactions.userId|channel-account': {
    phase: 'account',
    table: feedInteractions,
    where: accountEq(feedInteractions.userId),
  },
  'feed_likes.userId|channel-account': {
    phase: 'account',
    table: feedLikes,
    where: accountEq(feedLikes.userId),
  },
  'feed_reviews.reviewerId|channel-account': {
    phase: 'account',
    table: feedReviews,
    where: accountEq(feedReviews.reviewerId),
  },
  'feed_generators.createdBy|channel-account': {
    phase: 'account',
    table: feedGenerators,
    where: accountEq(feedGenerators.createdBy),
  },
  'labelers.creatorId|channel-account': {
    phase: 'account',
    table: labelers,
    where: accountEq(labelers.creatorId),
  },
  'pokes.pokerId|channel-account': {
    phase: 'account',
    table: pokes,
    where: accountEq(pokes.pokerId),
  },
  'pokes.pokedId|channel-account': {
    phase: 'account',
    table: pokes,
    where: accountEq(pokes.pokedId),
  },
  'push_tokens.userId|channel-account': {
    phase: 'account',
    table: pushTokens,
    where: accountEq(pushTokens.userId),
  },
  'polls.createdBy|channel-account': {
    phase: 'account',
    table: polls,
    where: accountEq(polls.createdBy),
  },
  'poll_votes.userId|channel-account': {
    phase: 'account',
    table: pollVotes,
    where: accountEq(pollVotes.userId),
  },
  'articles.createdBy|channel-account': {
    phase: 'account',
    table: articles,
    where: accountEq(articles.createdBy),
  },
  'postgates.createdBy|channel-account': {
    phase: 'account',
    table: postgates,
    where: accountEq(postgates.createdBy),
  },
  'threadgates.createdBy|channel-account': {
    phase: 'account',
    table: threadgates,
    where: accountEq(threadgates.createdBy),
  },
  'account_lists.ownerOxyUserId|channel-account': {
    phase: 'account',
    table: accountLists,
    where: accountEq(accountLists.ownerOxyUserId),
  },
  'account_list_members.oxyUserId|channel-account': {
    phase: 'account',
    table: accountListMembers,
    where: accountEq(accountListMembers.oxyUserId),
  },
  'custom_feeds.ownerOxyUserId|channel-account': {
    phase: 'account',
    table: customFeeds,
    where: accountEq(customFeeds.ownerOxyUserId),
  },
  'custom_feed_members.oxyUserId|channel-account': {
    phase: 'account',
    table: customFeedMembers,
    where: accountEq(customFeedMembers.oxyUserId),
  },
  'starter_packs.ownerOxyUserId|channel-account': {
    phase: 'account',
    table: starterPacks,
    where: accountEq(starterPacks.ownerOxyUserId),
  },
  'starter_pack_members.oxyUserId|channel-account': {
    phase: 'account',
    table: starterPackMembers,
    where: accountEq(starterPackMembers.oxyUserId),
  },
  'starter_pack_uses.oxyUserId|channel-account': {
    phase: 'account',
    table: starterPackUses,
    where: accountEq(starterPackUses.oxyUserId),
  },
  'endorsement_outbox.pendingRemoveOwnerId|channel-account': {
    phase: 'account',
    table: endorsementOutbox,
    where: accountEq(endorsementOutbox.pendingRemoveOwnerId),
  },
  'endorsement_outbox.pendingRemoveMemberIds|channel-account': {
    phase: 'account',
    table: endorsementOutbox,
    where: arrayContainsAccount(endorsementOutbox.pendingRemoveMemberIds),
    update: async (targets, where) =>
      (
        await getDb()
          .update(endorsementOutbox)
          .set({
            pendingRemoveMemberIds: pullValue(endorsementOutbox.pendingRemoveMemberIds, targets),
          })
          .where(where)
          .returning({ id: endorsementOutbox.id })
      ).length,
  },
  'trending.actorIds|channel-account': {
    phase: 'account',
    table: trending,
    where: arrayContainsAccount(trending.actorIds),
    update: async (targets, where) =>
      (
        await getDb()
          .update(trending)
          .set({ actorIds: pullValue(trending.actorIds, targets) })
          .where(where)
          .returning({ id: trending.id })
      ).length,
  },
  'mcp_connections.oxyUserId|channel-account': {
    phase: 'account',
    table: mcpConnections,
    where: accountEq(mcpConnections.oxyUserId),
  },
  // Somebody else's connector whose ACTIVE account is the channel. Deleting their
  // row would revoke a person's connector over an account they merely switched to,
  // so the pointer is cleared and `mcpBundleService` falls back to the owner.
  'mcp_connections.activeOxyUserId|channel-account': {
    phase: 'account',
    table: mcpConnections,
    where: accountEq(mcpConnections.activeOxyUserId),
    update: async (_targets, where) =>
      (
        await getDb()
          .update(mcpConnections)
          .set({ activeOxyUserId: null })
          .where(where)
          .returning({ id: mcpConnections.id })
      ).length,
  },
  'mcp_auth_codes.oxyUserId|channel-account': {
    phase: 'account',
    table: mcpAuthCodes,
    where: accountEq(mcpAuthCodes.oxyUserId),
  },
};
