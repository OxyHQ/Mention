import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
import FederatedActor from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import { Post } from '../../models/Post';
import Like from '../../models/Like';
import {
  FEDERATION_MAX_CONTENT_LENGTH,
  resolveOxyUser,
} from '../../utils/federation/constants';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { getPostCreator } from '../serviceRegistry';
import { actorService } from './ActorService';
import { outboxSyncService } from './OutboxSyncService';
import { followService } from './FollowService';
import {
  extractAnnouncedObjectUri,
  extractApHashtags,
  extractApMedia,
  isDuplicateKeyError,
  mapApVisibility,
  materializeFederatedMedia,
  resolvePostIdFromObjectUri,
} from './sharedFederationHelpers';

/**
 * Processing of inbound ActivityPub activities (Follow / Undo / Create / Delete
 * / Like / Announce / Accept / Reject / Update) delivered to a local user's
 * inbox.
 *
 * Extracted verbatim from the monolithic FederationService — same behavior,
 * same dispatch. Depends on ActorService (actor resolution + actor→Oxy id),
 * OutboxSyncService (boost import + post backfill on follow-accept), FollowService
 * (Accept delivery), the shared low-level helpers, and the registered PostCreator.
 * None of those import this module, so the direct imports are cycle-free.
 */
export class InboxProcessingService {
  /**
   * Process an incoming activity from a remote server.
   */
  async processInboxActivity(
    activity: Record<string, any>,
    verifiedActorUri: string,
  ): Promise<void> {
    const type = activity.type;

    switch (type) {
      case 'Follow':
        await this.handleIncomingFollow(activity, verifiedActorUri);
        break;
      case 'Undo':
        await this.handleUndo(activity, verifiedActorUri);
        break;
      case 'Create':
        await this.handleCreate(activity, verifiedActorUri);
        break;
      case 'Delete':
        await this.handleDelete(activity, verifiedActorUri);
        break;
      case 'Like':
        await this.handleLike(activity, verifiedActorUri);
        break;
      case 'Announce':
        await this.handleAnnounce(activity, verifiedActorUri);
        break;
      case 'Accept':
        await this.handleAccept(activity, verifiedActorUri);
        break;
      case 'Reject':
        await this.handleReject(activity, verifiedActorUri);
        break;
      case 'Update':
        await this.handleUpdate(activity, verifiedActorUri);
        break;
      default:
        logger.debug(`Unhandled activity type: ${type}`);
    }
  }

  private async handleIncomingFollow(activity: Record<string, any>, actorUri: string): Promise<void> {
    const targetActorUri = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!targetActorUri || typeof targetActorUri !== 'string') return;

    // Extract username from our actor URL
    const match = targetActorUri.match(/\/ap\/users\/([^/]+)$/);
    if (!match) return;
    const username = match[1];

    // Resolve the Oxy user to get a real user ID
    const user = await resolveOxyUser(username);
    if (!user) {
      logger.warn(`Incoming follow for unknown user ${username} from ${actorUri}`);
      return;
    }
    const localUserId = String(user._id || user.id);

    const actor = await actorService.getOrFetchActor(actorUri);
    if (!actor) return;

