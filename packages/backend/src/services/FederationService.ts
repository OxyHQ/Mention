import { logger } from '../utils/logger';
import sanitizeHtml from 'sanitize-html';
import FederatedActor, { IFederatedActor } from '../models/FederatedActor';
import FederatedFollow from '../models/FederatedFollow';
import FederationDeliveryQueue, { getNextRetryTime } from '../models/FederationDeliveryQueue';
import { Post } from '../models/Post';
import { signRequest, getOrCreateKeyPair } from '../utils/federation/crypto';
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
} from '../utils/federation/constants';
import { PostVisibility } from '@mention/shared-types';
import { htmlToPlainText } from '../utils/federation/htmlToPlainText';

class FederationService {
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
      const res = await fetch(actorUri, {
        headers: {
          Accept: AP_CONTENT_TYPE,
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;

      const actor = await res.json() as Record<string, any>;
      if (!actor.id || !actor.inbox) return null;

      const domain = new URL(actor.id).hostname;
      if (isBlockedDomain(domain)) return null;

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
        displayName: actor.name || username,
        summary: actor.summary || '',
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
        { upsert: true, new: true },
      ).lean();

      return fedActor as unknown as IFederatedActor | null;
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
      const res = await fetch(url, {
        headers: { Accept: AP_CONTENT_TYPE, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(5000),
      });
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
  async syncOutboxPosts(actor: IFederatedActor, limit = 20): Promise<number> {
    if (!actor.outboxUrl) return 0;

    try {
      // Fetch the outbox collection
      const res = await fetch(actor.outboxUrl, {
        headers: { Accept: AP_CONTENT_TYPE, 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return 0;

      const collection = await res.json() as Record<string, any>;

      // Get the first page of items
      let items: any[] = [];
      if (collection.orderedItems) {
        items = collection.orderedItems;
      } else if (collection.first) {
        const firstUrl = typeof collection.first === 'string' ? collection.first : collection.first.id;
        if (firstUrl) {
          const pageRes = await fetch(firstUrl, {
            headers: { Accept: AP_CONTENT_TYPE, 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(10000),
          });
          if (pageRes.ok) {
            const page = await pageRes.json() as Record<string, any>;
            items = page.orderedItems || [];
          }
        }
      }

      // Parse all candidate notes and collect activity IDs for bulk dedup
      const candidates: { note: any; activity: any; activityId: string }[] = [];
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

      if (candidates.length === 0) return 0;

      // Bulk dedup: single query instead of N queries
      const allActivityIds = candidates.map(c => c.activityId);
      const existingPosts = await Post.find(
        { 'federation.activityId': { $in: allActivityIds } },
        { 'federation.activityId': 1 },
      ).lean();
      const existingIds = new Set(existingPosts.map(p => (p as any).federation?.activityId));

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

        newDocs.push({
          oxyUserId: null,
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

      // Batch insert (ordered: false to continue on duplicate key errors)
      if (newDocs.length > 0) {
        await Post.insertMany(newDocs, { ordered: false }).catch((err: any) => {
          // E11000 duplicate key errors are expected from race conditions — ignore them
          if (err?.code !== 11000 && !err?.writeErrors?.every((e: any) => e.err?.code === 11000)) {
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
   * Returns proxied media items and attachment descriptors for the Post model.
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

  /**
   * Look up an actor by acct handle (e.g. @alice@mastodon.social).
   * Checks local cache first, then resolves via WebFinger.
   */
  async lookupActor(acct: string): Promise<IFederatedActor | null> {
    const cleaned = acct.replace(/^@/, '');
    const existing = await FederatedActor.findOne({ acct: cleaned }).lean<IFederatedActor>();
    if (existing) {
      const staleMs = 24 * 60 * 60 * 1000;
      if (existing.lastFetchedAt && Date.now() - existing.lastFetchedAt.getTime() < staleMs) {
        return existing;
      }
    }

    const actorUri = await this.resolveWebFinger(cleaned);
    if (!actorUri) return null;
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
      const keyPair = await getOrCreateKeyPair(senderOxyUserId, senderUsername);
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

    // Group by shared inbox to avoid duplicate deliveries
    const inboxes = new Map<string, boolean>();
    for (const actor of actors) {
      const inbox = actor.sharedInboxUrl || actor.inboxUrl;
      if (!inboxes.has(inbox)) {
        inboxes.set(inbox, true);
        // Queue for reliable delivery
        await this.queueDelivery(activity, inbox, senderOxyUserId);
      }
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

    const localActorUri = actorUrl(localUsername);
    const activityId = `${localActorUri}/follows/${actor._id}`;

    // Create or update the follow record
    await FederatedFollow.findOneAndUpdate(
      { localUserId: localOxyUserId, remoteActorUri, direction: 'outbound' },
      { $set: { status: 'pending', activityId } },
      { upsert: true, new: true },
    );

    const activity: Record<string, unknown> = {
      '@context': AP_CONTEXT,
      id: activityId,
      type: 'Follow',
      actor: localActorUri,
      object: remoteActorUri,
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

    // We need to resolve the Oxy user from the username
    // This will be handled by the route that has access to OxyServices
    // Store the follow as pending — the controller will resolve the user and accept
    const actor = await this.getOrFetchActor(actorUri);
    if (!actor) return;

    // Store follow record (will be completed by the controller)
    await FederatedFollow.findOneAndUpdate(
      { remoteActorUri: actorUri, direction: 'inbound' },
      {
        $set: {
          localUserId: username, // Temporarily store username; controller resolves to oxyUserId
          status: 'accepted',
          activityId: activity.id,
        },
      },
      { upsert: true, new: true },
    );

    logger.info(`Accepted follow from ${actorUri} to ${username}`);
  }

  private async handleUndo(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    const objectType = typeof object === 'string' ? null : object.type;
    if (objectType === 'Follow') {
      await FederatedFollow.deleteOne({
        remoteActorUri: actorUri,
        direction: 'inbound',
      });
      logger.debug(`Undo follow from ${actorUri}`);
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

    const result = await Post.deleteOne({
      'federation.activityId': objectId,
      federation: { $ne: null },
    });
    if (result.deletedCount > 0) {
      logger.debug(`Deleted federated post: ${objectId}`);
    }
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

    const objectType = typeof object === 'string' ? null : object.type;
    if (objectType === 'Follow') {
      await FederatedFollow.updateOne(
        { remoteActorUri: actorUri, direction: 'outbound', status: 'pending' },
        { $set: { status: 'accepted' } },
      );
      logger.debug(`Follow accepted by ${actorUri}`);
    }
  }

  private async handleReject(activity: Record<string, any>, actorUri: string): Promise<void> {
    const object = activity.object;
    if (!object) return;

    const objectType = typeof object === 'string' ? null : object.type;
    if (objectType === 'Follow') {
      await FederatedFollow.updateOne(
        { remoteActorUri: actorUri, direction: 'outbound', status: 'pending' },
        { $set: { status: 'rejected' } },
      );
      logger.debug(`Follow rejected by ${actorUri}`);
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
