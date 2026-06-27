import { logger } from '../../utils/logger';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import FederationDeliveryQueue from '../../models/FederationDeliveryQueue';
import { signRequest, getPublicKey } from '../../utils/federation/crypto';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTEXT,
  AP_CONTENT_TYPE,
  USER_AGENT,
  actorUrl,
} from '../../utils/federation/constants';
import { PostVisibility } from '@mention/shared-types';
import { enqueueDelivery } from '../../queue/producers';
import { actorService } from './ActorService';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { assertSafePublicUrl } from '../../utils/ssrfGuard';

const DELIVER_ACTIVITY_TIMEOUT_MS = 15000;
const DELIVERY_RESPONSE_PREVIEW_MAX_BYTES = 1024;

async function readResponsePreview(response: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      chunks.push(buffer);
      if (totalBytes >= DELIVERY_RESPONSE_PREVIEW_MAX_BYTES) break;
    }
  } catch {
    return '';
  } finally {
    const maybeDestroy = response as NodeJS.ReadableStream & { destroy?: () => void };
    maybeDestroy.destroy?.();
  }

  return Buffer.concat(chunks).toString('utf8', 0, DELIVERY_RESPONSE_PREVIEW_MAX_BYTES);
}

/**
 * Outbound activity delivery + follow lifecycle (Follow / Undo(Follow) /
 * Accept(Follow)) and local-post federation to remote followers.
 *
 * Extracted verbatim from the monolithic FederationService — same behavior,
 * same signatures. Depends on ActorService (actor resolution) and the delivery
 * queue producer. `federateNewPost` remains reachable from PostCreationService
 * via the FederationService facade's registered PostFederator.
 */
export class FollowService {
  // ============================================================
  // Activity Delivery
  // ============================================================

  /**
   * Deliver an activity to a remote inbox, signed with the sender's key.
   */
  async deliverActivity(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<boolean> {
    try {
      const { keyId } = await getPublicKey(senderUsername);
      const body = JSON.stringify(activity);
      const sigHeaders = await signRequest(keyId, 'POST', targetInbox, body);

      const allHeaders: Record<string, string> = {
        'Content-Type': AP_CONTENT_TYPE,
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        'User-Agent': USER_AGENT,
        Accept: AP_CONTENT_TYPE,
        ...sigHeaders,
      };

      logger.debug(`[FedDeliver] POST ${targetInbox} body=${body} sig-headers=${sigHeaders['Signature']?.match(/headers="([^"]+)"/)?.[1]}`);

      const { response, status } = await fetchUpstreamSingleHop(targetInbox, {
        method: 'POST',
        headers: allHeaders,
        body,
        signal: AbortSignal.timeout(DELIVER_ACTIVITY_TIMEOUT_MS),
        headersTimeoutMs: DELIVER_ACTIVITY_TIMEOUT_MS,
      });

      if ((status >= 200 && status < 300) || status === 202) {
        response.destroy();
        return true;
      }

      const responseBody = await readResponsePreview(response);
      logger.debug(`Activity delivery failed to ${targetInbox}: ${status} body=${responseBody.slice(0, 500)}`);
      return false;
    } catch (err) {
      logger.debug(`Activity delivery error to ${targetInbox}:`, err);
      return false;
    }
  }

  /**
   * Queue an activity for delivery (with retries).
   *
   * Durable path: enqueue onto the BullMQ delivery queue (deduped per
   * targetInbox + activity id). When the queue is unavailable (Redis not
   * configured) fall back to the Mongo delivery queue, which the in-process
   * scheduler retries. Either way the delivery is never lost.
   */
  async queueDelivery(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
  ): Promise<void> {
    // Defense-in-depth: never enqueue a durable delivery to an unsafe inbox
    // URL. The per-send fetch in `deliverActivity` is already SSRF-pinned, but
    // a blocked URL would otherwise sit in the queue and be retried forever.
    const guard = await assertSafePublicUrl(targetInbox);
    if (!guard.ok) {
      logger.warn(`[FedDeliver] not queueing unsafe inbox URL ${targetInbox}: ${guard.reason}`);
      return;
    }

    const enqueued = await enqueueDelivery({
      activityJson: activity,
      targetInbox,
      senderOxyUserId,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedDeliver] enqueue failed for ${targetInbox}, falling back to Mongo: ${message}`);
      return false;
    });

    if (enqueued) return;

    await FederationDeliveryQueue.create({
      activityJson: activity,
      targetInbox,
      senderOxyUserId,
      nextAttemptAt: new Date(),
    });
  }

  /**
   * Deliver an activity to all remote followers of a local user.
   * Groups deliveries by shared inbox for efficiency.
   */
  async deliverToFollowers(
    activity: Record<string, unknown>,
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    const follows = await FederatedFollow.find({
      localUserId: senderOxyUserId,
      direction: 'inbound',
      status: 'accepted',
    }).lean();

    if (follows.length === 0) return;

    const actorUris = follows.map((f) => f.remoteActorUri);
    const actors = await FederatedActor.find({ uri: { $in: actorUris } }).lean();

    // Group by shared inbox to avoid duplicate deliveries.
    const seen = new Set<string>();
    const inboxes: string[] = [];
    for (const actor of actors) {
      const inbox = actor.sharedInboxUrl || actor.inboxUrl;
      if (inbox && !seen.has(inbox)) {
        seen.add(inbox);
        inboxes.push(inbox);
      }
    }
    if (inboxes.length === 0) return;

    // Durable path: enqueue one BullMQ delivery per shared inbox (deduped per
    // inbox + activity id). When the queue is unavailable fall back to a single
    // Mongo batch insert for the inboxes that were not enqueued.
    const now = new Date();
    const mongoFallback: Array<{
      activityJson: Record<string, unknown>;
      targetInbox: string;
      senderOxyUserId: string;
      nextAttemptAt: Date;
    }> = [];

    for (const inbox of inboxes) {
      const enqueued = await enqueueDelivery({
        activityJson: activity,
        targetInbox: inbox,
        senderOxyUserId,
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedDeliver] follower enqueue failed for ${inbox}, falling back to Mongo: ${message}`);
        return false;
      });

