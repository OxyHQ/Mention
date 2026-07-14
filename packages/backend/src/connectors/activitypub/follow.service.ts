import { logger } from '../../utils/logger';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import FederatedFollow from '../../models/FederatedFollow';
import FederationDeliveryQueue from '../../models/FederationDeliveryQueue';
import { signRequest, getPublicKey } from './crypto';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTEXT,
  AP_CONTENT_TYPE,
  USER_AGENT,
  actorUrl,
} from './constants';
import { PostVisibility, canonicalizeLanguageTag, type MediaItem, type PostContent } from '@mention/shared-types';
import { authorVariants, resolveVariant } from '../../services/postVariants';
import { enqueueDelivery } from '../../queue/producers';
import { isFediverseSharingEnabled } from '../../services/fediverseSharing';
import { actorService } from './actor.service';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { assertSafePublicUrl } from '../../utils/ssrfGuard';
import { resolveMediaRef } from '../../utils/mediaResolver';
import { isAbsoluteHttpUrl } from '../shared/url';

const DELIVER_ACTIVITY_TIMEOUT_MS = 15000;
const DELIVERY_RESPONSE_PREVIEW_MAX_BYTES = 1024;

/**
 * MIME derivation for an ActivityPub media `attachment`. Extension-first (for the
 * federated raw URLs / CDNs that carry one), otherwise a category default keyed
 * off the stored media `type`. Every default is a MIME Mastodon accepts, so an
 * attachment is never dropped for an "unsupported mediaType"; remote servers
 * re-derive the exact type when they download the file, so a category-level hint
 * (e.g. `image/jpeg` for a PNG served id-only from our CDN) is corrected there.
 */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const ATTACHMENT_MIME_BY_TYPE: Record<MediaItem['type'], string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  gif: 'image/gif',
};

/**
 * Build one ActivityStreams `Document` attachment from a stored post media item,
 * or `undefined` when it cannot be resolved to an absolute URL. Native Oxy file
 * ids are resolved through the canonical media chokepoint (`resolveMediaRef`);
 * federated media stored as a raw absolute URL is advertised verbatim (never
 * proxied back out to the fediverse). Fail-soft: any resolution problem yields
 * `undefined` so a single bad item never breaks the Note.
 */
function buildNoteAttachment(item: MediaItem | undefined | null): Record<string, unknown> | undefined {
  const ref = item?.id;
  if (!ref) return undefined;

  let url: string | undefined;
  try {
    url = isAbsoluteHttpUrl(ref) ? ref : resolveMediaRef(ref).url || undefined;
  } catch {
    return undefined;
  }
  if (!url || !isAbsoluteHttpUrl(url)) return undefined;

  // Extension from the PATHNAME only — never the host (its dots would yield a
  // bogus "extension"). Absent/unknown → category default below.
  let extension: string | undefined;
  try {
    extension = new URL(url).pathname.split('.').pop()?.toLowerCase();
  } catch {
    extension = undefined;
  }
  const mediaType =
    (extension && ATTACHMENT_MIME_BY_EXT[extension]) ||
    ATTACHMENT_MIME_BY_TYPE[item?.type as MediaItem['type']] ||
    'image/jpeg';

  const attachment: Record<string, unknown> = { type: 'Document', mediaType, url };
  // Alt text → AP `name` (accessibility description), when the author provided one.
  if (item?.alt) attachment.name = item.alt;
  return attachment;
}

/**
 * The post fields the Note builder reads. A lean `Post` document satisfies it —
 * every caller (push delivery, the outbox page, the per-post dereference route)
 * already has one, so nothing re-fetches.
 */
export interface NoteSourcePost {
  _id: unknown;
  content: PostContent;
  hashtags?: string[];
  mentions?: string[];
  createdAt: string | Date;
}

/**
 * Build the AP `contentMap`: BCP-47 tag → localized body, PRIMARY KEY FIRST.
 *
 * The primary key is inserted before the rest are walked, so it leads the map
 * unconditionally — the ordering is what Mastodon derives the status language
 * from, and it must not depend on the shape of the data. Its value is the
 * RESOLVED primary body, the same string that goes out as `content`, so the two
 * can never disagree.
 *
 * Only AUTHOR variants are emitted. A machine translation is derived content: it
 * is not the author's writing and it does not federate.
 *
 * Returns `undefined` when the post declares no language — an UNTAGGED primary
 * variant (a body too short to detect, a remote Note that declared none) has no
 * key to sit under, and an empty map is not a legal AS2 `contentMap`. Such a post
 * federates with a body and no language claim, which is the honest thing: we
 * would otherwise be inventing a language for text nobody could identify.
 */
