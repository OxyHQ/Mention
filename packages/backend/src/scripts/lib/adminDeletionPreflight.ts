import type { Types } from 'mongoose';
import { Post } from '../../models/Post';
import Like from '../../models/Like';
import Bookmark from '../../models/Bookmark';
import Notification from '../../models/Notification';
import Poll from '../../models/Poll';
import Article from '../../models/Article';
import { Postgate } from '../../models/Postgate';
import { Threadgate } from '../../models/Threadgate';
import PostRecentReplier from '../../models/PostRecentReplier';
import EngagementOutbox from '../../models/EngagementOutbox';
import Report, { ReportedType } from '../../models/Report.model';
import ContentLabel from '../../models/ContentLabel';
import { FeedInteraction } from '../../models/FeedInteraction';
import FederationDeliveryQueue from '../../models/FederationDeliveryQueue';
import Mute from '../../models/Mute';
import { MuteWord } from '../../models/MuteWord';
import FeedLike from '../../models/FeedLike';
import FeedReview from '../../models/FeedReview';
import PostSubscription from '../../models/PostSubscription';
import PushToken from '../../models/PushToken';
import Poke from '../../models/Poke';
import AccountList from '../../models/AccountList';
import CustomFeed from '../../models/CustomFeed';
import StarterPack from '../../models/StarterPack';
import { FeedGenerator } from '../../models/FeedGenerator';
import Labeler from '../../models/Labeler';
import EndorsementOutbox from '../../models/EndorsementOutbox';
import UserBehavior from '../../models/UserBehavior';
import FederatedFollow from '../../models/FederatedFollow';
import { EntityFollow } from '../../models/EntityFollow';
import UserSettings from '../../models/UserSettings';
import UserFeedPreference from '../../models/UserFeedPreference';
import { AuthorFollowerSnapshot } from '../../models/AuthorFollowerSnapshot';
import ActorKeyPair from '../../models/ActorKeyPair';
import MentionUserNode from '../../models/MentionUserNode';
import MentionRepoHead from '../../models/MentionRepoHead';
import MentionSignedRecord from '../../models/MentionSignedRecord';
import MentionNodeIngestWitness from '../../models/MentionNodeIngestWitness';

export interface ReferenceProbe {
  name: string;
  hasReference: () => Promise<boolean>;
}