      if (!enqueued) {
        mongoFallback.push({ activityJson: activity, targetInbox: inbox, senderOxyUserId, nextAttemptAt: now });
      }
    }

    if (mongoFallback.length > 0) {
      await FederationDeliveryQueue.insertMany(mongoFallback, { ordered: false });
    }
  }

  /**
   * Convert a local Mention post to an ActivityPub Create(Note) activity.
   */
  buildCreateNoteActivity(
    post: { _id: any; content: { text?: string }; hashtags?: string[]; mentions?: string[]; createdAt: string },
    username: string,
  ): Record<string, unknown> {
    const actor = actorUrl(username);
    const noteId = `${actor}/posts/${post._id}`;

    const tags: Array<Record<string, string>> = [];
    if (post.hashtags) {
      for (const tag of post.hashtags) {
        tags.push({
          type: 'Hashtag',
          href: `https://${FEDERATION_DOMAIN}/hashtag/${encodeURIComponent(tag)}`,
          name: `#${tag}`,
        });
      }
    }

    return {
      '@context': AP_CONTEXT,
      id: `${noteId}/activity`,
      type: 'Create',
      actor,
      published: post.createdAt,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actor}/followers`],
      object: {
        id: noteId,
        type: 'Note',
        attributedTo: actor,
        url: `https://${FEDERATION_DOMAIN}/@${username}/posts/${post._id}`,
        content: post.content.text || '',
        published: post.createdAt,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actor}/followers`],
        tag: tags.length > 0 ? tags : undefined,
      },
    };
  }

  /**
   * Federate a newly created local post to all remote followers.
   */
  async federateNewPost(
    post: { _id: any; content: { text?: string }; hashtags?: string[]; mentions?: string[]; visibility: string; createdAt: string },
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    if (post.visibility !== PostVisibility.PUBLIC) return;

    try {
      const activity = this.buildCreateNoteActivity(post, senderUsername);
      await this.deliverToFollowers(activity, senderOxyUserId, senderUsername);
    } catch (err) {
      logger.error('Failed to federate new post:', err);
    }
  }

  // ============================================================
  // Follow Management
  // ============================================================

  /**
   * Send a Follow activity to a remote actor.
   */
  async sendFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<{ success: boolean; pending: boolean }> {
    if (!FEDERATION_ENABLED) return { success: false, pending: false };

    // Never block the follow request on a remote actor fetch. Use whatever is
    // cached; if the actor is unknown locally we still record the follow and
    // queue the Follow activity, then refresh the actor in the background.
    const cached = await FederatedActor.findOne({ uri: remoteActorUri }).lean<IFederatedActor>();

    // Always refresh the actor in the background so its inbox/profile stay
    // current (and so a missing actor gets resolved for delivery shortly).
    actorService.refreshActorInBackground(remoteActorUri, cached ?? undefined);

    const canonicalUri = cached?.uri ?? remoteActorUri;
    const localActorUri = actorUrl(localUsername);
    // Use the actor _id when known, otherwise a stable hash of the URI so the
    // activity ID is deterministic across retries before the actor is cached.
    const activityIdSuffix = cached?._id
      ? String(cached._id)
      : encodeURIComponent(canonicalUri);
    const activityId = `${localActorUri}/follows/${activityIdSuffix}`;

    // Create or update the follow record
    await FederatedFollow.findOneAndUpdate(
      { localUserId: localOxyUserId, remoteActorUri: canonicalUri, direction: 'outbound' },
      { $set: { status: 'pending', activityId } },
      { upsert: true, returnDocument: 'after' },
    );

    const activity: Record<string, unknown> = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Follow',
      actor: localActorUri,
      object: canonicalUri,
    };

    // If we know the inbox, attempt delivery in the background; otherwise queue
    // for the delivery worker, which resolves the inbox once the actor lands.
    const targetInbox = cached?.sharedInboxUrl ?? cached?.inboxUrl;
    if (targetInbox) {
      void this.deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
        .then((delivered) => {
          if (!delivered) return this.queueDelivery(activity, targetInbox, localOxyUserId);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedSync] background follow delivery failed for ${canonicalUri}: ${message}`);
        });
    } else {
      // No cached inbox yet — resolve the actor's inbox in the background and
      // queue the Follow for delivery once known. Reports success optimistically;
      // the delivery worker retries the queued delivery. Never blocks the caller.
      this.queueFollowOnceActorKnown(activity, canonicalUri, localOxyUserId, remoteActorUri);
    }

    return { success: true, pending: cached?.manuallyApprovesFollowers ?? false };
  }

  /**
   * Resolve the target actor's inbox in the background and queue the Follow
   * activity for delivery once known. Fire-and-forget: returns synchronously and
   * never blocks the caller on remote I/O.
   */
  private queueFollowOnceActorKnown(
    activity: Record<string, unknown>,
    canonicalUri: string,
    localOxyUserId: string,
    remoteActorUri: string,
  ): void {
    void (async () => {
      try {
        let actor = await FederatedActor.findOne({ uri: canonicalUri }).lean<IFederatedActor>();
        if (!actor?.inboxUrl) {
          actor = await actorService.fetchRemoteActor(remoteActorUri) as IFederatedActor | null;
        }
        const inbox = actor?.sharedInboxUrl ?? actor?.inboxUrl;
        if (inbox) {
          await this.queueDelivery(activity, inbox, localOxyUserId);
        } else {
          logger.warn(`[FedSync] could not resolve inbox to deliver Follow to ${remoteActorUri}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] deferred follow delivery setup failed for ${remoteActorUri}: ${message}`);
      }
    })();
  }

  /**
   * Send an Undo(Follow) activity to a remote actor.
   */
  async sendUndoFollow(
    localOxyUserId: string,
    localUsername: string,
    remoteActorUri: string,
  ): Promise<boolean> {
    if (!FEDERATION_ENABLED) return false;

    const follow = await FederatedFollow.findOne({
      localUserId: localOxyUserId,
      remoteActorUri,
      direction: 'outbound',
    });
    if (!follow) return false;

    const actor = await FederatedActor.findOne({ uri: remoteActorUri }).lean();
    if (!actor) return false;

    const localActorUri = actorUrl(localUsername);

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: `${localActorUri}/follows/${actor._id}/undo`,
      type: 'Undo',
      actor: localActorUri,
      object: {
        id: follow.activityId,
        type: 'Follow',
        actor: localActorUri,
        object: remoteActorUri,
      },
    };

    // Remove the local follow immediately so the unfollow reflects in the UI,
    // then deliver the Undo in the background — never block the request on the
    // remote POST.
    await FederatedFollow.deleteOne({ _id: follow._id });

    const targetInbox = actor.sharedInboxUrl ?? actor.inboxUrl;
    void this.deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
      .then((delivered) => {
        if (!delivered) return this.queueDelivery(activity, targetInbox, localOxyUserId);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] background undo-follow delivery failed for ${remoteActorUri}: ${message}`);
      });

    return true;
  }

  /**
   * Send an Accept(Follow) activity back to a remote actor.
   */
  async sendAccept(
    localOxyUserId: string,
    localUsername: string,
    followActivityId: string,
    remoteActorUri: string,
  ): Promise<void> {
    const actor = await FederatedActor.findOne({ uri: remoteActorUri }).lean();
    if (!actor) return;

    const localActorUri = actorUrl(localUsername);

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: `${localActorUri}/accepts/${Date.now()}`,
      type: 'Accept',
      actor: localActorUri,
      object: {
        id: followActivityId,
        type: 'Follow',
        actor: remoteActorUri,
        object: localActorUri,
      },
    };

    const delivered = await this.deliverActivity(activity, actor.inboxUrl, localOxyUserId, localUsername);
    if (!delivered) {
      await this.queueDelivery(activity, actor.inboxUrl, localOxyUserId);
    }
  }
}

export const followService = new FollowService();
export default followService;