function buildNoteContentMap(
  post: NoteSourcePost,
  primaryTag: string | undefined,
  primaryBody: string,
): Record<string, string> | undefined {
  const contentMap: Record<string, string> = {};

  if (primaryTag) contentMap[primaryTag] = primaryBody;

  for (const variant of authorVariants(post.content)) {
    const tag = canonicalizeLanguageTag(variant.tag);
    if (tag === null || tag in contentMap) continue;
    contentMap[tag] = variant.text;
  }

  return Object.keys(contentMap).length > 0 ? contentMap : undefined;
}

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
 * Extracted verbatim from the former monolithic FederationService — same behavior,
 * same signatures. Depends on ActorService (actor resolution) and the delivery
 * queue producer. `federateNewPost` remains reachable from PostCreationService
 * via the connector registry's registered PostFederator (the AP connector's
 * `deliver`).
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
   *
   * The SINGLE Note builder shared by push delivery (`federateNewPost`), the
   * outbox page, and the per-post dereference route so every surface Mastodon
   * reads carries the same fidelity: canonical post URL, hashtag `tag`s, media
   * `attachment`s (built via the canonical media chokepoint, fail-soft), and the
   * post's language.
   *
   * LANGUAGE — `content` + `contentMap` + `language`:
   *
   * A Mastodon-compatible status carries ONE body. `content` is the primary
   * body; `contentMap` is a map of BCP-47 tag → localized body, which Mastodon
   * only reads as a FALLBACK when `content` is missing (`status_parser.rb`). So a
   * multilingual Mention post federates as its PRIMARY body plus the full map —
   * never as two rendered bodies.
   *
   * The map's KEY ORDER is load-bearing: Mastodon takes the status's language
   * from `contentMap.keys.first`. The primary tag is therefore emitted first, or
   * the status is labelled with the wrong language. Emitting a SINGLE-key map for
   * a monolingual post is not redundant — it is the only way Mastodon learns the
   * language at all.
   *
   * The body is RESOLVED from the post's primary variant here, at read time.
   * There is no stored copy of it to read instead: AP's single `content` slot is
   * a wire format, not a reason to denormalize storage.
   *
   * Media is a single AP `attachment` set, so it is the PRIMARY rendition's media
   * (the shared set, or that variant's override, with its alt text already
   * localized by the resolver). A non-primary variant's media override is
   * internal to Mention — there is nowhere in AS2 to put a second attachment set.
   */
  buildCreateNoteActivity(post: NoteSourcePost, username: string): Record<string, unknown> {
    const actor = actorUrl(username);
    const postId = String(post._id);
    const noteId = `${actor}/posts/${postId}`;
    // Emit a canonical ISO 8601 `published` regardless of whether the caller
    // passed a Mongoose `Date` (outbox/dereference) or an ISO string (push).
    const published = post.createdAt instanceof Date ? post.createdAt.toISOString() : post.createdAt;

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

    // The primary rendition: its body, its media (shared or overridden, alt
    // localized) and the tag it is written in — all from the one resolver.
    const primary = resolveVariant(post.content);

    const attachments = Array.isArray(primary.media)
      ? primary.media
          .map(buildNoteAttachment)
          .filter((a): a is Record<string, unknown> => a !== undefined)
      : [];

    const primaryBody = primary.text;
    const language = canonicalizeLanguageTag(primary.tag) ?? undefined;
    const contentMap = buildNoteContentMap(post, language, primaryBody);

    return {
      '@context': AP_CONTEXT,
      id: `${noteId}/activity`,
      type: 'Create',
      actor,
      published,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actor}/followers`],
      object: {
        id: noteId,
        type: 'Note',
        attributedTo: actor,
        url: `https://${FEDERATION_DOMAIN}/@${username}/posts/${postId}`,
        content: primaryBody,
        contentMap,
        language,
        published,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actor}/followers`],
        tag: tags.length > 0 ? tags : undefined,
        attachment: attachments.length > 0 ? attachments : undefined,
      },
    };
  }

  /**
   * Federate a newly created local post to all remote followers.
   */
  async federateNewPost(
    post: NoteSourcePost & { visibility: string },
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void> {
    if (!FEDERATION_ENABLED) return;
    // Defensive: the `ConnectorRegistry` outbound seam already gates every
    // event on `fediverseSharing` before it reaches a connector. This
    // duplicate check protects any other caller that might reach
    // `federateNewPost` directly, bypassing the registry.
    if (!(await isFediverseSharingEnabled(senderOxyUserId))) return;
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

    // `inboxUrl` is schema-optional (atproto actors have none); an AP actor we
    // are sending Undo(Follow) to always has one. When neither inbox is known the
    // local follow is already removed — just skip the outbound delivery.
    const targetInbox = actor.sharedInboxUrl ?? actor.inboxUrl;
    if (targetInbox) {
      void this.deliverActivity(activity, targetInbox, localOxyUserId, localUsername)
        .then((delivered) => {
          if (!delivered) return this.queueDelivery(activity, targetInbox, localOxyUserId);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[FedSync] background undo-follow delivery failed for ${remoteActorUri}: ${message}`);
        });
    }

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
    // `inboxUrl` is schema-optional (atproto actors have none); an AP actor we
    // are sending Accept(Follow) to always has one. Guard so the absent case is
    // a logged no-op instead of delivering to `undefined`.
    if (!actor.inboxUrl) {
      logger.warn(`[FedSync] cannot send Accept(Follow) to ${remoteActorUri}: actor has no inboxUrl`);
      return;
    }

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