export interface PostDeletionTarget {
  id: Types.ObjectId | string;
  uris?: readonly string[];
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

async function exists(query: PromiseLike<unknown>): Promise<boolean> {
  return Boolean(await query);
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

  const ids = targets.map((target) => target.id);
  const idStrings = unique(ids.map(String));
  const postKeys = unique([
    ...idStrings,
    ...targets.flatMap((target) => target.uris ?? []),
  ]);

  const probes: ReferenceProbe[] = [
    {
      name: 'Post.boostOf/quoteOf/parentPostId/threadId',
      hasReference: () =>
        exists(
          Post.exists({
            _id: { $nin: ids },
            $or: [
              { boostOf: { $in: idStrings } },
              { quoteOf: { $in: idStrings } },
              { parentPostId: { $in: idStrings } },
              { threadId: { $in: idStrings } },
            ],
          }),
        ),
    },
    {
      name: 'Notification.entityId',
      hasReference: () =>
        exists(
          Notification.exists({
            entityType: { $in: ['post', 'reply'] },
            entityId: { $in: ids },
          }),
        ),
    },
    {
      name: 'Poll.postId',
      hasReference: () =>
        exists(Poll.exists({ postId: { $in: [...ids, ...idStrings] } })),
    },
    {
      name: 'Article.postId',
      hasReference: () => exists(Article.exists({ postId: { $in: idStrings } })),
    },
    {
      name: 'Postgate.postId/postUri',
      hasReference: () =>
        exists(
          Postgate.exists({
            $or: [
              { postId: { $in: idStrings } },
              { postUri: { $in: postKeys } },
            ],
          }),
        ),
    },
    {
      name: 'Threadgate.postId/postUri',
      hasReference: () =>
        exists(
          Threadgate.exists({
            $or: [
              { postId: { $in: idStrings } },
              { postUri: { $in: postKeys } },
            ],
          }),
        ),
    },
    {
      name: 'PostRecentReplier.postId',
      hasReference: () =>
        exists(PostRecentReplier.exists({ postId: { $in: idStrings } })),
    },
    {
      name: 'EngagementOutbox.payload.postId',
      hasReference: () =>
        exists(EngagementOutbox.exists({ 'payload.postId': { $in: idStrings } })),
    },
    {
      name: 'Report.reportedId(post)',
      hasReference: () =>
        exists(
          Report.exists({
            reportedType: ReportedType.POST,
            reportedId: { $in: idStrings },
          }),
        ),
    },
    {
      name: 'ContentLabel.targetId(post)',
      hasReference: () =>
        exists(
          ContentLabel.exists({
            targetType: 'post',
            targetId: { $in: idStrings },
          }),
        ),
    },
    {
      name: 'FeedInteraction.postUri',
      hasReference: () =>
        exists(FeedInteraction.exists({ postUri: { $in: postKeys } })),
    },
    {
      name: 'FederationDeliveryQueue.activityJson',
      hasReference: () =>
        exists(
          FederationDeliveryQueue.exists({
            $or: [
              { 'activityJson.id': { $in: postKeys } },
              { 'activityJson.object.id': { $in: postKeys } },
              { 'activityJson.object': { $in: postKeys } },
            ],
          }),
        ),
    },
  ];

  if (!options.cascadeEngagement) {
    probes.push(
      {
        name: 'Like.postId',
        hasReference: () => exists(Like.exists({ postId: { $in: ids } })),
      },
      {
        name: 'Bookmark.postId',
        hasReference: () => exists(Bookmark.exists({ postId: { $in: ids } })),
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
        name: 'Bookmark.userId',
        hasReference: () => exists(Bookmark.exists({ userId: oxyUserId })),
      },
      {
        name: 'Mute.userId/mutedId',
        hasReference: () =>
          exists(Mute.exists({ $or: [{ userId: oxyUserId }, { mutedId: oxyUserId }] })),
      },
      {
        name: 'MuteWord.userId',
        hasReference: () => exists(MuteWord.exists({ userId: oxyUserId })),
      },
      {
        name: 'FeedInteraction.userId',
        hasReference: () => exists(FeedInteraction.exists({ userId: oxyUserId })),
      },
      {
        name: 'FeedLike.userId',
        hasReference: () => exists(FeedLike.exists({ userId: oxyUserId })),
      },
      {
        name: 'FeedReview.reviewerId',
        hasReference: () => exists(FeedReview.exists({ reviewerId: oxyUserId })),
      },
      {
        name: 'PostSubscription.subscriberId/authorId',
        hasReference: () =>
          exists(
            PostSubscription.exists({
              $or: [{ subscriberId: oxyUserId }, { authorId: oxyUserId }],
            }),
          ),
      },
      {
        name: 'PushToken.userId',
        hasReference: () => exists(PushToken.exists({ userId: oxyUserId })),
      },
      {
        name: 'Poke.pokerId/pokedId',
        hasReference: () =>
          exists(Poke.exists({ $or: [{ pokerId: oxyUserId }, { pokedId: oxyUserId }] })),
      },
      {
        name: 'Report.reporter/reportedId(user)',
        hasReference: () =>
          exists(
            Report.exists({
              $or: [
                { reporter: oxyUserId },
                { reportedType: ReportedType.USER, reportedId: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'Poll.createdBy/options.votes',
        hasReference: () =>
          exists(
            Poll.exists({
              $or: [{ createdBy: oxyUserId }, { 'options.votes': oxyUserId }],
            }),
          ),
      },
      {
        name: 'Article.createdBy',
        hasReference: () => exists(Article.exists({ createdBy: oxyUserId })),
      },
      {
        name: 'Postgate.createdBy',
        hasReference: () => exists(Postgate.exists({ createdBy: oxyUserId })),
      },
      {
        name: 'Threadgate.createdBy',
        hasReference: () => exists(Threadgate.exists({ createdBy: oxyUserId })),
      },
      {
        name: 'PostRecentReplier.repliers.oxyUserId',
        hasReference: () =>
          exists(PostRecentReplier.exists({ 'repliers.oxyUserId': oxyUserId })),
      },
      {
        name: 'EngagementOutbox.payload actor/owner/authorship',
        hasReference: () =>
          exists(
            EngagementOutbox.exists({
              $or: [
                { 'payload.actorOxyUserId': oxyUserId },
                { 'payload.postOwnerOxyUserId': oxyUserId },
                { 'payload.postAuthorship.oxyUserId': oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'AccountList owner/member',
        hasReference: () =>
          exists(
            AccountList.exists({
              $or: [
                { ownerOxyUserId: oxyUserId },
                { memberOxyUserIds: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'CustomFeed owner/member',
        hasReference: () =>
          exists(
            CustomFeed.exists({
              $or: [
                { ownerOxyUserId: oxyUserId },
                { memberOxyUserIds: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'StarterPack owner/member/usedBy',
        hasReference: () =>
          exists(
            StarterPack.exists({
              $or: [
                { ownerOxyUserId: oxyUserId },
                { memberOxyUserIds: oxyUserId },
                { usedByOxyUserIds: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'FeedGenerator.createdBy',
        hasReference: () => exists(FeedGenerator.exists({ createdBy: oxyUserId })),
      },
      {
        name: 'Labeler.creatorId',
        hasReference: () => exists(Labeler.exists({ creatorId: oxyUserId })),
      },
      {
        name: 'ContentLabel user/createdBy',
        hasReference: () =>
          exists(
            ContentLabel.exists({
              $or: [
                { createdBy: oxyUserId },
                { targetType: 'user', targetId: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'FederationDeliveryQueue.senderOxyUserId',
        hasReference: () =>
          exists(FederationDeliveryQueue.exists({ senderOxyUserId: oxyUserId })),
      },
      {
        name: 'EndorsementOutbox pending owner/member',
        hasReference: () =>
          exists(
            EndorsementOutbox.exists({
              $or: [
                { pendingRemoveOwnerId: oxyUserId },
                { pendingRemoveMemberIds: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'UserBehavior references from another viewer',
        hasReference: () =>
          exists(
            UserBehavior.exists({
              oxyUserId: { $ne: oxyUserId },
              $or: [
                { 'preferredAuthors.authorId': oxyUserId },
                { hiddenAuthors: oxyUserId },
                { mutedAuthors: oxyUserId },
                { blockedAuthors: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'Post non-owner authorship/federation.actorUri',
        hasReference: () =>
          exists(
            Post.exists({
              oxyUserId: { $ne: oxyUserId },
              $or: [
                { 'authorship.oxyUserId': oxyUserId },
                { 'federation.actorUri': actorUri },
              ],
            }),
          ),
      },
      {
        name: 'FederatedFollow.localUserId',
        hasReference: () => exists(FederatedFollow.exists({ localUserId: oxyUserId })),
      },
    );
  } else {
    probes.push({
      name: 'Post.federation.actorUri without linked Oxy identity',
      hasReference: () => exists(Post.exists({ 'federation.actorUri': actorUri })),
    });
  }

  if (includeReferencesRemovedByGoneActorCascade) {
    return probes;
  }

  probes.push({
    name: 'FederatedFollow.remoteActorUri',
    hasReference: () => exists(FederatedFollow.exists({ remoteActorUri: actorUri })),
  });

  if (oxyUserId) {
    probes.push(
      {
        name: 'Post owner/authorship/mentions',
        hasReference: () =>
          exists(
            Post.exists({
              $or: [
                { oxyUserId },
                { 'authorship.oxyUserId': oxyUserId },
                { mentions: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'Like.userId',
        hasReference: () => exists(Like.exists({ userId: oxyUserId })),
      },
      {
        name: 'EntityFollow.userId',
        hasReference: () => exists(EntityFollow.exists({ userId: oxyUserId })),
      },
      {
        name: 'Notification recipient/actor',
        hasReference: () =>
          exists(
            Notification.exists({
              $or: [{ recipientId: oxyUserId }, { actorId: oxyUserId }],
            }),
          ),
      },
      {
        name: 'UserSettings.oxyUserId',
        hasReference: () => exists(UserSettings.exists({ oxyUserId })),
      },
      {
        name: 'UserBehavior.oxyUserId',
        hasReference: () => exists(UserBehavior.exists({ oxyUserId })),
      },
      {
        name: 'UserFeedPreference.oxyUserId',
        hasReference: () => exists(UserFeedPreference.exists({ oxyUserId })),
      },
      {
        name: 'AuthorFollowerSnapshot.oxyUserId',
        hasReference: () => exists(AuthorFollowerSnapshot.exists({ oxyUserId })),
      },
      {
        name: 'ActorKeyPair.oxyUserId',
        hasReference: () => exists(ActorKeyPair.exists({ oxyUserId })),
      },
      {
        name: 'MentionUserNode.oxyUserId',
        hasReference: () => exists(MentionUserNode.exists({ oxyUserId })),
      },
      {
        name: 'MentionRepoHead.oxyUserId',
        hasReference: () => exists(MentionRepoHead.exists({ oxyUserId })),
      },
      {
        name: 'MentionSignedRecord.oxyUserId',
        hasReference: () => exists(MentionSignedRecord.exists({ oxyUserId })),
      },
      {
        name: 'MentionNodeIngestWitness.oxyUserId',
        hasReference: () => exists(MentionNodeIngestWitness.exists({ oxyUserId })),
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
