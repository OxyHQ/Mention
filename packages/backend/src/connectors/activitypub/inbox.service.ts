import mongoose from 'mongoose';
import { logger } from '../../utils/logger';
import FederatedActor from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import { Post } from '../../models/Post';
import Like from '../../models/Like';
import {
  FEDERATION_MAX_CONTENT_LENGTH,
  resolveOxyUser,
} from './constants';
import { PostType } from '@mention/shared-types';
import { extractApLanguage, extractApLanguages } from './apLanguage';
import { getPostCreator } from '../../services/serviceRegistry';
import { isFediverseSharingEnabled, isFediverseSharingEnabledFromUser } from '../../services/fediverseSharing';
import { actorService } from './actor.service';
import { requireActorOxyUserId } from '../shared/ActorResolutionPendingError';
import { outboxSyncService } from './outbox.service';
import { followService } from './follow.service';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import {
  extractAnnouncedObjectUri,
  extractInReplyToUri,
  isDuplicateKeyError,
  mapApVisibility,
  parseApPublished,
  resolvePostIdFromObjectUri,
} from './helpers';
import { buildFederatedNoteContent, buildFederatedNoteContentForEdit } from './apPostContent';
import { getRemoteHost } from '../shared/url';
import { parseInboundActivity, parseNote, primaryApType } from './apSchemas';
import type { z } from 'zod';

/**
 * Compact, log-safe summary of a `ZodError` — the first few issues rendered as
 * `path: message`, capped so a hostile payload can't blow up a log line. Used to
 * explain why an inbound activity was dropped without dumping the raw error tree.
 */
