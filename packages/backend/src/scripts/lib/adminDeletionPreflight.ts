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
import { Lane } from '../../models/Lane';
import { LaneMute } from '../../models/LaneMute';
import ModerationEnforcement from '../../models/ModerationEnforcement';
import McpConnection from '../../mcp/models/McpConnection';

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
 * Every known reference to a post, by name.
 *
 * A caller may declare that its own awaited cascade removes some of these (see
 * {@link PostDeletionAcknowledgements.removedByCascade}), and the declaration is
 * checked by the COMPILER against this list — so a probe that is renamed, or a
 * NEW probe added here later, cannot be silently acknowledged by an existing
 * caller. A purge that has not been taught about a new reference type fails
 * closed on it, which is the whole point of a preflight.
 *
 * `Post.dependents` is deliberately absent: it is the reply/boost graph, and
 * whether a dangling one is acceptable is a POLICY question with its own
 * narrower option rather than something a cascade can claim to have cleaned.
 */
export const POST_REFERENCE_PROBE_NAMES = [
  'Notification.entityId',
  'Poll.postId',
  'Article.postId',
  'Postgate.postId/postUri',
  'Threadgate.postId/postUri',
  'PostRecentReplier.postId',
  'EngagementOutbox.payload.postId',
  'Report.reportedId(post)',
  'ContentLabel.targetId(post)',
  'FeedInteraction.postUri',
  'FederationDeliveryQueue.activityJson',
  'Like.postId',
  'Bookmark.postId',
] as const;

export type PostReferenceProbeName = (typeof POST_REFERENCE_PROBE_NAMES)[number];

/** What a caller's own cascade covers, so the preflight can stop demanding it. */
export interface PostDeletionAcknowledgements {
  /**
   * Probes whose rows the caller deletes in the SAME awaited cascade, before the
   * posts themselves. Each name must be one the module actually probes, so this
   * reads as a manifest of what the caller cleans and breaks the build when the
   * probe list moves under it.
   */
  removedByCascade?: readonly PostReferenceProbeName[];
  /**
   * Probes whose rows the caller deliberately LEAVES IN PLACE, because a written
   * policy says they must outlive the post — `Report.reportedId(post)`, whose
   * removal strands an inbound CrowdSource decision on a retry loop, and the two
   * durable queues whose live backlog is cancelled while their completed rows
   * stay as a log.
   *
   * Kept SEPARATE from {@link removedByCascade} on purpose, even though the gate
   * treats both the same way. That one is a CLAIM that the rows are gone, and
   * {@link collectPostCascadeResidue} re-runs exactly those probes afterwards to
   * check it; this one is a decision that they stay, which the same check would
   * report as a failure. Collapsing them would make a deliberately retained
   * reference indistinguishable from a cascade leg that had silently stopped
   * working — the one confusion this module exists to remove.
   *
   * Compiler-checked against {@link POST_REFERENCE_PROBE_NAMES} like its sibling,
   * so a probe added upstream cannot be inherited into an existing caller's
   * policy without somebody deciding.
   */
  keptByPolicy?: readonly PostReferenceProbeName[];
  /**
   * The caller deliberately LEAVES `parentPostId` / `quoteOf` / `threadId`
   * pointing at a removed post, because the referencing posts belong to OTHER
   * users and deleting them would destroy their content to remove someone
   * else's. `PostHydrationService` already tolerates all three: a reply whose
   * parent will not load still renders and simply loses its "Replying to @…"
   * handle, a quote resolves `quotedPost` to null and drops the quote card, and
   * a thread context resolves to a root that no longer exists.
   *
   * `boostOf` is NEVER covered by this. A boost has a deliberately empty body
   * and renders entirely from its original, so a dangling one is not degraded
   * content — it is a placeholder card with nothing behind it. A caller that
   * wants this allowance must still delete the boosts.
   */
  allowDanglingReplyReferences?: boolean;
}

/**
 * One executable probe per {@link POST_REFERENCE_PROBE_NAMES} entry, bound to a
 * target set. Built once and read by both the pre-delete gate and the
 * post-delete residue check, so the two can never test different queries.
 */
