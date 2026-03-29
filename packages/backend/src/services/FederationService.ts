import { logger } from '../utils/logger';
import sanitizeHtml from 'sanitize-html';
import FederatedActor, { IFederatedActor } from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import FederationDeliveryQueue, { getNextRetryTime } from '../models/FederationDeliveryQueue';
import { Post } from '../models/Post';
import { signRequest, getKeyPair } from '../utils/federation/crypto';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  FEDERATION_MAX_CONTENT_LENGTH,
  AP_CONTEXT,
  AP_CONTENT_TYPE,
  AP_ACCEPT_TYPES,
  USER_AGENT,
  actorUrl,
  isBlockedDomain,
  resolveOxyUser,
} from '../utils/federation/constants';
import { PostVisibility } from '@mention/shared-types';
import { htmlToPlainText } from '../utils/federation/htmlToPlainText';
import { decode as decodeEntities } from 'he';
import { getServiceOxyClient } from '../utils/oxyHelpers';

/**
 * Sign a GET request using the instance actor key pair (managed by Oxy).
 * Required by servers that enforce authorized fetch (e.g., Threads).
 */
async function signedFetch(url: string, accept: string): Promise<Response> {
  const acceptHeader = `${accept}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`;
  const keyPair = await getKeyPair('instance');
  const sigHeaders = signRequest(keyPair.privateKeyPem, keyPair.keyId, 'GET', url);

  const res = await fetch(url, {
    headers: {
      Accept: acceptHeader,
      'User-Agent': USER_AGENT,
      ...sigHeaders,
    },
    signal: AbortSignal.timeout(10000),
  });

  // If the remote server returns a 5xx (e.g. it can't resolve our keyId to verify
  // the signature), retry without the signature as a fallback for public resources.
  if (res.status >= 500) {
    logger.info(`[FedSync] signedFetch got ${res.status} for ${url}, retrying unsigned`);
    return fetch(url, {
      headers: {
        Accept: acceptHeader,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(10000),
    });
  }

  return res;
}

class FederationService {
  /**
   * Extract candidate top-level notes from outbox items into the candidates array.
   */
  private extractCandidates(
    items: any[],
    candidates: { note: any; activity: any; activityId: string }[],
    limit: number,
  ): void {
    for (const item of items) {
      if (candidates.length >= limit) break;

      const activity = typeof item === 'string' ? null : item;
      if (!activity) continue;

      const note = activity.type === 'Create' ? activity.object :
        (activity.type === 'Note' || activity.type === 'Article') ? activity : null;
      if (!note || typeof note !== 'object') continue;
      if (note.type !== 'Note' && note.type !== 'Article') continue;
      if (note.inReplyTo) continue;

      const activityId = note.id || activity.id;
      if (!activityId) continue;

      candidates.push({ note, activity, activityId });
    }
  }

  /**
   * Extract the actor URI from an AP attributedTo value,
   * which may be a plain URI string or an object with an id property.
   */
  private extractActorUri(attributedTo: unknown): string | undefined {
    if (typeof attributedTo === 'string') return attributedTo;
    if (attributedTo && typeof attributedTo === 'object' && 'id' in attributedTo) {
      return (attributedTo as { id?: string }).id;
    }
    return undefined;
  }
  // ============================================================
  // Actor Resolution
  // ============================================================

  /**
   * Resolve a WebFinger acct to an ActivityPub actor URI.
   * @param acct - e.g. "alice@mastodon.social" or "@alice@mastodon.social"
   */
  async resolveWebFinger(acct: string): Promise<string | null> {
    const cleaned = acct.replace(/^@/, '');
    const atIndex = cleaned.indexOf('@');
    if (atIndex === -1) return null;

    const domain = cleaned.substring(atIndex + 1);
    if (isBlockedDomain(domain)) return null;

    const resource = `acct:${cleaned}`;
    const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/jrd+json, application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;

      const data = await res.json() as {
        links?: Array<{ rel?: string; type?: string; href?: string }>;
      };
      const link = data.links?.find(
        (l) => l.rel === 'self' && l.type && AP_ACCEPT_TYPES.includes(l.type)
      );
      return link?.href || null;
    } catch (err) {
      logger.warn(`WebFinger resolution failed for ${acct}:`, err);
      return null;
    }
  }

  /**
   * Fetch and store/update a remote ActivityPub actor by URI.
   */
  async fetchRemoteActor(actorUri: string): Promise<IFederatedActor | null> {
    try {
      // Normalize: strip www. prefix for known AP domains (e.g., www.threads.net → threads.net)
      actorUri = actorUri.replace(/^(https?:\/\/)www\./i, '$1');

      // Use signed fetch for servers that enforce authorized fetch (e.g., Threads)
      let res = await signedFetch(actorUri, AP_CONTENT_TYPE);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.info(`[FedSync] fetchRemoteActor HTTP ${res.status} ${res.statusText} for ${actorUri} body=${body.slice(0, 500)}`);

        // If direct fetch failed, try WebFinger to resolve the canonical actor URI.
        // Some servers (e.g., Threads) use numeric IDs in AP URIs that differ from
        // the username-based URI we may have stored.
        const parsed = new URL(actorUri);
        const pathUsername = parsed.pathname.split('/').filter(Boolean).pop();
        if (pathUsername) {
          const acct = `${pathUsername}@${parsed.hostname}`;
          logger.info(`[FedSync] attempting WebFinger fallback for ${acct}`);
          const resolved = await this.resolveWebFinger(acct);
          if (resolved && resolved !== actorUri) {
            logger.info(`[FedSync] WebFinger resolved ${acct} → ${resolved}`);
            res = await signedFetch(resolved, AP_CONTENT_TYPE);
            if (res.ok) {
              actorUri = resolved;
            } else {
              const body2 = await res.text().catch(() => '');
              logger.info(`[FedSync] fetchRemoteActor HTTP ${res.status} for resolved ${resolved} body=${body2.slice(0, 500)}`);
              return null;
            }
          } else {
            logger.info(`[FedSync] WebFinger returned ${resolved ?? 'null'} for ${acct}`);
            return null;
          }
        } else {
          return null;
        }
      }

      const actor = await res.json() as Record<string, any>;
      if (!actor.id || !actor.inbox) {
        logger.info(`[FedSync] fetchRemoteActor missing fields for ${actorUri}: id=${!!actor.id} inbox=${!!actor.inbox} type=${actor.type} keys=${Object.keys(actor).join(',')}`);
        return null;
      }

      const domain = new URL(actor.id).hostname;
      if (isBlockedDomain(domain)) {
        logger.info(`[FedSync] fetchRemoteActor blocked domain ${domain} for ${actorUri}`);
        return null;
      }

      const username = actor.preferredUsername || actor.name || 'unknown';
      const acct = `${username}@${domain}`;

      // Fetch collection counts (followers, following, posts) in parallel
      const [followersCount, followingCount, postsCount] = await Promise.all([
        this.fetchCollectionCount(actor.followers),
        this.fetchCollectionCount(actor.following),
        this.fetchCollectionCount(actor.outbox),
      ]);

      // Extract profile fields (PropertyValue attachments)
      const fields: { name: string; value: string; verifiedAt?: Date }[] = [];
      if (Array.isArray(actor.attachment)) {
        for (const att of actor.attachment) {
          if (att?.type === 'PropertyValue' && att.name && att.value) {
            fields.push({
              name: att.name,
              value: sanitizeHtml(att.value, {
                allowedTags: ['a', 'span'],
                allowedAttributes: { a: ['href', 'rel'] },
              }),
              verifiedAt: att.verifiedAt ? new Date(att.verifiedAt) : undefined,
            });
          }
        }
      }

      const update: Partial<IFederatedActor> = {
        uri: actor.id,
        username,
        domain,
        acct,
        displayName: decodeEntities(actor.name || username),
        summary: actor.summary ? htmlToPlainText(actor.summary) : '',
        avatarUrl: actor.icon?.url || actor.icon?.href || undefined,
        headerUrl: actor.image?.url || actor.image?.href || undefined,
        inboxUrl: actor.inbox,
        outboxUrl: actor.outbox || undefined,
        sharedInboxUrl: actor.endpoints?.sharedInbox || undefined,
        followersUrl: actor.followers || undefined,
        followingUrl: actor.following || undefined,
        publicKeyPem: actor.publicKey?.publicKeyPem || undefined,
        publicKeyId: actor.publicKey?.id || undefined,
        type: actor.type || 'Person',
        manuallyApprovesFollowers: actor.manuallyApprovesFollowers || false,
        discoverable: actor.discoverable !== false,
        memorial: actor.memorial === true,
        suspended: actor.suspended === true,
        fields,
        featuredUrl: actor.featured || undefined,
        featuredTagsUrl: actor.featuredTags || undefined,
        alsoKnownAs: Array.isArray(actor.alsoKnownAs) ? actor.alsoKnownAs : undefined,
        remoteCreatedAt: actor.published ? new Date(actor.published) : undefined,
        followersCount,
        followingCount,
        postsCount,
        lastFetchedAt: new Date(),
      };

      const fedActor = await FederatedActor.findOneAndUpdate(
        { uri: actor.id },
        { $set: update },
        { upsert: true, returnDocument: 'after', lean: true },
      );

      // Resolve to Oxy User if not already linked.
      // Also retries on stale refresh if a previous resolution failed.
      if (fedActor && !fedActor.oxyUserId) {
        try {
          const oxyClient = getServiceOxyClient();
          const oxyUser = await oxyClient.resolveExternalUser({
            type: 'federated',
            username: acct,
            actorUri: actor.id,
            domain,
            displayName: decodeEntities(actor.name || username),
            avatar: actor.icon?.url || actor.icon?.href,
            bio: actor.summary ? htmlToPlainText(actor.summary) : undefined,
          });
          if (oxyUser?.id) {
            await FederatedActor.updateOne({ _id: fedActor._id }, { $set: { oxyUserId: String(oxyUser.id) } });
          }
        } catch (resolveErr) {
          logger.warn(`Failed to resolve Oxy user for ${actorUri}:`, resolveErr);
        }
      }

      return fedActor as IFederatedActor | null;
    } catch (err) {
      logger.warn(`Failed to fetch remote actor ${actorUri}:`, err);
      return null;
    }
  }

  /**
   * Fetch the totalItems count from an ActivityPub collection URL.
   */
  private async fetchCollectionCount(url?: string): Promise<number> {
    if (!url) return 0;
    try {
      const res = await signedFetch(url, AP_CONTENT_TYPE);
      if (!res.ok) return 0;
      const col = await res.json() as Record<string, any>;
      return typeof col.totalItems === 'number' ? col.totalItems : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Fetch a remote actor's outbox and store posts in the DB.
   * Uses the same storage format as handleCreate so posts go through normal hydration.
   */
  async syncOutboxPosts(actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string }, limit = 20): Promise<number> {
    if (!actor.outboxUrl) return 0;

    try {
      // Fetch the outbox collection (signed for authorized-fetch servers)
      const res = await signedFetch(actor.outboxUrl, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] outbox fetch failed: ${res.status} ${res.statusText} for ${actor.outboxUrl}`);
        return 0;
      }

      const collection = await res.json() as Record<string, any>;
      logger.info(`[FedSync] outbox collection type=${collection.type} totalItems=${collection.totalItems} hasOrderedItems=${!!collection.orderedItems} hasFirst=${!!collection.first}`);

      // Paginate through outbox pages to collect enough top-level posts.
      // Most outbox items are replies/boosts which we skip, so we may need
      // several pages to reach the desired limit.
      const candidates: { note: any; activity: any; activityId: string }[] = [];
      const MAX_PAGES = 10;
      let nextPageUrl: string | null = null;

      if (collection.orderedItems) {
        this.extractCandidates(collection.orderedItems, candidates, limit);
      } else if (collection.first) {
        nextPageUrl = typeof collection.first === 'string' ? collection.first : collection.first.id;
      }

      // Paginate through pages until we have enough candidates or run out of pages
      for (let page = 0; page < MAX_PAGES && nextPageUrl && candidates.length < limit; page++) {
        try {
          const pageRes = await signedFetch(nextPageUrl, AP_CONTENT_TYPE);
          if (!pageRes.ok) {
            logger.info(`[FedSync] outbox page fetch failed: ${pageRes.status} for ${nextPageUrl}`);
            break;
          }
          const pageData = await pageRes.json() as Record<string, any>;
          const items = pageData.orderedItems || [];
          if (items.length === 0) break;

          this.extractCandidates(items, candidates, limit);
          nextPageUrl = pageData.next || null;
        } catch (pageErr) {
          logger.debug(`[FedSync] outbox pagination error: ${pageErr}`);
          break;
        }
      }

      logger.info(`[FedSync] collected ${candidates.length} candidates across pages for ${actor.acct}`);

      if (candidates.length === 0) {
        logger.info(`[FedSync] no candidate notes found for ${actor.acct}`);
        return 0;
      }

      // Bulk dedup: single query instead of N queries
      const allActivityIds = candidates.map(c => c.activityId);
      const existingPosts = await Post.find(
        { 'federation.activityId': { $in: allActivityIds } },
        { 'federation.activityId': 1 },
      ).lean();
      const existingIds = new Set(
        existingPosts.map(p => (p.federation as { activityId?: string } | undefined)?.activityId),
      );

      // Resolve actor URIs → Oxy User IDs
      const actorUris = new Set<string>();
      for (const { note } of candidates) {
        const uri = this.extractActorUri(note.attributedTo);
        if (uri) actorUris.add(uri);
      }

      // Batch lookup: actor URI → oxyUserId from stored FederatedActors
      const actorOxyMap = new Map<string, string>();
      // Seed with caller-provided oxyUserId for the main actor
      if (actor.oxyUserId) {
        actorOxyMap.set(actor.uri, actor.oxyUserId);
      }
      if (actorUris.size > 0) {
        const actors = await FederatedActor.find(
          { uri: { $in: [...actorUris] }, oxyUserId: { $ne: null } },
          { uri: 1, oxyUserId: 1 },
        ).lean();
        for (const a of actors) {
          if (a.oxyUserId) actorOxyMap.set(a.uri, a.oxyUserId);
        }

        // Resolve missing actors with bounded concurrency to avoid fan-out
        const missingUris = [...actorUris].filter(uri => !actorOxyMap.has(uri));
        const CONCURRENCY = 3;
        for (let i = 0; i < missingUris.length; i += CONCURRENCY) {
          const batch = missingUris.slice(i, i + CONCURRENCY);
          const resolved = await Promise.all(batch.map(uri => this.fetchRemoteActor(uri)));
          for (let j = 0; j < batch.length; j++) {
            const actor = resolved[j];
            if (actor?.oxyUserId) {
              actorOxyMap.set(batch[j], actor.oxyUserId);
            }
          }
        }
      }

      logger.info(`[FedSync] ${candidates.length} candidates, ${existingIds.size} already exist, actorOxyMap has ${actorOxyMap.size} entries`);

      // Build documents for batch insert
      const newDocs: any[] = [];
      for (const { note, activity, activityId } of candidates) {
        if (existingIds.has(activityId)) continue;

        const rawContent = note.content || '';
        if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) continue;

        const text = htmlToPlainText(rawContent);
        const { media, attachments } = this.extractApMedia(note);
        const hashtags = this.extractApHashtags(note);
        const published = note.published || activity.published;

        // Resolve author's Oxy User ID
        const actorUri = this.extractActorUri(note.attributedTo);
        const resolvedOxyUserId = actorUri ? actorOxyMap.get(actorUri) || null : null;
        if (!resolvedOxyUserId) {
          logger.info(`[FedSync] no oxyUserId resolved for actorUri=${actorUri} activityId=${activityId}`);
        }

        newDocs.push({
          oxyUserId: resolvedOxyUserId,
          federation: {
            activityId,
            inReplyTo: note.inReplyTo || undefined,
            url: note.url || note.id,
            sensitive: note.sensitive || false,
            spoilerText: note.summary || undefined,
          },
          type: media.length > 0 ? (media.some((m: any) => m.type === 'video') ? 'video' : 'image') : 'text',
          content: {
            text,
            media: media.length > 0 ? media : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
          visibility: this.mapApVisibility(note.to, note.cc),
          hashtags,
          status: 'published',
          stats: {
            likesCount: typeof note.likes === 'object' ? (note.likes?.totalItems ?? 0) : 0,
            repostsCount: typeof note.shares === 'object' ? (note.shares?.totalItems ?? 0) : 0,
            commentsCount: typeof note.replies === 'object' ? (note.replies?.totalItems ?? 0) : 0,
            viewsCount: 0,
            sharesCount: 0,
          },
          metadata: {
            isSensitive: note.sensitive === true,
          },
          ...(published ? { createdAt: new Date(published), updatedAt: new Date(published) } : {}),
        });
      }

      // Strip empty location/coordinates from content to avoid 2dsphere index errors
      for (const doc of newDocs) {
        if (doc.content?.location) {
          if (!doc.content.location.coordinates || doc.content.location.coordinates.length !== 2) {
            delete doc.content.location;
          }
        }
        if (doc.location) {
          if (!doc.location.coordinates || doc.location.coordinates.length !== 2) {
            delete doc.location;
          }
        }
      }

      // Batch insert using raw collection to bypass Mongoose schema defaults
      // (Mongoose adds empty location.coordinates which breaks 2dsphere index)
      if (newDocs.length > 0) {
        await Post.collection.insertMany(newDocs, { ordered: false }).catch((err: any) => {
          // Partial write errors (duplicate key) are expected — log but don't throw
          const writeErrors = err?.writeErrors || [];
          const unexpectedErrors = writeErrors.filter((e: any) => e.err?.code !== 11000);
          if (unexpectedErrors.length > 0) {
            logger.warn(`[FedSync] insertMany unexpected errors: ${unexpectedErrors.map((e: any) => e.err?.errmsg).join('; ')}`);
          }
          if (writeErrors.length > 0 && writeErrors.length < newDocs.length) {
            logger.debug(`[FedSync] insertMany partial: ${writeErrors.length} errors, ${newDocs.length - writeErrors.length} inserted`);
          } else if (writeErrors.length === 0) {
            throw err;
          }
        });
      }

      const synced = existingIds.size + newDocs.length;
      logger.debug(`Synced ${newDocs.length} new outbox posts for ${actor.acct} (${existingIds.size} already existed)`);
      return synced;
    } catch (err) {
      logger.warn(`Failed to sync outbox posts from ${actor.outboxUrl}:`, err);
      return 0;
    }
  }

  /**
   * Extract media attachments from an AP Note object.
   * Returns media items and attachment descriptors for the Post model.
   */
  private extractApMedia(note: Record<string, any>): { media: any[]; attachments: any[] } {
    const media: any[] = [];
    const attachments: any[] = [];

    if (!Array.isArray(note.attachment)) return { media, attachments };

    for (const att of note.attachment) {
      if (!att?.url) continue;
      const mimeType = att.mediaType || '';
      if (mimeType.startsWith('image/')) {
        media.push({ id: att.url, type: 'image' });
        attachments.push({ type: 'media', id: att.url, mediaType: 'image' });
      } else if (mimeType.startsWith('video/')) {
        media.push({ id: att.url, type: 'video' });
        attachments.push({ type: 'media', id: att.url, mediaType: 'video' });
      }
    }

    return { media, attachments };
  }

  /**
   * Extract hashtags from an AP Note's tag array.
   */
  private extractApHashtags(note: Record<string, any>): string[] {
    const hashtags: string[] = [];
    if (!Array.isArray(note.tag)) return hashtags;

    for (const tag of note.tag) {
      if (tag?.type === 'Hashtag' && tag.name) {
        hashtags.push(tag.name.replace(/^#/, ''));
      }
    }
    return hashtags;
  }

  /**
   * Get a cached actor or fetch if missing/stale (>24h).
   */
  async getOrFetchActor(actorUri: string): Promise<IFederatedActor | null> {
    const existing = await FederatedActor.findOne({ uri: actorUri }).lean<IFederatedActor>();
    if (existing) {
      const staleMs = 24 * 60 * 60 * 1000;
      const isStale = !existing.lastFetchedAt || Date.now() - existing.lastFetchedAt.getTime() > staleMs;
      if (!isStale) return existing;
    }
    return this.fetchRemoteActor(actorUri);
  }

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
      const keyPair = await getKeyPair(senderUsername);
      const body = JSON.stringify(activity);
      const sigHeaders = signRequest(keyPair.privateKeyPem, keyPair.keyId, 'POST', targetInbox, body);

      const res = await fetch(targetInbox, {
        method: 'POST',
        headers: {
          'Content-Type': AP_CONTENT_TYPE,
          'User-Agent': USER_AGENT,
          ...sigHeaders,
        },
        body,
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok || res.status === 202) return true;

      logger.debug(`Activity delivery failed to ${targetInbox}: ${res.status} ${res.statusText}`);
      return false;
    } catch (err) {
      logger.debug(`Activity delivery error to ${targetInbox}:`, err);
      return false;
    }
  }

  /**
   * Queue an activity for delivery (with retries).
   */
  async queueDelivery(
    activity: Record<string, unknown>,
    targetInbox: string,
    senderOxyUserId: string,
  ): Promise<void> {
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

    // Group by shared inbox to avoid duplicate deliveries, then batch-insert
    const seen = new Set<string>();
    const deliveries: Array<{ activityJson: Record<string, unknown>; targetInbox: string; senderOxyUserId: string; nextAttemptAt: Date }> = [];
    const now = new Date();
    for (const actor of actors) {
      const inbox = actor.sharedInboxUrl || actor.inboxUrl;
      if (!seen.has(inbox)) {
        seen.add(inbox);
        deliveries.push({ activityJson: activity, targetInbox: inbox, senderOxyUserId, nextAttemptAt: now });
      }
    }
    if (deliveries.length > 0) {
      await FederationDeliveryQueue.insertMany(deliveries, { ordered: false });
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

    const actor = await this.getOrFetchActor(remoteActorUri);
    if (!actor) return { success: false, pending: false };

    const canonicalUri = actor.uri; // Use canonical URI from fetched actor
    const localActorUri = actorUrl(localUsername);
    const activityId = `${localActorUri}/follows/${actor._id}`;

    // Create or update the follow record
    await FederatedFollow.findOneAndUpdate(
      { localUserId: localOxyUserId, remoteActorUri: canonicalUri, direction: 'outbound' },
      { $set: { status: 'pending', activityId } },
      { upsert: true, returnDocument: 'after' },
    );

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: activityId,
      type: 'Follow',
      actor: localActorUri,
      object: canonicalUri,
    };

    const delivered = await this.deliverActivity(activity, actor.inboxUrl, localOxyUserId, localUsername);
    if (!delivered) {
      await this.queueDelivery(activity, actor.inboxUrl, localOxyUserId);
    }

    return { success: true, pending: actor.manuallyApprovesFollowers };
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

    const delivered = await this.deliverActivity(activity, actor.inboxUrl, localOxyUserId, localUsername);
    if (!delivered) {
      await this.queueDelivery(activity, actor.inboxUrl, localOxyUserId);
    }

    await FederatedFollow.deleteOne({ _id: follow._id });
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

  // ============================================================
  // Inbox Processing
  // ============================================================

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

    const actor = await this.getOrFetchActor(actorUri);
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
    await this.sendAccept(localUserId, username, activity.id, actorUri);

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
      const likedObjectId = typeof object.object === 'string' ? object.object : object.object?.id;
      if (likedObjectId) {
        await Post.updateOne(
          { 'federation.activityId': likedObjectId, 'stats.likesCount': { $gt: 0 } },
          { $inc: { 'stats.likesCount': -1 } },
        );
        logger.debug(`Undo like from ${actorUri} on ${likedObjectId}`);
      }
    } else if (objectType === 'Announce') {
      const announcedId = typeof object.object === 'string' ? object.object : object.object?.id;
      if (announcedId) {
        await Post.updateOne(
          { 'federation.activityId': announcedId, 'stats.repostsCount': { $gt: 0 } },
          { $inc: { 'stats.repostsCount': -1 } },
        );
        logger.debug(`Undo announce from ${actorUri} on ${announcedId}`);
      }
    }
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

    const actor = await this.getOrFetchActor(actorUri);
    if (!actor) return;

    const hashtags = this.extractApHashtags(object);
    const { media, attachments } = this.extractApMedia(object);

    const { postCreationService } = require('./PostCreationService') as {
      postCreationService: { create: (params: import('./PostCreationService').CreatePostParams) => Promise<unknown> };
    };
    await postCreationService.create({
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
      visibility: this.mapApVisibility(object.to, object.cc),
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
    // Verify the deleting actor owns this post
    const postActorUri = this.extractActorUri((post.federation as any)?.activityId ? actorUri : undefined);
    const actorRecord = await FederatedActor.findOne({ uri: actorUri }).lean();
    if (actorRecord && post.oxyUserId && actorRecord.oxyUserId !== post.oxyUserId) {
      logger.warn(`Delete rejected: actor ${actorUri} does not own post ${objectId}`);
      return;
    }
    await Post.deleteOne({ _id: post._id });
    logger.debug(`Deleted federated post: ${objectId}`);
  }

  private async handleLike(activity: Record<string, any>, actorUri: string): Promise<void> {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return;

    // Try to find the local post being liked
    await Post.updateOne(
      { 'federation.activityId': objectId },
      { $inc: { 'stats.likesCount': 1 } },
    );
  }

  private async handleAnnounce(activity: Record<string, any>, actorUri: string): Promise<void> {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return;

    // Increment repost count on the original post
    await Post.updateOne(
      { 'federation.activityId': objectId },
      { $inc: { 'stats.repostsCount': 1 } },
    );
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
        this.syncOutboxPosts(actor, 20).catch(err =>
          logger.warn(`Failed to sync outbox after accept from ${actorUri}: ${err}`),
        );
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
      const { media, attachments } = this.extractApMedia(object);

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
      await this.fetchRemoteActor(actorUri);
      logger.debug(`Updated federated actor: ${actorUri}`);
    }
  }

  /**
   * Map ActivityPub to/cc addressing to Mention visibility.
   */
  private mapApVisibility(
    to?: string[],
    cc?: string[],
  ): PostVisibility {
    const allAddressees = [...(to || []), ...(cc || [])];
    if (allAddressees.includes('https://www.w3.org/ns/activitystreams#Public')) {
      return PostVisibility.PUBLIC;
    }
    return PostVisibility.FOLLOWERS_ONLY;
  }

  // ============================================================
  // Public Key Fetching (for HTTP signature verification)
  // ============================================================

  /**
   * Fetch a public key by keyId (used for HTTP signature verification).
   */
  async fetchPublicKey(keyId: string): Promise<{ publicKeyPem: string; actorUri: string } | null> {
    // keyId is typically the actor URI with #main-key appended
    const actorUri = keyId.replace(/#.*$/, '');

    // Check local cache first
    const cached = await FederatedActor.findOne({ publicKeyId: keyId }).lean();
    if (cached?.publicKeyPem) {
      return { publicKeyPem: cached.publicKeyPem, actorUri: cached.uri };
    }

    // Fetch the actor to get the public key (uses 24h cache)
    const actor = await this.getOrFetchActor(actorUri);
    if (!actor?.publicKeyPem) return null;

    return { publicKeyPem: actor.publicKeyPem, actorUri: actor.uri };
  }
}

export const federationService = new FederationService();
export default federationService;