    await FederatedFollow.findOneAndUpdate(
      { localUserId, remoteActorUri: actorUri, direction: 'inbound' },
      {
        $set: {
          status: 'accepted',
          activityId: activity.id,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    // Send Accept back so the remote server knows the follow succeeded
    await followService.sendAccept(localUserId, username, activity.id, actorUri);

    logger.info(`Accepted follow from ${actorUri} to ${username}`);
  }

  private async handleUndo(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    const objectType = typeof object === 'string' ? null : object.type;
    if (objectType === 'Follow') {
      const targetActorUri = typeof object.object === 'string' ? object.object : object.object?.id;
      const match = targetActorUri?.match(/\/ap\/users\/([^/]+)$/);
      const filter: Record<string, unknown> = {
        remoteActorUri: actorUri,
        direction: 'inbound',
      };
      if (match) {
        const user = await resolveOxyUser(match[1]);
        if (user) filter.localUserId = String(user._id || user.id);
      }
      await FederatedFollow.deleteOne(filter);
      logger.debug(`Undo follow from ${actorUri}`);
    } else if (objectType === 'Like') {
      await this.handleUndoLike(object, actorUri);
    } else if (objectType === 'Announce') {
      await this.handleUndoAnnounce(object, actorUri);
    }
  }

  /**
   * Undo(Like): delete the native `Like` doc for the (federated user, post) pair
   * and move `stats.likesCount` -1 ONLY when a doc was actually removed (floored
   * at 0). Mirrors the native unlike path so the counter stays in lockstep with
   * real records.
   */
  private async handleUndoLike(likeObject: Record<string, any>, actorUri: string): Promise<void> {
    const likedObjectId = typeof likeObject.object === 'string' ? likeObject.object : likeObject.object?.id;
    if (!likedObjectId || typeof likedObjectId !== 'string') return;

    const postId = await resolvePostIdFromObjectUri(likedObjectId);
    if (!postId) return;

    const likerOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!likerOxyUserId) return;

    const deleted = await Like.findOneAndDelete({ userId: likerOxyUserId, postId, value: 1 }).lean();
    if (!deleted) return;

    await Post.updateOne(
      { _id: postId, 'stats.likesCount': { $gt: 0 } },
      { $inc: { 'stats.likesCount': -1 } },
    );
    logger.debug(`[Federation] undo Like from ${actorUri} on ${postId}`);
  }

  /**
   * Undo(Announce): delete the native boost `Post` (matched by the Announce
   * `federation.activityId`, with the boosted-post fallback) and move
   * `stats.boostsCount` -1 ONLY when a boost Post was actually removed (floored
   * at 0).
   */
  private async handleUndoAnnounce(announceObject: Record<string, any>, actorUri: string): Promise<void> {
    const announceId = typeof announceObject.id === 'string' ? announceObject.id : undefined;
    const announcedUri = extractAnnouncedObjectUri(announceObject.object);

    // Prefer the precise Announce-id match. Fall back to (boostOf, author) when
    // the Undo omits the original Announce id but carries the announced object.
    let boost: { _id: mongoose.Types.ObjectId; boostOf?: string } | null = null;
    if (announceId) {
      boost = await Post.findOne(
        { 'federation.activityId': announceId, type: 'boost' },
        { _id: 1, boostOf: 1 },
      ).lean<{ _id: mongoose.Types.ObjectId; boostOf?: string } | null>();
    }
    if (!boost && announcedUri) {
      const originalPostId = await resolvePostIdFromObjectUri(announcedUri);
      const boosterOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
      if (originalPostId && boosterOxyUserId) {
        boost = await Post.findOne(
          { boostOf: originalPostId, oxyUserId: boosterOxyUserId, type: 'boost' },
          { _id: 1, boostOf: 1 },
        ).lean<{ _id: mongoose.Types.ObjectId; boostOf?: string } | null>();
      }
    }

    if (!boost?.boostOf) return;

    await Post.deleteOne({ _id: boost._id });
    await Post.updateOne(
      { _id: boost.boostOf, 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
    logger.debug(`[Federation] undo Announce from ${actorUri} (boost ${String(boost._id)})`);
  }

  private async handleCreate(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object || typeof object !== 'object') return;
    if (object.type !== 'Note' && object.type !== 'Article') return;

    // Only process if the actor is followed by at least one local user
    const hasFollower = await FederatedFollow.exists({
      remoteActorUri: actorUri,
      direction: 'outbound',
      status: 'accepted',
    });
    if (!hasFollower) return;

    // Sanitize and check content length
    const rawContent = object.content || '';
    if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) {
      logger.debug(`Rejecting oversized content from ${actorUri}`);
      return;
    }

    // Convert HTML to plain text
    const text = htmlToPlainText(rawContent);

    // Dedup by activityId
    const existingPost = await Post.exists({ 'federation.activityId': object.id });
    if (existingPost) return;

    const actor = await actorService.getOrFetchActor(actorUri);
    if (!actor) return;

    const hashtags = extractApHashtags(object);
    const extracted = extractApMedia(object);
    const { media, attachments } = await materializeFederatedMedia(
      extracted.media,
      extracted.attachments,
      actor.oxyUserId,
      { activityId: object.id, actorUri },
    );

    await getPostCreator().create({
      oxyUserId: actor.oxyUserId ?? null,
      federation: {
        activityId: object.id,
        inReplyTo: object.inReplyTo || undefined,
        url: object.url || object.id,
        sensitive: object.sensitive || false,
        spoilerText: object.summary || undefined,
      },
      content: {
        text,
        media: media.length > 0 ? media : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      visibility: mapApVisibility(object.to, object.cc),
      hashtags,
      status: 'published',
      metadata: { isSensitive: object.sensitive === true },
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    logger.debug(`Stored federated post from ${actorUri}: ${object.id}`);
  }

  private async handleDelete(activity: Record<string, any>, actorUri: string): Promise<void> {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return;

    const post = await Post.findOne({ 'federation.activityId': objectId, federation: { $ne: null } }).lean();
    if (!post) return;
    // Verify the deleting actor owns this post via Oxy user ID
    const actorRecord = await FederatedActor.findOne({ uri: actorUri }).lean();
    if (actorRecord && post.oxyUserId && actorRecord.oxyUserId !== post.oxyUserId) {
      logger.warn(`Delete rejected: actor ${actorUri} does not own post ${objectId}`);
      return;
    }
    await Post.deleteOne({ _id: post._id });
    logger.debug(`Deleted federated post: ${objectId}`);
  }

  /**
   * Inbound Like. Records the like with the SAME native structure as a local
   * like (a `Like` doc) and keeps `stats.likesCount` in lockstep: the counter
   * moves +1 only when a NEW Like doc is actually inserted. Redelivered Like
   * activities are no-ops (the unique `{userId, postId}` index makes the insert
   * idempotent). Skips entirely when the post or the federated user can't be
   * resolved, so the count only ever reflects real, listable likers.
   */
  private async handleLike(activity: Record<string, any>, actorUri: string): Promise<void> {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId || typeof objectId !== 'string') return;

    const postId = await resolvePostIdFromObjectUri(objectId);
    if (!postId) return;

    const likerOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!likerOxyUserId) {
      logger.info(`[Federation] skipping Like from ${actorUri} on ${objectId}: unresolved actor`);
      return;
    }

    // Idempotent insert: a duplicate key means this actor already liked the post
    // (redelivered activity) — do not move the counter again.
    try {
      await Like.create({ userId: likerOxyUserId, postId, value: 1 });
    } catch (err) {
      if (isDuplicateKeyError(err)) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Federation] failed to record Like from ${actorUri} on ${postId}: ${message}`);
      return;
    }

    await Post.updateOne({ _id: postId }, { $inc: { 'stats.likesCount': 1 } });
    logger.debug(`[Federation] recorded Like from ${actorUri} on ${postId}`);
  }

  /**
   * Inbound Announce (boost). Records EVERY booster relationally as a native
   * boost Post (`type:'boost'`, `boostOf:<local post _id>`, author = booster
   * Oxy user), deduped by the Announce `federation.activityId`. `stats.boostsCount`
   * moves +1 only when a NEW boost Post is created (no unconditional increment),
   * so the counter always equals the number of real boost records. Skips when the
   * booster or the boosted post can't be resolved.
   *
   * Feed visibility stays follow-gated naturally: feeds query `followingIds`, so
   * creating a boost Post for a non-followed booster populates the boost list and
   * count without flooding anyone's feed.
   */
  private async handleAnnounce(activity: Record<string, any>, actorUri: string): Promise<void> {
    const announcedUri = extractAnnouncedObjectUri(activity.object);
    if (!announcedUri) return;

    // Record every booster as a real, listable user — resolve first and skip
    // when unresolvable so we never move the counter without a backing record.
    const boosterOxyUserId = await actorService.resolveActorOxyUserId(actorUri);
    if (!boosterOxyUserId) {
      logger.info(`[Federation] skipping Announce from ${actorUri} of ${announcedUri}: unresolved actor`);
      return;
    }

    // importAnnounce creates the native boost Post (deduped by Announce id) and
    // increments stats.boostsCount in lockstep only when a new boost is created.
    const created = await outboxSyncService.importAnnounce(activity, announcedUri, boosterOxyUserId);
    if (created) {
      logger.debug(`Imported boost from ${actorUri} of ${announcedUri}`);
    }
  }

  private async handleAccept(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    let updated = false;

    if (typeof object === 'string') {
      // Remote sent Accept with a string reference (the Follow activity ID)
      const filter: Record<string, unknown> = {
        remoteActorUri: actorUri,
        direction: 'outbound',
        status: 'pending',
      };
      // Try matching by activityId first, fall back to any pending follow
      let result = await FederatedFollow.updateOne({ ...filter, activityId: object }, { $set: { status: 'accepted' } });
      if ((result?.modifiedCount ?? 0) === 0) {
        result = await FederatedFollow.updateOne(filter, { $set: { status: 'accepted' } });
      }
      updated = (result?.modifiedCount ?? 0) > 0;
    } else if (object.type === 'Follow') {
      const followActivityId = object.id;
      const filter: Record<string, unknown> = {
        remoteActorUri: actorUri,
        direction: 'outbound',
        status: 'pending',
      };
      if (followActivityId) filter.activityId = followActivityId;
      const result = await FederatedFollow.updateOne(filter, { $set: { status: 'accepted' } });
      updated = (result?.modifiedCount ?? 0) > 0;
    }

    if (updated) {
      logger.debug(`Follow accepted by ${actorUri}`);
      // Fire-and-forget: backfill the newly followed actor's recent posts
      const actor = await FederatedActor.findOne({ uri: actorUri }).lean();
      if (actor) {
        outboxSyncService.syncOutboxPosts(actor, 20).catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to sync outbox after accept from ${actorUri}: ${message}`);
        });
      }
    }
  }

  private async handleReject(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    const objectType = typeof object === 'string' ? null : object.type;
    if (objectType === 'Follow') {
      const followActivityId = typeof object === 'object' ? object.id : undefined;
      const filter: Record<string, unknown> = {
        remoteActorUri: actorUri,
        direction: 'outbound',
        status: 'pending',
      };
      if (followActivityId) filter.activityId = followActivityId;
      await FederatedFollow.updateOne(filter, { $set: { status: 'rejected' } });
      logger.debug(`Follow rejected by ${actorUri}`);
    }
  }

  private async handleUpdate(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object || typeof object !== 'object') return;

    if (object.type === 'Note' || object.type === 'Article') {
      const objectId = object.id;
      if (!objectId) return;

      const text = htmlToPlainText(object.content || '');
      const existingPost = await Post.findOne(
        { 'federation.activityId': objectId },
        { oxyUserId: 1 },
      ).lean<{ oxyUserId?: string | null } | null>();
      const ownerOxyUserId = existingPost?.oxyUserId ?? (await actorService.getOrFetchActor(actorUri))?.oxyUserId ?? null;
      const extracted = extractApMedia(object);
      const { media, attachments } = await materializeFederatedMedia(
        extracted.media,
        extracted.attachments,
        ownerOxyUserId,
        { activityId: objectId, actorUri },
      );

      await Post.updateOne(
        { 'federation.activityId': objectId },
        {
          $set: {
            'content.text': text,
            'content.media': media.length > 0 ? media : undefined,
            'content.attachments': attachments.length > 0 ? attachments : undefined,
            'metadata.isEdited': true,
            updatedAt: new Date(),
          },
        },
      );
      logger.debug(`Updated federated post: ${objectId}`);
    } else if (object.type === 'Person' || object.type === 'Service' || object.type === 'Application') {
      // Profile update — re-fetch the actor to get updated data
      await actorService.fetchRemoteActor(actorUri);
      logger.debug(`Updated federated actor: ${actorUri}`);
    }
  }
}

export const inboxProcessingService = new InboxProcessingService();
export default inboxProcessingService;