function buildPostReferenceProbes(
  targets: readonly PostDeletionTarget[],
): Record<PostReferenceProbeName, () => Promise<boolean>> {
  const ids = targets.map((target) => target.id);
  const idStrings = unique(ids.map(String));
  const postKeys = unique([
    ...idStrings,
    ...targets.flatMap((target) => target.uris ?? []),
  ]);

  return {
    'Notification.entityId': () =>
      exists(
        Notification.exists({
          entityType: { $in: ['post', 'reply'] },
          entityId: { $in: ids },
        }),
      ),
    'Poll.postId': () =>
      exists(Poll.exists({ postId: { $in: [...ids, ...idStrings] } })),
    'Article.postId': () => exists(Article.exists({ postId: { $in: idStrings } })),
    'Postgate.postId/postUri': () =>
      exists(
        Postgate.exists({
          $or: [{ postId: { $in: idStrings } }, { postUri: { $in: postKeys } }],
        }),
      ),
    'Threadgate.postId/postUri': () =>
      exists(
        Threadgate.exists({
          $or: [{ postId: { $in: idStrings } }, { postUri: { $in: postKeys } }],
        }),
      ),
    'PostRecentReplier.postId': () =>
      exists(PostRecentReplier.exists({ postId: { $in: idStrings } })),
    'EngagementOutbox.payload.postId': () =>
      exists(EngagementOutbox.exists({ 'payload.postId': { $in: idStrings } })),
    'Report.reportedId(post)': () =>
      exists(
        Report.exists({
          reportedType: ReportedType.POST,
          reportedId: { $in: idStrings },
        }),
      ),
    'ContentLabel.targetId(post)': () =>
      exists(ContentLabel.exists({ targetType: 'post', targetId: { $in: idStrings } })),
    'FeedInteraction.postUri': () =>
      exists(FeedInteraction.exists({ postUri: { $in: postKeys } })),
    'FederationDeliveryQueue.activityJson': () =>
      exists(
        FederationDeliveryQueue.exists({
          $or: [
            { 'activityJson.id': { $in: postKeys } },
            { 'activityJson.object.id': { $in: postKeys } },
            { 'activityJson.object': { $in: postKeys } },
          ],
        }),
      ),
    'Like.postId': () => exists(Like.exists({ postId: { $in: ids } })),
    'Bookmark.postId': () => exists(Bookmark.exists({ postId: { $in: ids } })),
  };
}

/**
 * Prove that deleting the supplied post rows will not leave a known reference
 * behind, except the ones the caller states its own cascade or its policy
 * covers (see {@link PostDeletionAcknowledgements}).
 */
export async function assertPostsSafeToDelete(
  context: string,
  targets: readonly PostDeletionTarget[],
  options: PostDeletionAcknowledgements = {},
): Promise<void> {
  if (targets.length === 0) return;

  const ids = targets.map((target) => target.id);
  const idStrings = unique(ids.map(String));
  const acknowledged = new Set<PostReferenceProbeName>([
    ...(options.removedByCascade ?? []),
    ...(options.keptByPolicy ?? []),
  ]);
  const referenceProbes = buildPostReferenceProbes(targets);

  const danglingReferenceFields = options.allowDanglingReplyReferences
    ? [{ boostOf: { $in: idStrings } }]
    : [
        { boostOf: { $in: idStrings } },
        { quoteOf: { $in: idStrings } },
        { parentPostId: { $in: idStrings } },
        { threadId: { $in: idStrings } },
      ];

  // The post graph is checked ALWAYS, and is the one probe no cascade may
  // acknowledge away — only `allowDanglingReplyReferences` narrows it, and only
  // ever to leave `boostOf` covered.
  const probes: ReferenceProbe[] = [
    {
      name: options.allowDanglingReplyReferences
        ? 'Post.dependents(boostOf)'
        : 'Post.dependents(boostOf/quoteOf/parentPostId/threadId)',
      hasReference: () =>
        exists(
          Post.exists({
            _id: { $nin: ids },
            $or: danglingReferenceFields,
          }),
        ),
    },
  ];

  for (const name of POST_REFERENCE_PROBE_NAMES) {
    if (acknowledged.has(name)) continue;
    probes.push({ name, hasReference: () => referenceProbes[name]() });
  }

  assertNoDeletionBlockers(context, await collectReferenceBlockers(probes));
}

/**
 * Assert that a cascade which CLAIMED to remove a set of post references
 * actually did, by re-running those probes with nothing acknowledged.
 *
 * Run AFTER the posts are gone, so it verifies the end state rather than a
 * promise about it. `assertPostsSafeToDelete` can only ever check the probes a
 * caller did NOT claim; this closes that gap without inverting the gate, and its
 * failure is a signal to reconcile rather than a licence to keep deleting.
 */
export async function collectPostCascadeResidue(
  targets: readonly PostDeletionTarget[],
  claimed: readonly PostReferenceProbeName[],
): Promise<string[]> {
  if (targets.length === 0 || claimed.length === 0) return [];
  const referenceProbes = buildPostReferenceProbes(targets);
  return collectReferenceBlockers(
    claimed.map((name) => ({ name, hasReference: () => referenceProbes[name]() })),
  );
}