function summarizeZodError(error: z.ZodError): string {
  const MAX_ISSUES = 3;
  const parts = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${at}: ${issue.message}`;
  });
  if (error.issues.length > MAX_ISSUES) {
    parts.push(`(+${error.issues.length - MAX_ISSUES} more)`);
  }
  return parts.join('; ');
}

/**
 * Processing of inbound ActivityPub activities (Follow / Undo / Create / Delete
 * / Like / Announce / Accept / Reject / Update) delivered to a local user's
 * inbox.
 *
 * Extracted verbatim from the former monolithic FederationService — same behavior,
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
    // Inbound JSON arrives from arbitrary, UNTRUSTED remote servers. Validate
    // the whole activity against the zod inbound schema BEFORE any handler reads
    // it via raw property access. The parse helper never throws, so a malformed
    // or hostile payload is rejected cleanly here rather than crashing or being
    // partially processed downstream.
    const parsed = parseInboundActivity(activity);
    if (!parsed.ok) {
      // Drop invalid activities (match the existing fast-ack inbox semantics: no
      // throw, no retry-loop). Surface enough context to diagnose the source
      // without trusting/dumping the raw payload.
      const rawType =
        typeof activity?.type === 'string'
          ? activity.type
          : Array.isArray(activity?.type)
            ? activity.type.join(',')
            : 'unknown';
      const rawId = typeof activity?.id === 'string' ? activity.id : 'unknown';
      logger.warn(
        `[Federation] dropping invalid inbound activity from ${verifiedActorUri} (type=${rawType}, id=${rawId}): ${summarizeZodError(parsed.error)}`,
      );
      return;
    }

    // The schema permits `type` to be a single string OR an array (some servers
    // send an array); normalize to the primary string for dispatch. The handlers
    // continue to read the RAW activity so the original-publish-date mapping and
    // all other side effects stay byte-for-byte identical to the prior behavior.
    const type = primaryApType(parsed.data.type);

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

  /**
   * Bridge a federated follow edge into the Oxy follow graph via oxy-api's
   * service route `POST /federation/follow`. Idempotent on both sides: `follow`
   * is a no-op when the edge already exists and `unfollow` when it does not.
   * Throws on transport/HTTP failure so the BullMQ inbox job retries — the whole
   * inbound-follow (and Undo) sequence is retry-safe, so re-running converges.
   */
  private async bridgeFollowEdge(
    followerUserId: string,
    targetUserId: string,
    action: 'follow' | 'unfollow',
  ): Promise<void> {
    await getServiceOxyClient().makeServiceRequest('POST', '/federation/follow', {
      followerUserId,
      targetUserId,
      action,
    });
  }

  /**
   * Whether the LOCAL owner of `postId` currently allows fediverse sharing.
   * Returns `true` (proceed) when the post can't be found, is remote-owned/
   * mirrored (`federation != null`), or has no local `oxyUserId` — gating
   * only ever applies to a real local owner, never a mirrored federated post.
   * Id-based (redis-cached, fails OPEN on an Oxy outage — correct for
   * inbound activities, same as every other consent read on this path).
   *
   * Shared by every shared-inbox handler below that creates NEW engagement
   * against an EXISTING post (a reply's parent, a Like target, an Announce
   * target) so an opted-out user's content stops accruing engagement the
   * moment sharing is off — mirroring {@link handleIncomingFollow}'s gate for
   * the Follow case. Deliberately NOT used by the Undo variants
   * (`handleUndoLike`, `handleUndoAnnounce`) — see their own doc comments:
   * an Undo is teardown, not new engagement, and must always converge.
   */
  private async isLocalPostOwnerSharingEnabled(postId: string): Promise<boolean> {
    const post = await Post.findOne(
      { _id: postId },
      { oxyUserId: 1, federation: 1 },
    ).lean<{ oxyUserId?: string | null; federation?: unknown } | null>();
    if (!post || post.federation != null || !post.oxyUserId) return true;
    return isFediverseSharingEnabled(post.oxyUserId);
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

    // The target user may have turned fediverse sharing off — drop the Follow
    // silently (no bridge, no Accept, no Reject). A Reject is unverifiable
    // against a 404'd actor and would reveal the account exists, so this must
    // look identical to a Follow sent to an unknown user. Gated here, BEFORE
    // the follower actor is fetched/resolved, so an OFF user never triggers any
    // of the bridge/Accept/notification side effects below.
    if (!isFediverseSharingEnabledFromUser(user)) {
      logger.debug(`[Federation] inbound follow for ${username} dropped — sharing off`);
      return;
    }

    // Resolve the follower actor and REQUIRE its Oxy user id: a fediverse
    // follower must become a real Oxy edge, never a Mention-only ghost. When the
    // actor is missing or not yet resolved to an Oxy user (Oxy was unreachable
    // when it was fetched), `requireActorOxyUserId` throws
    // `ActorResolutionPendingError` so the BullMQ inbox job retries with backoff
    // and bridges the follow on a later attempt — mirroring `handleCreate`.
    const actor = await actorService.getOrFetchActor(actorUri);
    const followerOxyUserId = requireActorOxyUserId(actor, actorUri, `Follow ${activity.id}`);

    // A self-follow (the follower resolves to the same local user) is meaningless
    // in the Oxy graph — skip before touching any state or delivering an Accept.
    if (followerOxyUserId === localUserId) {
      logger.debug(`[Federation] ignoring self-follow from ${actorUri} to ${username}`);
      return;
    }

    // Create the Oxy follow edge BEFORE sending Accept so a retry never spams
    // Accepts: the bridge is idempotent (safe to re-run), but an Accept delivered
    // before the edge was committed could be re-sent on every retry. On failure
    // the bridge throws, failing the job so the whole sequence retries.
    await this.bridgeFollowEdge(followerOxyUserId, localUserId, 'follow');

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

    // Fail-soft: the Oxy edge is already committed, so a notification failure must
    // never fail (and thus retry) the follow. `createNotification` dedupes and
    // emits realtime/push; wrap defensively and surface failures at warn only.
    //
    // Imported lazily: `notificationUtils` imports the `oxy` singleton from
    // `../../server`, and this connectors module is itself pulled in by `server`.
    // A top-level import would form a load-time cycle that leaves connector
    // singletons undefined at registry construction — the same reason
    // `resolveOxyUser` reaches the server lazily.
    try {
      const { createNotification } = await import('../../utils/notificationUtils');
      await createNotification({
        recipientId: localUserId,
        actorId: followerOxyUserId,
        type: 'follow',
        entityId: followerOxyUserId,
        entityType: 'profile',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[Federation] follow notification failed for ${localUserId} from ${actorUri}: ${message}`);
    }

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

      // Idempotency: locate the follow row FIRST. Absent → this Undo was already
      // processed (a redelivery), so there is nothing to tear down — return.
      const follow = await FederatedFollow.findOne(filter)
        .lean<{ _id: mongoose.Types.ObjectId; localUserId: string } | null>();
      if (!follow) {
        logger.debug(`Undo follow from ${actorUri}: no matching row (already processed)`);
        return;
      }

      // Remove the Oxy follow edge BEFORE deleting the local row, so a transient
      // bridge failure retries with the row still present. The edge can only
      // exist when the follower actor resolved to an Oxy user; without an
      // `oxyUserId` no edge was ever created, so there is nothing to remove.
      // THROW on transient bridge failure (job retry); the bridge is idempotent.
      //
      // Accepted residual race: if this Undo runs while the original Follow job
      // is still retrying, that later Follow attempt can re-create a ghost edge.
      // Both operations are individually convergent; we do not add cross-job
      // locking for this rare window.
      const actorRecord = await FederatedActor.findOne({ uri: actorUri })
        .lean<{ oxyUserId?: string } | null>();
      if (actorRecord?.oxyUserId) {
        await this.bridgeFollowEdge(actorRecord.oxyUserId, follow.localUserId, 'unfollow');
      }

      await FederatedFollow.deleteOne({ _id: follow._id });
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
   *
   * Deliberately NOT gated on the target owner's sharing flag, unlike
   * `handleLike` — an Undo is teardown, not new engagement. The remote server
   * sends an Undo exactly once (it never re-sends after a dropped delivery),
   * and sharing OFF-cleanup only tears down follow edges, not stray Like
   * rows — so dropping this would leave the row and its counter contribution
   * permanently orphaned. Mirrors the pre-existing `handleUndo(Follow)`
   * branch above, which is likewise ungated.
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
   *
   * Deliberately NOT gated on the target owner's sharing flag, unlike
   * `handleAnnounce` — see the matching comment on `handleUndoLike` above:
   * an Undo is teardown, sent exactly once by the remote server, and the
   * sharing OFF-cleanup job doesn't touch boost rows, so dropping this would
   * permanently orphan the boost Post and its counter contribution. Mirrors
   * the pre-existing, likewise-ungated `handleUndo(Follow)` branch.
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
    // The federated Announce incremented both counters in lockstep at import, so
    // mirror the decrement here. Guarded independently (its own `$gt: 0` filter,
    // a separate updateOne) so it never underflows AND never blocks the
    // boostsCount decrement above — federatedBoostsCount can legitimately lag
    // boostsCount on posts that predate the field until the backfill runs.
    await Post.updateOne(
      { _id: boost.boostOf, 'stats.federatedBoostsCount': { $gt: 0 } },
      { $inc: { 'stats.federatedBoostsCount': -1 } },
    );
    logger.debug(`[Federation] undo Announce from ${actorUri} (boost ${String(boost._id)})`);
  }

  private async handleCreate(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object || typeof object !== 'object') return;
    if (object.type !== 'Note' && object.type !== 'Article') return;

    // Validate the embedded content object before reading its fields by raw
    // access. A Note/Article that fails validation (e.g. missing id) is skipped
    // with a warn rather than processed from a malformed shape.
    const parsedNote = parseNote(object);
    if (!parsedNote.ok) {
      logger.warn(
        `[Federation] skipping Create from ${actorUri}: invalid embedded ${object.type}: ${summarizeZodError(parsedNote.error)}`,
      );
      return;
    }

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

    // Dedup by activityId
    const existingPost = await Post.exists({ 'federation.activityId': object.id });
    if (existingPost) return;

    // The Oxy link is MANDATORY: a federated post must carry a real Oxy author,
    // never a null one. Resolve the actor and REQUIRE its `oxyUserId`. When the
    // actor is missing or has no `oxyUserId` (Oxy unreachable when the actor was
    // resolved), `requireActorOxyUserId` throws `ActorResolutionPendingError` so
    // the BullMQ inbox job fails and retries with backoff — on a later attempt
    // (Oxy reachable) the actor resolves and the post inserts with a real author.
    // We NEVER insert an orphan post with a null author.
    const actor = await actorService.getOrFetchActor(actorUri);
    const authorOxyUserId = requireActorOxyUserId(actor, actorUri, `Create ${object.id}`);

    // Extract the body (with contentMap fallback), normalize hashtags, and
    // materialize media through the shared builder — the SAME path the outbox
    // backfill and boost/ancestor import use. A Note that carries nothing
    // storable (no text, no surviving media, no content-warning) is dropped
    // instead of persisted as a blank post.
    const built = await buildFederatedNoteContent(object, authorOxyUserId, {
      activityId: object.id,
      actorUri,
    });
    if (built.skip) {
      logger.debug(`Skipping empty federated Create from ${actorUri} (${object.id}): ${built.reason}`);
      return;
    }
    const { media, attachments, hashtags, summary, sensitive, variants } = built;

    // Preserve the ORIGINAL publish date so a federated post reflects when it
    // was authored remotely, not when our inbox happened to receive it. The Note
    // carries its own `published`; fall back to the Create activity's `published`
    // (mirrors the outbox-backfill path). Mongoose 9's timestamps plugin honors a
    // `createdAt` supplied on a NEW document (it only fills the default when the
    // value is absent), so threading `createdAt`/`updatedAt` through
    // PostCreationService persists the real date without disabling timestamps.
    // Missing/invalid/future → undefined → schema timestamps fall back to now.
    const originalCreatedAt = parseApPublished(object.published ?? activity.published);

    // When this Note is a reply, resolve it to the local thread: parentPostId is
    // the parent Post's _id and threadId is the thread ROOT id (mirroring the
    // native reply rule). A parent not yet imported is backfilled (bounded) so
    // the reply joins the existing thread instead of being orphaned. `inReplyTo`
    // is normalized to a clean string URI (string IRI or embedded Link object).
    const inReplyToUri = extractInReplyToUri(object.inReplyTo);
    const threadLink = inReplyToUri
      ? await outboxSyncService.ensureFederatedReplyLink(inReplyToUri)
      : null;

    // A reply targets its parent post's owner — if that owner is a LOCAL
    // user who has turned fediverse sharing off, drop the reply silently
    // rather than materialize it against an opted-out account.
    if (threadLink && !(await this.isLocalPostOwnerSharingEnabled(threadLink.parentPostId))) {
      logger.debug(`[Federation] dropping reply Create from ${actorUri} — parent post owner has sharing disabled`);
      return;
    }

    await getPostCreator().create({
      oxyUserId: authorOxyUserId,
      federation: {
        activityId: object.id,
        actorUri,
        inReplyTo: inReplyToUri,
        url: object.url || object.id,
        sensitive,
        spoilerText: summary,
      },
      parentPostId: threadLink?.parentPostId ?? null,
      threadId: threadLink?.threadId ?? null,
      content: {
        // The body lives ONLY in the variants — a `contentMap` is one body PER
        // LANGUAGE, not a fallback for one. `variants[0]` is the primary.
        variants: variants.length > 0 ? variants : undefined,
        media: media.length > 0 ? media : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      visibility: mapApVisibility(object.to, object.cc),
      hashtags,
      // AP-derived language so Mastodon/Pleroma posts carry their REAL language
      // (and feed the Stage-A classifier) instead of defaulting to 'en'. The
      // singular `language` sets the top-level `post.language` (primary); the full
      // declared set (top-level `language` + every `contentMap` key) feeds the
      // classifier's `postClassification.languages`.
      language: extractApLanguage(object),
      languages: extractApLanguages(object),
      // Instance host drives the Stage-A coarse region for federated posts.
      instanceDomain: getRemoteHost(actorUri),
      // AP actor type feeds the Stage-A RSS/bot-mirror spam signal.
      actorType: actor?.type,
      status: 'published',
      metadata: { isSensitive: sensitive },
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
      ...(originalCreatedAt ? { createdAt: originalCreatedAt, updatedAt: originalCreatedAt } : {}),
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

    if (!(await this.isLocalPostOwnerSharingEnabled(postId))) {
      logger.debug(`[Federation] dropping Like from ${actorUri} on ${postId} — target owner has sharing disabled`);
      return;
    }

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

    // A boost targets the announced post's owner — resolved separately from
    // `importAnnounce`'s own resolution below since the gate must run BEFORE
    // any booster-actor resolution or boost-record creation. `null` (not yet
    // mirrored locally, or a genuinely remote post) skips the gate: there is
    // no local owner to protect.
    const announcedPostId = await resolvePostIdFromObjectUri(announcedUri);
    if (announcedPostId && !(await this.isLocalPostOwnerSharingEnabled(announcedPostId))) {
      logger.debug(`[Federation] dropping Announce from ${actorUri} of ${announcedUri} — target owner has sharing disabled`);
      return;
    }

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
      // Validate the edited content object before reading its fields by raw
      // access; skip a malformed edit with a warn.
      const parsedNote = parseNote(object);
      if (!parsedNote.ok) {
        logger.warn(
          `[Federation] skipping Update from ${actorUri}: invalid embedded ${object.type}: ${summarizeZodError(parsedNote.error)}`,
        );
        return;
      }

      // `object.id` is raw, remote-controlled AP JSON. Require a real string
      // BEFORE it flows into any Mongo filter: a non-string value (e.g.
      // `{ $gt: '' }`) would turn the equality match into an operator query
      // matching arbitrary posts (NoSQL injection). This proven-string barrier
      // is also the recognized CodeQL sanitizer for the query taint.
      const objectActivityId = object.id;
      if (typeof objectActivityId !== 'string' || objectActivityId.length === 0) return;

      // An Update may only edit the SENDING actor's OWN post. Scope every query
      // by both the activity id AND `federation.actorUri` (stamped at create on
      // the inbox Create + outbox backfill paths) so a remote server cannot
      // overwrite another actor's post by replaying its activityId.
      const editFilter = {
        'federation.activityId': objectActivityId,
        'federation.actorUri': actorUri,
      };

      const existingPost = await Post.findOne(editFilter, { oxyUserId: 1 }).lean<
        { oxyUserId?: string | null } | null
      >();
      const ownerOxyUserId = existingPost?.oxyUserId ?? (await actorService.getOrFetchActor(actorUri))?.oxyUserId ?? null;

      // Extract the edited body through the SAME shared logic as fresh ingest —
      // contentMap fallback, hashtag normalization, media materialization, and
      // CW/sensitive passthrough — so an edited contentMap-only / CW / all-hashtag
      // note keeps its body instead of being blanked. Edit semantics differ from
      // Create: NO empty-note guard here — an Update applies its consistently
      // extracted fields (set when present, unset when the edit removed them),
      // never skips/deletes.
      const built = await buildFederatedNoteContentForEdit(object, ownerOxyUserId, {
        activityId: objectActivityId,
        actorUri,
      });

      const derivedType = built.media.length > 0
        ? (built.media.some((m) => m.type === 'video') ? PostType.VIDEO : PostType.IMAGE)
        : PostType.TEXT;

      const setOps: Record<string, unknown> = {
        hashtags: built.hashtags,
        type: derivedType,
        'federation.sensitive': built.sensitive,
        'metadata.isSensitive': built.sensitive,
        'metadata.isEdited': true,
        updatedAt: new Date(),
      };
      const unsetOps: Record<string, ''> = {};
      if (built.media.length > 0) setOps['content.media'] = built.media;
      else unsetOps['content.media'] = '';
      if (built.attachments.length > 0) setOps['content.attachments'] = built.attachments;
      else unsetOps['content.attachments'] = '';
      if (built.summary !== undefined) setOps['federation.spoilerText'] = built.summary;
      else unsetOps['federation.spoilerText'] = '';

      // The body. Variants are REPLACED wholesale by the edit, never merged.
      // Three consequences, all intended: the new body lands, a language the
      // author dropped from the edit disappears with it, and any machine
      // translation cached against the OLD body is discarded — a translation of
      // text that no longer exists is worse than no translation.
      if (built.variants.length > 0) setOps['content.variants'] = built.variants;
      else unsetOps['content.variants'] = '';

      const update: Record<string, unknown> = { $set: setOps };
      if (Object.keys(unsetOps).length > 0) update.$unset = unsetOps;
      await Post.updateOne(editFilter, update);
      logger.debug(`Updated federated post: ${objectActivityId}`);
    } else if (object.type === 'Person' || object.type === 'Service' || object.type === 'Application') {
      // Profile update — re-fetch the actor to get updated data
      await actorService.fetchRemoteActor(actorUri);
      logger.debug(`Updated federated actor: ${actorUri}`);
    }
  }
}

export const inboxProcessingService = new InboxProcessingService();
export default inboxProcessingService;
