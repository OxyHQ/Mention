import {
  and,
  arrayContains,
  eq,
  exists,
  inArray,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { articles } from '../../db/schema/articles';
import { authorFollowerSnapshots, notifications, pushTokens } from '../../db/schema/discovery';
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
import { postgates, threadgates } from '../../db/schema/gates';
import {
  accountListMembers,
  accountLists,
  starterPackMembers,
  starterPackUses,
  starterPacks,
} from '../../db/schema/lists';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../db/schema/mtn';
import { contentLabels, labelers, reports } from '../../db/schema/moderation';
import { endorsementOutbox, engagementOutbox } from '../../db/schema/outbox';
import { pollVotes, polls } from '../../db/schema/polls';
import { postAuthorships, postMentions, postRecentRepliers } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { userBehaviorAuthors, userBehaviors, userSettings } from '../../db/schema/userProfile';
import { ReportedType } from '../../models/Report.model';
import {
  hasDeliveriesFromSender,
  hasDeliveriesReferencingObjects,
} from '../../db/federation/deliveryQueueRepository';
import { existsFollow } from '../../db/federation/followRepository';
import { hasActorKeyPair } from '../../db/federation/actorKeyPairRepository';
import { getDb } from '../../db/postgres';

export interface ReferenceProbe {
  name: string;
  hasReference: () => Promise<boolean>;
}

export interface PostDeletionTarget {
  id: string;
  uris?: readonly string[];
}

/**
 * Whether ANY row of `table` matches `where` — the Postgres analogue of
 * `Model.exists`, and the only shape a reference probe needs.
 *
 * EVERY probe in this file goes through this or `postExists`. That is the whole
 * repair: each probe used to ask a Mongoose model whose collection moved to
 * Postgres in an earlier batch and which nothing has written since, so it
 * answered "no reference" for every input — the preflight cleared EVERY
 * deletion, silently, in the permissive direction. A gate that fails open is
 * worse than an absent one, because the operator believes it ran.
 *
 * It surfaced only because post ids became uuid v7 and several Mongoose paths
 * are typed `ObjectId`, which turned the silence into a CastError. The columns
 * here are all `text`, so they hold either id space.
 */
async function anyRow(
  table: PgTable,
  idColumn: PgColumn,
  where: SQL | undefined,
): Promise<boolean> {
  const [row] = await getDb().select({ id: idColumn }).from(table).where(where).limit(1);
  return row !== undefined;
}

/** `anyRow` for the posts table itself, which every actor probe also needs. */
async function postExists(where: SQL | undefined): Promise<boolean> {
  return anyRow(posts, posts.id, where);
}

export interface ActorDeletionTarget {
  oxyUserId?: string;
  actorUri: string;
}

export class DeletionPreflightError extends Error {
  readonly blockers: readonly string[];

  constructor(context: string, blockers: readonly string[]) {
    super(
      `[${context}] deletion preflight found references that are not covered by a cascade: ` +
        blockers.join(', '),
    );
    this.name = 'DeletionPreflightError';
    this.blockers = blockers;
  }
}

/**
 * Run every probe instead of returning after the first match so the operator gets
 * one complete, bounded remediation list. A failed probe rejects the preflight:
 * inability to prove absence is never interpreted as safe-to-delete.
 */
export async function collectReferenceBlockers(
  probes: readonly ReferenceProbe[],
): Promise<string[]> {
  const results = await Promise.all(
    probes.map(async (probe) => ({
      name: probe.name,
      found: await probe.hasReference(),
    })),
  );
  return results.filter((result) => result.found).map((result) => result.name);
}

export function assertNoDeletionBlockers(
  context: string,
  blockers: readonly string[],
): void {
  if (blockers.length > 0) {
    throw new DeletionPreflightError(context, blockers);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Prove that deleting the supplied post rows will not leave a known reference
 * behind. `cascadeEngagement` is reserved for the gone-actor purge, which deletes
 * Like and Bookmark rows in the same awaited cascade before deleting the posts.
 */
export async function assertPostsSafeToDelete(
  context: string,
  targets: readonly PostDeletionTarget[],
  options: { cascadeEngagement?: boolean } = {},
): Promise<void> {
  if (targets.length === 0) return;

  const idStrings = unique(targets.map((target) => target.id));
  const postKeys = unique([
    ...idStrings,
    ...targets.flatMap((target) => target.uris ?? []),
  ]);

  const probes: ReferenceProbe[] = [
    {
      name: 'posts.boost_of/quote_of/parent_post_id/thread_id',
      hasReference: () =>
        postExists(
          and(
            notInArray(posts.id, idStrings),
            or(
              inArray(posts.boostOf, idStrings),
              inArray(posts.quoteOf, idStrings),
              inArray(posts.parentPostId, idStrings),
              inArray(posts.threadId, idStrings),
            ),
          ),
        ),
    },
    {
      name: 'notifications.entity_id',
      hasReference: () =>
        anyRow(
          notifications,
          notifications.id,
          and(
            inArray(notifications.entityType, ['post', 'reply']),
            inArray(notifications.entityId, idStrings),
          ),
        ),
    },
    {
      name: 'polls.post_id',
      hasReference: () => anyRow(polls, polls.id, inArray(polls.postId, idStrings)),
    },
    {
      name: 'articles.post_id',
      hasReference: () => anyRow(articles, articles.id, inArray(articles.postId, idStrings)),
    },
    {
      name: 'postgates.post_id/post_uri',
      hasReference: () =>
        anyRow(
          postgates,
          postgates.id,
          or(inArray(postgates.postId, idStrings), inArray(postgates.postUri, postKeys)),
        ),
    },
    {
      name: 'threadgates.post_id/post_uri',
      hasReference: () =>
        anyRow(
          threadgates,
          threadgates.id,
          or(inArray(threadgates.postId, idStrings), inArray(threadgates.postUri, postKeys)),
        ),
    },
    {
      name: 'post_recent_repliers.post_id',
      hasReference: () =>
        anyRow(
          postRecentRepliers,
          postRecentRepliers.id,
          inArray(postRecentRepliers.postId, idStrings),
        ),
    },
    {
      name: 'engagement_outbox.payload_post_id',
      hasReference: () =>
        anyRow(
          engagementOutbox,
          engagementOutbox.id,
          inArray(engagementOutbox.payloadPostId, idStrings),
        ),
    },
    {
      name: 'reports.reported_id(post)',
      hasReference: () =>
        anyRow(
          reports,
          reports.id,
          and(
            eq(reports.reportedType, ReportedType.POST),
            inArray(reports.reportedId, idStrings),
          ),
        ),
    },
    {
      name: 'content_labels.target_id(post)',
      hasReference: () =>
        anyRow(
          contentLabels,
          contentLabels.id,
          and(eq(contentLabels.targetType, 'post'), inArray(contentLabels.targetId, idStrings)),
        ),
    },
    {
      name: 'feed_interactions.post_uri',
      hasReference: () =>
        anyRow(feedInteractions, feedInteractions.id, inArray(feedInteractions.postUri, postKeys)),
    },
    {
      // The probe NAME follows the storage: a blocker message has to name
      // something an operator can go and look at.
      name: 'federation_delivery_queue.activity_json',
      hasReference: () => hasDeliveriesReferencingObjects(postKeys),
    },
  ];

  if (!options.cascadeEngagement) {
    probes.push(
      // These two now carry a real `ON DELETE CASCADE` to `posts.id`, so the
      // reference cannot be left DANGLING — which makes the probe MORE
      // load-bearing, not less. Under Mongo an unblocked delete left a visible
      // orphan; under Postgres it destroys the engagement row silently. The
      // caller's `cascadeEngagement` opt-out stays the only way past it.
      {
        name: 'likes.post_id',
        hasReference: () => anyRow(likes, likes.id, inArray(likes.postId, idStrings)),
      },
      {
        name: 'bookmarks.post_id',
        hasReference: () => anyRow(bookmarks, bookmarks.id, inArray(bookmarks.postId, idStrings)),
      },
    );
  }

  assertNoDeletionBlockers(context, await collectReferenceBlockers(probes));
}

function actorReferenceProbes(
  target: ActorDeletionTarget,
  includeReferencesRemovedByGoneActorCascade: boolean,
): ReferenceProbe[] {
  const oxyUserId = target.oxyUserId?.trim();
  const actorUri = target.actorUri;
  const probes: ReferenceProbe[] = [];

  if (oxyUserId) {
    probes.push(
      {
        name: 'bookmarks.user_id',
        hasReference: () => anyRow(bookmarks, bookmarks.id, eq(bookmarks.userId, oxyUserId)),
      },
      {
        name: 'mutes.user_id/muted_id',
        hasReference: () =>
          anyRow(mutes, mutes.id, or(eq(mutes.userId, oxyUserId), eq(mutes.mutedId, oxyUserId))),
      },
      {
        name: 'mute_words.user_id',
        hasReference: () => anyRow(muteWords, muteWords.id, eq(muteWords.userId, oxyUserId)),
      },
      {
        name: 'feed_interactions.user_id',
        hasReference: () =>
          anyRow(feedInteractions, feedInteractions.id, eq(feedInteractions.userId, oxyUserId)),
      },
      {
        name: 'feed_likes.user_id',
        hasReference: () => anyRow(feedLikes, feedLikes.id, eq(feedLikes.userId, oxyUserId)),
      },
      {
        name: 'feed_reviews.reviewer_id',
        hasReference: () =>
          anyRow(feedReviews, feedReviews.id, eq(feedReviews.reviewerId, oxyUserId)),
      },
      {
        name: 'post_subscriptions.subscriber_id/author_id',
        hasReference: () =>
          anyRow(
            postSubscriptions,
            postSubscriptions.id,
            or(
              eq(postSubscriptions.subscriberId, oxyUserId),
              eq(postSubscriptions.authorId, oxyUserId),
            ),
          ),
      },
      {
        name: 'push_tokens.user_id',
        hasReference: () => anyRow(pushTokens, pushTokens.id, eq(pushTokens.userId, oxyUserId)),
      },
      {
        name: 'pokes.poker_id/poked_id',
        hasReference: () =>
          anyRow(pokes, pokes.id, or(eq(pokes.pokerId, oxyUserId), eq(pokes.pokedId, oxyUserId))),
      },
      {
        name: 'reports.reporter/reported_id(user)',
        hasReference: () =>
          anyRow(
            reports,
            reports.id,
            or(
              eq(reports.reporter, oxyUserId),
              and(
                eq(reports.reportedType, ReportedType.USER),
                eq(reports.reportedId, oxyUserId),
              ),
            ),
          ),
      },
      {
        // Mongo embedded the ballots in `options.votes`; they are their own
        // table now, so the second arm is an EXISTS rather than a dotted path.
        name: 'polls.created_by/poll_votes.user_id',
        hasReference: () =>
          anyRow(
            polls,
            polls.id,
            or(
              eq(polls.createdBy, oxyUserId),
              exists(
                getDb()
                  .select({ one: sql`1` })
                  .from(pollVotes)
                  .where(and(eq(pollVotes.pollId, polls.id), eq(pollVotes.userId, oxyUserId))),
              ),
            ),
          ),
      },
      {
        name: 'articles.created_by',
        hasReference: () => anyRow(articles, articles.id, eq(articles.createdBy, oxyUserId)),
      },
      {
        name: 'postgates.created_by',
        hasReference: () => anyRow(postgates, postgates.id, eq(postgates.createdBy, oxyUserId)),
      },
      {
        name: 'threadgates.created_by',
        hasReference: () =>
          anyRow(threadgates, threadgates.id, eq(threadgates.createdBy, oxyUserId)),
      },
      {
        name: 'post_recent_repliers.oxy_user_id',
        hasReference: () =>
          anyRow(
            postRecentRepliers,
            postRecentRepliers.id,
            eq(postRecentRepliers.oxyUserId, oxyUserId),
          ),
      },
      {
        // Mongo's third arm, `payload.postAuthorship.oxyUserId`, has NO column:
        // that snapshot was dropped as reconstructible from `post_authorships`,
        // which the `posts non-owner authorship` probe below already covers.
        name: 'engagement_outbox.payload actor/owner',
        hasReference: () =>
          anyRow(
            engagementOutbox,
            engagementOutbox.id,
            or(
              eq(engagementOutbox.payloadActorOxyUserId, oxyUserId),
              eq(engagementOutbox.payloadPostOwnerOxyUserId, oxyUserId),
            ),
          ),
      },
      {
        // The member arrays became junction tables, so "owner or member" is a
        // union of two probes rather than one `$or` on a document.
        name: 'account_lists owner/member',
        hasReference: async () =>
          (await anyRow(
            accountLists,
            accountLists.id,
            eq(accountLists.ownerOxyUserId, oxyUserId),
          )) ||
          anyRow(
            accountListMembers,
            accountListMembers.id,
            eq(accountListMembers.oxyUserId, oxyUserId),
          ),
      },
      {
        name: 'custom_feeds owner/member',
        hasReference: async () =>
          (await anyRow(customFeeds, customFeeds.id, eq(customFeeds.ownerOxyUserId, oxyUserId))) ||
          anyRow(
            customFeedMembers,
            customFeedMembers.id,
            eq(customFeedMembers.oxyUserId, oxyUserId),
          ),
      },
      {
        name: 'starter_packs owner/member/used_by',
        hasReference: async () =>
          (await anyRow(
            starterPacks,
            starterPacks.id,
            eq(starterPacks.ownerOxyUserId, oxyUserId),
          )) ||
          (await anyRow(
            starterPackMembers,
            starterPackMembers.id,
            eq(starterPackMembers.oxyUserId, oxyUserId),
          )) ||
          anyRow(starterPackUses, starterPackUses.id, eq(starterPackUses.oxyUserId, oxyUserId)),
      },
      {
        name: 'feed_generators.created_by',
        hasReference: () =>
          anyRow(feedGenerators, feedGenerators.id, eq(feedGenerators.createdBy, oxyUserId)),
      },
      {
        name: 'labelers.creator_id',
        hasReference: () => anyRow(labelers, labelers.id, eq(labelers.creatorId, oxyUserId)),
      },
      {
        name: 'content_labels created_by/target_id(user)',
        hasReference: () =>
          anyRow(
            contentLabels,
            contentLabels.id,
            or(
              eq(contentLabels.createdBy, oxyUserId),
              and(
                eq(contentLabels.targetType, 'user'),
                eq(contentLabels.targetId, oxyUserId),
              ),
            ),
          ),
      },
      {
        name: 'federation_delivery_queue.sender_oxy_user_id',
        hasReference: () => hasDeliveriesFromSender(oxyUserId),
      },
      {
        name: 'endorsement_outbox pending owner/member',
        hasReference: () =>
          anyRow(
            endorsementOutbox,
            endorsementOutbox.id,
            or(
              eq(endorsementOutbox.pendingRemoveOwnerId, oxyUserId),
              arrayContains(endorsementOutbox.pendingRemoveMemberIds, [oxyUserId]),
            ),
          ),
      },
      {
        // `preferredAuthors` became a child table; the three negative-signal
        // arrays stayed `text[]`, so they are containment tests (`@>`), not
        // equality — an `eq` against an array column matches nothing at all.
        name: 'user_behaviors references from another viewer',
        hasReference: () =>
          anyRow(
            userBehaviors,
            userBehaviors.id,
            and(
              ne(userBehaviors.oxyUserId, oxyUserId),
              or(
                exists(
                  getDb()
                    .select({ one: sql`1` })
                    .from(userBehaviorAuthors)
                    .where(
                      and(
                        eq(userBehaviorAuthors.behaviorId, userBehaviors.id),
                        eq(userBehaviorAuthors.authorId, oxyUserId),
                      ),
                    ),
                ),
                arrayContains(userBehaviors.hiddenAuthors, [oxyUserId]),
                arrayContains(userBehaviors.mutedAuthors, [oxyUserId]),
                arrayContains(userBehaviors.blockedAuthors, [oxyUserId]),
              ),
            ),
          ),
      },
      {
        name: 'posts non-owner authorship/federation.actor_uri',
        hasReference: () =>
          postExists(
            and(
              ne(posts.oxyUserId, oxyUserId),
              or(
                // The authorship AUTHORITY is a child table, so "someone else's
                // post lists this user as a collaborator" is an EXISTS over it —
                // not a dotted path on the post row.
                sql`exists (
                  select 1 from ${postAuthorships}
                  where ${postAuthorships.postId} = ${posts.id}
                    and ${postAuthorships.oxyUserId} = ${oxyUserId}
                )`,
                eq(posts.federationActorUri, actorUri),
              ),
            ),
          ),
      },
      {
        name: 'federated_follows.local_user_id',
        hasReference: () => existsFollow({ localUserId: oxyUserId }),
      },
    );
  } else {
    probes.push({
      name: 'posts.federation_actor_uri without linked Oxy identity',
      hasReference: () => postExists(eq(posts.federationActorUri, actorUri)),
    });
  }

  if (includeReferencesRemovedByGoneActorCascade) {
    return probes;
  }

  probes.push({
    name: 'federated_follows.remote_actor_uri',
    hasReference: () => existsFollow({ remoteActorUri: actorUri }),
  });

  if (oxyUserId) {
    probes.push(
      {
        name: 'posts owner/authorship/mentions',
        hasReference: () =>
          postExists(
            or(
              eq(posts.oxyUserId, oxyUserId),
              sql`exists (
                select 1 from ${postAuthorships}
                where ${postAuthorships.postId} = ${posts.id}
                  and ${postAuthorships.oxyUserId} = ${oxyUserId}
              )`,
              sql`exists (
                select 1 from ${postMentions}
                where ${postMentions.postId} = ${posts.id}
                  and ${postMentions.oxyUserId} = ${oxyUserId}
              )`,
            ),
          ),
      },
      {
        name: 'likes.user_id',
        hasReference: () => anyRow(likes, likes.id, eq(likes.userId, oxyUserId)),
      },
      {
        name: 'entity_follows.user_id',
        hasReference: () =>
          anyRow(entityFollows, entityFollows.id, eq(entityFollows.userId, oxyUserId)),
      },
      {
        name: 'notifications recipient/actor',
        hasReference: () =>
          anyRow(
            notifications,
            notifications.id,
            or(
              eq(notifications.recipientId, oxyUserId),
              eq(notifications.actorId, oxyUserId),
            ),
          ),
      },
      {
        name: 'user_settings.oxy_user_id',
        hasReference: () => anyRow(userSettings, userSettings.id, eq(userSettings.oxyUserId, oxyUserId)),
      },
      {
        name: 'user_behaviors.oxy_user_id',
        hasReference: () =>
          anyRow(userBehaviors, userBehaviors.id, eq(userBehaviors.oxyUserId, oxyUserId)),
      },
      {
        name: 'user_feed_preferences.oxy_user_id',
        hasReference: () =>
          anyRow(
            userFeedPreferences,
            userFeedPreferences.id,
            eq(userFeedPreferences.oxyUserId, oxyUserId),
          ),
      },
      {
        name: 'author_follower_snapshots.oxy_user_id',
        hasReference: () =>
          anyRow(
            authorFollowerSnapshots,
            authorFollowerSnapshots.id,
            eq(authorFollowerSnapshots.oxyUserId, oxyUserId),
          ),
      },
      {
        name: 'actor_key_pairs.oxy_user_id',
        hasReference: () => hasActorKeyPair(oxyUserId),
      },
      // The probe NAME follows the storage throughout: a blocker message has to
      // name something an operator can go and look at.
      {
        name: 'mention_user_nodes.oxy_user_id',
        hasReference: () =>
          anyRow(mentionUserNodes, mentionUserNodes.id, eq(mentionUserNodes.oxyUserId, oxyUserId)),
      },
      {
        name: 'mention_repo_heads.oxy_user_id',
        hasReference: () =>
          anyRow(mentionRepoHeads, mentionRepoHeads.id, eq(mentionRepoHeads.oxyUserId, oxyUserId)),
      },
      {
        name: 'mention_signed_records.oxy_user_id',
        hasReference: () =>
          anyRow(
            mentionSignedRecords,
            mentionSignedRecords.id,
            eq(mentionSignedRecords.oxyUserId, oxyUserId),
          ),
      },
      {
        name: 'mention_node_ingest_witnesses.oxy_user_id',
        hasReference: () =>
          anyRow(
            mentionNodeIngestWitnesses,
            mentionNodeIngestWitnesses.id,
            eq(mentionNodeIngestWitnesses.oxyUserId, oxyUserId),
          ),
      },
    );
  }

  return probes;
}

/**
 * Prove that deleting a FederatedActor anchor cannot strand a known Mention
 * reference. The gone-actor purge may acknowledge only the references its
 * awaited cascade actually removes; own-domain anchor cleanup acknowledges none.
 */
export async function assertActorSafeToDelete(
  context: string,
  target: ActorDeletionTarget,
  options: { allowGoneActorCascade?: boolean } = {},
): Promise<void> {
  const blockers = await collectReferenceBlockers(
    actorReferenceProbes(target, options.allowGoneActorCascade === true),
  );
  assertNoDeletionBlockers(context, blockers);
}