/**
 * Every known reference to an ACTOR, as executable probes.
 *
 * Exported so a test can assert which probes exist and which bucket each sits
 * in — the two facts that decide whether a reference is checked at all. A probe
 * that is missing here is invisible to every guard built on top of it, and
 * nothing else in the tree would notice its absence.
 *
 * `includeReferencesRemovedByGoneActorCascade` returns ONLY the probes that
 * cascade does not remove; everything appended afterwards is what it does.
 */
export function actorReferenceProbes(
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
        /**
         * The writer behind a channel post, which is the ONE reference to a
         * person that is deliberately outside `authorship[]` — putting them in
         * it would both end the channel's anonymity and put the post back on
         * their own profile. That same choice puts the column outside every
         * authorship matcher and, until this probe, outside every guard: the
         * gone-actor cascade removes posts by owner and by authorship, so a
         * channel post written by this actor survives it holding their id.
         */
        name: 'Post.writtenByOxyUserId',
        hasReference: () => exists(Post.exists({ writtenByOxyUserId: oxyUserId })),
      },
      {
        name: 'Lane.ownerId',
        hasReference: () => exists(Lane.exists({ ownerId: oxyUserId })),
      },
      {
        name: 'LaneMute.viewer/laneOwner',
        hasReference: () =>
          exists(
            LaneMute.exists({
              $or: [
                { viewerOxyUserId: oxyUserId },
                { laneOwnerOxyUserId: oxyUserId },
              ],
            }),
          ),
      },
      {
        name: 'McpConnection.oxyUserId/activeOxyUserId',
        hasReference: () =>
          exists(
            McpConnection.exists({
              $or: [{ oxyUserId }, { activeOxyUserId: oxyUserId }],
            }),
          ),
      },
      {
        /**
         * `subjectId` holds whichever id the case was about, so it names this
         * actor for an `identity.profile` subject. Kept as a BLOCKER rather
         * than something a cascade may remove: it is the record that an
         * enforcement action was carried out, and its `decisionId + revision +
         * action` uniqueness is what makes a later correction idempotent.
         */
        name: 'ModerationEnforcement.subjectId',
        hasReference: () => exists(ModerationEnforcement.exists({ subjectId: oxyUserId })),
      },
      {
        /**
         * Another viewer's settings naming this actor. Scoped to OTHER rows for
         * the same reason `UserBehavior references from another viewer` is: the
         * actor's own settings row is covered by `UserSettings.oxyUserId`
         * below, which the gone-actor cascade removes, while a stranger's row
         * survives it holding the id.
         */
        name: 'UserSettings privacy references from another viewer',
        hasReference: () =>
          exists(
            UserSettings.exists({
              oxyUserId: { $ne: oxyUserId },
              $or: [
                { 'privacy.restrictedUsers': oxyUserId },
                { 'privacy.labelPreferences.subscribedLabelers': oxyUserId },
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

/**
 * Prove that deleting a `FederatedActor` ANCHOR ROW alone cannot strand a
 * reference, for a caller that deliberately RETAINS the actor's Oxy identity.
 *
 * This is a strictly narrower claim than {@link assertActorSafeToDelete}, and the
 * difference is which side of the actor the reference names. Every probe in the
 * full check is keyed on one of two things:
 *  - the actor's Oxy USER id — `Bookmark.userId`, `Mute.mutedId`, `Report`,
 *    `ContentLabel`, `UserSettings`, and the rest. Those only dangle if the Oxy
 *    `User` is DELETED; while it lives they are ordinary, valid references and
 *    demanding their absence would block a purge that never touches it.
 *  - the actor URI / the anchor row itself. Those dangle the moment the row goes,
 *    whatever happens to the identity — so they are exactly what a
 *    identity-retaining caller must still prove absent.
 *
 * The blocked-domain purge is the caller: it removes a blocked instance's content
 * but makes no claim that the account ceased to exist (unlike the gone-actor
 * purge, which re-verifies a 410 first), so it keeps the identity and only has to
 * clear the uri-keyed references its own cascade removes.
 */
export async function assertActorAnchorSafeToDelete(
  context: string,
  target: { actorUri: string },
): Promise<void> {
  const { actorUri } = target;
  const blockers = await collectReferenceBlockers([
    {
      name: 'Post.federation.actorUri',
      hasReference: () => exists(Post.exists({ 'federation.actorUri': actorUri })),
    },
    {
      name: 'FederatedFollow.remoteActorUri',
      hasReference: () => exists(FederatedFollow.exists({ remoteActorUri: actorUri })),
    },
  ]);
  assertNoDeletionBlockers(context, blockers);
}
