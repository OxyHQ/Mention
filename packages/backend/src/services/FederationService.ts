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
import { PostType, PostVisibility } from '@mention/shared-types';
import { htmlToPlainText } from '../utils/federation/htmlToPlainText';
import { extractApMediaFromNote, type ApMediaType } from '../utils/federation/apMedia';
import { decode as decodeEntities } from 'he';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import UserSettings from '../models/UserSettings';
import { normalizeHashtag, normalizePostHashtags } from '../utils/textProcessing';
import { recordAccessAndMaybeEnqueue } from './mediaCache/cacheStore';
import { persistRemoteMediaForFederatedOwnerDetailed } from './mediaCache/cacheWorker';

/**
 * Minimum interval between background actor refreshes for the same actor.
 * Prevents refresh storms when a profile is viewed repeatedly in a short window.
 */
const ACTOR_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Staleness threshold after which a cached actor is considered out of date and
 * eligible for a (background) re-fetch.
 */
const ACTOR_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * A candidate extracted from a remote actor's outbox during backfill.
 * Either a top-level Note/Article authored by the actor, or an Announce (boost)
 * of another actor's object.
 */
type OutboxCandidate =
  | { kind: 'note'; note: Record<string, any>; activity: Record<string, any>; activityId: string }
  | { kind: 'announce'; activity: Record<string, any>; activityId: string; announcedUri: string };

type ExtractedMediaItem = { id: string; type: ApMediaType };
type ExtractedMediaAttachment = { type: 'media'; id: string; mediaType: ApMediaType };

interface OutboxSyncResult {
  syncedCount: number;
  shouldStampCooldown: boolean;
  reason?: string;
  candidateCount?: number;
  newPostCount?: number;
  existingCount?: number;
  importedBoostCount?: number;
  pagesFetched?: number;
  reachedEnd?: boolean;
  nextCursor?: {
    url: string;
    itemOffset: number;
  };
}

interface OutboxSyncOptions {
  limit?: number;
  maxPages?: number;
  startPageUrl?: string;
  startItemOffset?: number;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function activityPubItems(value: Record<string, any>): unknown[] {
  if (Array.isArray(value.orderedItems)) return value.orderedItems;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

function activityPubLinkUrl(value: unknown): string | null {
  if (typeof value === 'string' && isAbsoluteHttpUrl(value)) return value;
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.id === 'string' && isAbsoluteHttpUrl(record.id)) return record.id;
  if (typeof record.href === 'string' && isAbsoluteHttpUrl(record.href)) return record.href;
  return null;
}

function firstStringUrl(value: unknown): string | undefined {
  if (typeof value === 'string' && isAbsoluteHttpUrl(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = firstStringUrl(item);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstStringUrl(record.url) || firstStringUrl(record.href);
  }
  return undefined;
}

function getRemoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeFederatedAcct(acct: string | undefined): string | undefined {
  if (!acct) return undefined;
  const cleaned = acct.trim().replace(/^acct:/i, '').replace(/^@/, '');
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex === cleaned.length - 1) return undefined;

  const localPart = cleaned.substring(0, atIndex).toLowerCase();
  const domain = cleaned.substring(atIndex + 1).toLowerCase();
  if (!localPart || !domain) return undefined;

  return `${localPart}@${domain}`;
}

function domainFromAcct(acct: string): string | undefined {
  const atIndex = acct.indexOf('@');
  if (atIndex === -1 || atIndex === acct.length - 1) return undefined;
  return acct.substring(atIndex + 1).toLowerCase();
}

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

  // A 401/403 on a signed request means the remote rejected OUR signature
  // (e.g. it could not resolve/verify our keyId, or our instance key pair is
  // missing/invalid because the service token could not be acquired). Without a
  // log this silently yields zero results — surface it so the failure mode is
  // observable in production. The caller still receives the response and decides
  // how to proceed; we do not change control flow here.
  if (res.status === 401 || res.status === 403) {
    logger.warn(
      `[FedSync] signedFetch got ${res.status} ${res.statusText} for ${url} — remote rejected our HTTP signature (check instance key pair / service token); returning the failed response so no posts are imported from this source`,
    );
  }

  return res;
}

class FederationService {
  /**
   * Actor URIs with an in-flight background refresh. Guards against launching
   * multiple concurrent `fetchRemoteActor` calls for the same actor (refresh
   * storms) when a profile is viewed repeatedly while the first fetch is still
   * running.
   */
  private readonly inFlightActorRefreshes = new Set<string>();

  /**
   * Extract candidate items from outbox items into the candidates array.
   *
   * Two kinds of candidates are produced:
   *  - `note`: a top-level Note/Article authored by this actor (Create/Note/Article).
   *  - `announce`: an Announce (boost/reblog) of another actor's object. The
   *    announced object is fetched and imported later in `syncOutboxPosts`, then
   *    a boost Post (mirroring native reposts) is created attributed to this actor.
   */
  private async extractCandidates(
    items: unknown[],
    candidates: OutboxCandidate[],
    limit: number,
    startIndex = 0,
  ): Promise<number> {
    for (let index = startIndex; index < items.length; index++) {
      if (candidates.length >= limit) return index;

      const activity = await this.resolveOutboxActivity(items[index]);
      if (!activity) continue;

      // Announce (boost) — capture the announced object URI for later import.
      if (activity.type === 'Announce') {
        const activityId = activity.id;
        const announcedUri = this.extractAnnouncedObjectUri(activity.object);
        if (!activityId || !announcedUri) continue;
        candidates.push({ kind: 'announce', activity, activityId, announcedUri });
        continue;
      }

      const note = await this.extractOutboxNote(activity);
      if (!note) continue;
      if (note.type !== 'Note' && note.type !== 'Article') continue;
      if (note.inReplyTo) continue;

      const activityId = note.id || activity.id;
      if (!activityId) continue;

      candidates.push({ kind: 'note', note, activity, activityId });
    }

    return items.length;
  }

  private async resolveOutboxActivity(item: unknown): Promise<Record<string, any> | null> {
    const inlineActivity = asRecord(item);
    if (inlineActivity) return inlineActivity;

    if (typeof item !== 'string' || !isAbsoluteHttpUrl(item)) return null;
    return this.fetchActivityPubObject(item);
  }

  private async extractOutboxNote(activity: Record<string, any>): Promise<Record<string, any> | null> {
    if (activity.type === 'Note' || activity.type === 'Article') return activity;
    if (activity.type !== 'Create') return null;

    const inlineObject = asRecord(activity.object);
    if (inlineObject) return inlineObject;

    if (typeof activity.object === 'string' && isAbsoluteHttpUrl(activity.object)) {
      return this.fetchActivityPubObject(activity.object);
    }

    return null;
  }

  private async fetchActivityPubObject(url: string): Promise<Record<string, any> | null> {
    try {
      const res = await signedFetch(url, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] ActivityPub object fetch failed: ${res.status} ${res.statusText} for ${url}`);
        return null;
      }
      const object = await res.json();
      return asRecord(object);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(`[FedSync] ActivityPub object fetch error for ${url}: ${message}`);
      return null;
    }
  }

  private async materializeFederatedMedia(
    media: ExtractedMediaItem[],
    attachments: ExtractedMediaAttachment[],
    ownerOxyUserId: string | null | undefined,
    context: { activityId?: string; actorUri?: string } = {},
  ): Promise<{ media: ExtractedMediaItem[]; attachments: ExtractedMediaAttachment[] }> {
    if (media.length === 0) return { media, attachments };

    const idMap = new Map<string, string>();
    const removedRemoteUrls = new Set<string>();
    const outputMedia: ExtractedMediaItem[] = [];

    for (const item of media) {
      const remoteUrl = item.id;
      if (!isAbsoluteHttpUrl(remoteUrl)) {
        outputMedia.push(item);
        continue;
      }

      if (!ownerOxyUserId) {
        void recordAccessAndMaybeEnqueue(remoteUrl);
        outputMedia.push(item);
        continue;
      }

      const persistedResult = await persistRemoteMediaForFederatedOwnerDetailed(remoteUrl, ownerOxyUserId, {
        remoteHost: getRemoteHost(remoteUrl),
        activityId: context.activityId,
        actorUri: context.actorUri,
        mediaType: item.type,
      });

      if (!persistedResult.ok) {
        if (persistedResult.permanent) {
          logger.info('[Federation] Dropping permanently unavailable remote media', {
            remoteHost: getRemoteHost(remoteUrl),
            status: persistedResult.status,
            activityId: context.activityId,
          });
          removedRemoteUrls.add(remoteUrl);
          continue;
        }
        void recordAccessAndMaybeEnqueue(remoteUrl);
        outputMedia.push(item);
        continue;
      }

      const persisted = persistedResult.media;
      idMap.set(remoteUrl, persisted.oxyFileId);
      outputMedia.push({
        ...item,
        id: persisted.oxyFileId,
        remoteUrl,
        cachedFromFederation: true,
        ...(persisted.posterFileId ? { posterFileId: persisted.posterFileId } : {}),
      } as ExtractedMediaItem);
    }

    if (idMap.size === 0 && removedRemoteUrls.size === 0) return { media: outputMedia, attachments };

    const outputAttachments = attachments
      .filter((attachment) => !removedRemoteUrls.has(attachment.id))
      .map((attachment) => ({
        ...attachment,
        id: idMap.get(attachment.id) || attachment.id,
      }));

    return { media: outputMedia, attachments: outputAttachments };
  }

  /**
   * Extract the announced object URI from an Announce activity's `object`,
   * which may be a plain URI string or an embedded object with an `id`.
   */
  private extractAnnouncedObjectUri(object: unknown): string | undefined {
    if (typeof object === 'string') return object;
    if (object && typeof object === 'object' && 'id' in object) {
      const id = (object as { id?: unknown }).id;
      return typeof id === 'string' ? id : undefined;
    }
    return undefined;
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
    const cleaned = normalizeFederatedAcct(acct);
    if (!cleaned) return null;

    const domain = domainFromAcct(cleaned);
    if (!domain) return null;
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
   *
   * @param actorUri - the remote actor URI to fetch.
   * @param forceAvatarRefresh - when true, tells Oxy's `PUT /users/resolve` to
   *   re-download and replace the federated avatar even if it already has a
   *   stored file ID. Pass `true` from refresh paths (scheduled job, viewed
   *   profile refresh) and `false` for first-time creation.
   */
  async fetchRemoteActor(actorUri: string, forceAvatarRefresh = false, acctHint?: string): Promise<IFederatedActor | null> {
    try {
      const canonicalAcctHint = normalizeFederatedAcct(acctHint);
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
        const acct = canonicalAcctHint
          || (pathUsername ? normalizeFederatedAcct(`${pathUsername}@${parsed.hostname}`) : undefined);
        if (acct) {
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

      const actorHost = new URL(actor.id).hostname.toLowerCase();
      const username = actor.preferredUsername || actor.name || 'unknown';
      const actorWebfinger = typeof actor.webfinger === 'string'
        ? normalizeFederatedAcct(actor.webfinger)
        : undefined;
      const acct = canonicalAcctHint
        || actorWebfinger
        || normalizeFederatedAcct(`${username}@${actorHost}`)
        || `${String(username).toLowerCase()}@${actorHost}`;
      const domain = domainFromAcct(acct) || actorHost;
      if (isBlockedDomain(domain) || isBlockedDomain(actorHost)) {
        logger.info(`[FedSync] fetchRemoteActor blocked domain ${domain} actorHost=${actorHost} for ${actorUri}`);
        return null;
      }

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

      const avatarUrl = firstStringUrl(actor.icon);
      const headerUrl = firstStringUrl(actor.image);

      const update: Partial<IFederatedActor> = {
        uri: actor.id,
        username,
        domain,
        acct,
        displayName: decodeEntities(actor.name || username),
        summary: actor.summary ? htmlToPlainText(actor.summary) : '',
        avatarUrl,
        headerUrl,
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

      // Always upsert into Oxy so profile changes (avatar, name, bio) are synced.
      // resolveExternalUser creates the user if not exists, updates if changed.
      // Uses makeServiceRequest because PUT /users/resolve requires a service token.
      if (fedActor) {
        try {
          const oxyClient = getServiceOxyClient();
          const oxyUser: { _id?: string; id?: string } | null = await oxyClient.makeServiceRequest('PUT', '/users/resolve', {
            type: 'federated',
            username: acct,
            actorUri: actor.id,
            domain,
            displayName: decodeEntities(actor.name || username),
            avatar: avatarUrl,
            bio: actor.summary ? htmlToPlainText(actor.summary) : undefined,
            // On refresh, tell Oxy to re-download and replace the avatar even if
            // it already stored a file ID. Coordinated with oxy-api's
            // `refresh` / `forceAvatarRefresh` flag on PUT /users/resolve.
            refresh: forceAvatarRefresh,
            forceAvatarRefresh,
          });
          const oxyId = String(oxyUser?._id || oxyUser?.id || '');
          if (oxyId && fedActor.oxyUserId !== oxyId) {
            await FederatedActor.updateOne({ _id: fedActor._id }, { $set: { oxyUserId: oxyId } });
          }
          // Download and upload remote banner to Oxy (same pattern as avatar)
          if (oxyId && headerUrl) {
            try {
              const imgRes = await fetch(headerUrl);
              if (imgRes.ok) {
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
                const buffer = await imgRes.arrayBuffer();
                const blob = new Blob([buffer], { type: contentType });
                const asset = await oxyClient.uploadProfileBanner(blob as any, oxyId);
                const fileId = asset?.file?.id;
                if (fileId) {
                  await UserSettings.updateOne(
                    { oxyUserId: oxyId },
                    { $set: { profileHeaderImage: fileId } },
                    { upsert: true },
                  );
                }
              }
            } catch (bannerErr) {
              logger.debug(`Failed to sync banner for ${actorUri}:`, bannerErr);
            }
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
    const result = await this.syncOutboxPostsDetailed(actor, limit);
    return result.syncedCount;
  }

  async syncOutboxPostsDetailed(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string },
    limitOrOptions: number | OutboxSyncOptions = 20,
  ): Promise<OutboxSyncResult> {
    if (!actor.outboxUrl) {
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'missing-outbox' };
    }

    const options: Required<Pick<OutboxSyncOptions, 'limit' | 'maxPages' | 'startItemOffset'>>
      & Pick<OutboxSyncOptions, 'startPageUrl'> = typeof limitOrOptions === 'number'
        ? { limit: limitOrOptions, maxPages: 10, startItemOffset: 0 }
        : {
            limit: limitOrOptions.limit ?? 20,
            maxPages: limitOrOptions.maxPages ?? 10,
            startPageUrl: limitOrOptions.startPageUrl,
            startItemOffset: limitOrOptions.startItemOffset ?? 0,
          };
    const limit = Math.max(1, options.limit);
    const maxPages = Math.max(1, options.maxPages);

    try {
      // Fetch the outbox collection (signed for authorized-fetch servers)
      const res = await signedFetch(actor.outboxUrl, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] outbox fetch failed: ${res.status} ${res.statusText} for ${actor.outboxUrl}`);
        return { syncedCount: 0, shouldStampCooldown: false, reason: `outbox-http-${res.status}` };
      }

      const collection = await res.json() as Record<string, any>;
      logger.info(`[FedSync] outbox collection type=${collection.type} totalItems=${collection.totalItems} hasOrderedItems=${!!collection.orderedItems} hasFirst=${!!collection.first}`);
      const remoteTotalItems = typeof collection.totalItems === 'number' ? collection.totalItems : undefined;

      const candidates: OutboxCandidate[] = [];
      let pagesFetched = 0;
      let nextCursor: OutboxSyncResult['nextCursor'];
      let reachedEnd = false;
      let paginationFailed = false;
      const visitedPageUrls = new Set<string>();

      const processPage = async (
        pageData: Record<string, any>,
        pageUrl: string,
        startItemOffset: number,
      ): Promise<void> => {
        const items = activityPubItems(pageData);
        const normalizedOffset = Math.max(0, Math.min(startItemOffset, items.length));
        if (items.length > 0) {
          const nextItemOffset = await this.extractCandidates(items, candidates, limit, normalizedOffset);
          if (nextItemOffset < items.length) {
            nextCursor = { url: pageUrl, itemOffset: nextItemOffset };
            return;
          }
        }

        const nextPageUrl = activityPubLinkUrl(pageData.next);
        if (nextPageUrl) {
          nextCursor = { url: nextPageUrl, itemOffset: 0 };
        } else {
          nextCursor = undefined;
          reachedEnd = true;
        }
      };

      const fetchAndProcessPage = async (pageUrl: string, startItemOffset: number): Promise<void> => {
        if (visitedPageUrls.has(pageUrl)) {
          logger.info(`[FedSync] outbox pagination loop detected for ${actor.acct} at ${pageUrl}`);
          paginationFailed = true;
          nextCursor = undefined;
          return;
        }
        visitedPageUrls.add(pageUrl);

        if (pagesFetched >= maxPages) {
          nextCursor = { url: pageUrl, itemOffset: startItemOffset };
          return;
        }

        try {
          const pageRes = await signedFetch(pageUrl, AP_CONTENT_TYPE);
          if (!pageRes.ok) {
            logger.info(`[FedSync] outbox page fetch failed: ${pageRes.status} for ${pageUrl}`);
            paginationFailed = true;
            nextCursor = undefined;
            return;
          }

          pagesFetched++;
          const pageData = await pageRes.json() as Record<string, any>;
          await processPage(pageData, pageUrl, startItemOffset);
        } catch (pageErr) {
          logger.debug(`[FedSync] outbox pagination error: ${pageErr}`);
          paginationFailed = true;
          nextCursor = undefined;
        }
      };

      const firstPageObject = asRecord(collection.first);
      const inlineItems = activityPubItems(collection);
      if (options.startPageUrl) {
        nextCursor = { url: options.startPageUrl, itemOffset: Math.max(0, options.startItemOffset) };
      } else if (inlineItems.length > 0) {
        await processPage(collection, actor.outboxUrl, 0);
      } else if (firstPageObject && activityPubItems(firstPageObject).length > 0) {
        await processPage(firstPageObject, activityPubLinkUrl(firstPageObject.id) ?? actor.outboxUrl, 0);
      } else {
        const firstPageUrl = activityPubLinkUrl(collection.first) ?? activityPubLinkUrl(collection.next);
        if (firstPageUrl) {
          nextCursor = { url: firstPageUrl, itemOffset: 0 };
        }
      }

      // Paginate through pages until we have enough candidates, run out of pages,
      // or exhaust the per-run page budget. The returned cursor is opaque remote
      // state: we persist it exactly and never synthesize pagination URLs.
      while (
        nextCursor
        && candidates.length < limit
        && !reachedEnd
        && !paginationFailed
      ) {
        const cursor = nextCursor;
        await fetchAndProcessPage(cursor.url, cursor.itemOffset);
        if (nextCursor?.url === cursor.url && nextCursor.itemOffset === cursor.itemOffset) {
          // The page budget was reached before this cursor could be processed.
          break;
        }
      }

      logger.info(`[FedSync] collected ${candidates.length} candidates across ${pagesFetched} fetched pages for ${actor.acct}`);

      if (candidates.length === 0) {
        logger.info(`[FedSync] no candidate notes found for ${actor.acct}`);
        const hasInlineItems = inlineItems.length > 0;
        const hasFirstPage = Boolean(collection.first || collection.next);
        const nonEmptyButNotInspectable = !options.startPageUrl
          && !hasInlineItems
          && !hasFirstPage
          && typeof remoteTotalItems === 'number'
          && remoteTotalItems > 0;
        return {
          syncedCount: 0,
          shouldStampCooldown: !paginationFailed,
          reason: nonEmptyButNotInspectable ? 'non-empty-outbox-without-items' : 'no-candidates',
          candidateCount: 0,
          newPostCount: 0,
          existingCount: 0,
          importedBoostCount: 0,
          pagesFetched,
          reachedEnd,
          nextCursor,
        };
      }

      const noteCandidates = candidates.filter(
        (c): c is Extract<OutboxCandidate, { kind: 'note' }> => c.kind === 'note',
      );
      const announceCandidates = candidates.filter(
        (c): c is Extract<OutboxCandidate, { kind: 'announce' }> => c.kind === 'announce',
      );

      // Bulk dedup: single query instead of N queries
      const allActivityIds = candidates.map(c => c.activityId);
      const existingPosts = await Post.find(
        { 'federation.activityId': { $in: allActivityIds } },
        { 'federation.activityId': 1 },
      ).lean();
      const existingIds = new Set(
        existingPosts.map(p => (p.federation as { activityId?: string } | undefined)?.activityId),
      );

      // Resolve actor URIs → Oxy User IDs (note authors only; announce authors
      // are always the outbox owner, resolved via actor.oxyUserId below).
      const actorUris = new Set<string>();
      for (const { note } of noteCandidates) {
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

      logger.info(`[FedSync] ${candidates.length} candidates (${noteCandidates.length} notes, ${announceCandidates.length} announces), ${existingIds.size} already exist, actorOxyMap has ${actorOxyMap.size} entries`);

      // Build documents for batch insert
      const newDocs: any[] = [];
      for (const { note, activity, activityId } of noteCandidates) {
        if (existingIds.has(activityId)) continue;

        const rawContent = note.content || '';
        if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) continue;

        const rawText = htmlToPlainText(rawContent);
        const extracted = this.extractApMedia(note);
        // The raw collection insertMany below bypasses Mongoose middleware, so
        // run the centralized normalizer explicitly: clean spammy hashtag blocks
        // from the visible text and merge inline tags with the AP `tag` array
        // tags (passed as userProvided so non-inline federated tags survive).
        const { content: text, hashtags } = normalizePostHashtags(rawText, this.extractApHashtags(note));
        const published = note.published || activity.published;

        // Resolve author's Oxy User ID
        const actorUri = this.extractActorUri(note.attributedTo);
        const resolvedOxyUserId = actorUri ? actorOxyMap.get(actorUri) || null : null;
        if (!resolvedOxyUserId) {
          logger.info(`[FedSync] no oxyUserId resolved for actorUri=${actorUri} activityId=${activityId}`);
        }
        const { media, attachments } = await this.materializeFederatedMedia(
          extracted.media,
          extracted.attachments,
          resolvedOxyUserId,
          { activityId, actorUri: actorUri ?? undefined },
        );

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
            boostsCount: typeof note.shares === 'object' ? (note.shares?.totalItems ?? 0) : 0,
            commentsCount: typeof note.replies === 'object' ? (note.replies?.totalItems ?? 0) : 0,
            viewsCount: 0,
            sharesCount: 0,
          },
          metadata: {
            isSensitive: note.sensitive === true,
          },
          // The raw collection insertMany bypasses Mongoose schema defaults, so
          // seed the classification subdoc explicitly. Federated/imported posts
          // must default to `pending` so the classification batch job picks them
          // up exactly like locally created posts.
          postClassification: { status: 'pending', attempts: 0 },
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

      // Import boosts (Announce) attributed to the outbox owner. Each announce
      // ensures the boosted Note exists locally, then creates a boost Post that
      // mirrors native reposts (type=boost, boostOf=<local note _id>). Processed
      // sequentially with the booster's resolved oxyUserId; deduped by the
      // Announce activity id.
      const boosterOxyUserId = actor.oxyUserId ?? actorOxyMap.get(actor.uri) ?? null;
      let importedBoosts = 0;
      for (const announce of announceCandidates) {
        if (existingIds.has(announce.activityId)) continue;
        const created = await this.importAnnounce(
          announce.activity,
          announce.announcedUri,
          boosterOxyUserId,
        );
        if (created) importedBoosts++;
      }

      const synced = existingIds.size + newDocs.length + importedBoosts;
      logger.debug(`Synced ${newDocs.length} new outbox posts and ${importedBoosts} boosts for ${actor.acct} (${existingIds.size} already existed)`);
      return {
        syncedCount: synced,
        shouldStampCooldown: !paginationFailed,
        reason: paginationFailed ? 'pagination-failed' : undefined,
        candidateCount: candidates.length,
        newPostCount: newDocs.length,
        existingCount: existingIds.size,
        importedBoostCount: importedBoosts,
        pagesFetched,
        reachedEnd,
        nextCursor,
      };
    } catch (err) {
      logger.warn(`Failed to sync outbox posts from ${actor.outboxUrl}:`, err);
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'exception' };
    }
  }

  /**
   * Import a boost (Announce). Ensures the announced Note exists locally as a
   * Post, then creates a boost Post attributed to the booster — mirroring the
   * native repost shape (`type: 'boost'`, `boostOf: <local note _id>`,
   * `oxyUserId: <booster>`). Idempotent: deduped by the Announce activity id via
   * the `federation.activityId` unique sparse index.
   *
   * @param announceActivity the full Announce activity (for `published`).
   * @param announcedUri the URI of the announced (boosted) object.
   * @param boosterOxyUserId the booster's resolved Oxy user id, or null.
   * @returns true when a new boost Post was created.
   */
  private async importAnnounce(
    announceActivity: Record<string, any>,
    announcedUri: string,
    boosterOxyUserId: string | null,
  ): Promise<boolean> {
    const announceId = typeof announceActivity.id === 'string' ? announceActivity.id : undefined;
    if (!announceId) return false;

    // Dedup the boost itself by the Announce activity id.
    const existingBoost = await Post.exists({ 'federation.activityId': announceId });
    if (existingBoost) return false;

    // Ensure the boosted Note exists locally and get its local Post _id.
    const originalPostId = await this.ensureFederatedNote(announcedUri);
    if (!originalPostId) {
      logger.info(`[FedSync] could not resolve boosted object ${announcedUri} for announce ${announceId}; skipping boost`);
      return false;
    }

    const published = typeof announceActivity.published === 'string' ? announceActivity.published : undefined;

    const { postCreationService } = require('./PostCreationService') as {
      postCreationService: { create: (params: import('./PostCreationService').CreatePostParams) => Promise<unknown> };
    };

    try {
      await postCreationService.create({
        oxyUserId: boosterOxyUserId,
        boostOf: originalPostId,
        // A boost carries no content of its own — mirror native reposts which
        // store an empty content body and rely on `boostOf` for hydration.
        content: { text: '' },
        visibility: PostVisibility.PUBLIC,
        federation: {
          activityId: announceId,
          url: typeof announceActivity.url === 'string' ? announceActivity.url : announceId,
        },
        status: 'published',
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        ...(published ? { createdAt: new Date(published), updatedAt: new Date(published) } : {}),
      });
      return true;
    } catch (err) {
      // A duplicate-key error means a concurrent import already created the
      // boost — treat as already-imported, not a failure.
      if (this.isDuplicateKeyError(err)) return false;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedSync] failed to create boost for announce ${announceId}: ${message}`);
      return false;
    }
  }

  /**
   * Ensure a federated Note/Article exists locally as a Post and return its
   * local Post `_id` (as a string). Fetches the object via `signedFetch` when it
   * is not already stored. Returns null when the object cannot be fetched or is
   * not a Note/Article.
   *
   * Used by boost import so a boost's `boostOf` always references a real local
   * Post `_id`, exactly like native reposts (which the hydration layer resolves
   * by looking the original post up by `_id`).
   */
  private async ensureFederatedNote(objectUri: string): Promise<string | null> {
    // Already stored?
    const existing = await Post.findOne(
      { 'federation.activityId': objectUri },
      { _id: 1 },
    ).lean();
    if (existing) return String(existing._id);

    // Fetch the announced object (the boosted Note) from its origin.
    let note: Record<string, any>;
    try {
      const res = await signedFetch(objectUri, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] failed to fetch boosted object ${objectUri}: ${res.status} ${res.statusText}`);
        return null;
      }
      note = await res.json() as Record<string, any>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(`[FedSync] error fetching boosted object ${objectUri}: ${message}`);
      return null;
    }

    if (!note || (note.type !== 'Note' && note.type !== 'Article')) {
      logger.info(`[FedSync] boosted object ${objectUri} is not a Note/Article (type=${note?.type}); skipping`);
      return null;
    }

    const rawContent = typeof note.content === 'string' ? note.content : '';
    if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) {
      logger.info(`[FedSync] boosted object ${objectUri} exceeds max content length; skipping`);
      return null;
    }

    // Resolve the original author's actor → Oxy user id so the boosted post is
    // attributed correctly (same resolution path as handleCreate/syncOutbox).
    const authorUri = this.extractActorUri(note.attributedTo);
    let authorOxyUserId: string | null = null;
    if (authorUri) {
      const authorActor = await this.getOrFetchActor(authorUri);
      authorOxyUserId = authorActor?.oxyUserId ?? null;
    }

    const text = htmlToPlainText(rawContent);
    const extracted = this.extractApMedia(note);
    const hashtags = this.extractApHashtags(note);
    const published = typeof note.published === 'string' ? note.published : undefined;
    const noteActivityId = typeof note.id === 'string' ? note.id : objectUri;
    const { media, attachments } = await this.materializeFederatedMedia(
      extracted.media,
      extracted.attachments,
      authorOxyUserId,
      { activityId: noteActivityId, actorUri: authorUri ?? undefined },
    );

    const { postCreationService } = require('./PostCreationService') as {
      postCreationService: { create: (params: import('./PostCreationService').CreatePostParams) => Promise<{ _id: unknown }> };
    };

    try {
      const created = await postCreationService.create({
        oxyUserId: authorOxyUserId,
        federation: {
          activityId: noteActivityId,
          inReplyTo: typeof note.inReplyTo === 'string' ? note.inReplyTo : undefined,
          url: typeof note.url === 'string' ? note.url : noteActivityId,
          sensitive: note.sensitive === true,
          spoilerText: typeof note.summary === 'string' ? note.summary : undefined,
        },
        content: {
          text,
          media: media.length > 0 ? media : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        visibility: this.mapApVisibility(note.to, note.cc),
        hashtags,
        status: 'published',
        metadata: { isSensitive: note.sensitive === true },
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        ...(published ? { createdAt: new Date(published), updatedAt: new Date(published) } : {}),
      });
      return String(created._id);
    } catch (err) {
      // Concurrent import may have created it — re-read to return the id.
      if (this.isDuplicateKeyError(err)) {
        const raced = await Post.findOne(
          { 'federation.activityId': noteActivityId },
          { _id: 1 },
        ).lean();
        return raced ? String(raced._id) : null;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedSync] failed to store boosted note ${objectUri}: ${message}`);
      return null;
    }
  }

  /**
   * Whether an error is a MongoDB duplicate-key error (code 11000), including
   * Mongoose `MongoServerError` and bulk write error shapes.
   */
  private isDuplicateKeyError(err: unknown): boolean {
    if (err && typeof err === 'object' && 'code' in err) {
      return (err as { code?: unknown }).code === 11000;
    }
    return false;
  }

  /**
   * Extract media attachments from an AP Note object.
   * Returns media items and attachment descriptors for the Post model.
   *
   * Delegates to `extractApMediaFromNote`, which normalizes the many fediverse
   * attachment shapes (Mastodon string `url`, Pleroma `Link` object, PeerTube/Lemmy
   * array of `Link` objects) and picks the most broadly-playable video variant.
   */
  private extractApMedia(note: Record<string, any>): {
    media: Array<{ id: string; type: ApMediaType }>;
    attachments: Array<{ type: 'media'; id: string; mediaType: ApMediaType }>;
  } {
    return extractApMediaFromNote(note);
  }

  /**
   * Extract hashtags from an AP Note's tag array.
   *
   * Tags are stored canonically lowercased (and trimmed) so federated content
   * matches the case-insensitive read paths used by the hashtag screen, MTN
   * `HashtagFeed`, and the trending aggregations. Entries that are empty after
   * stripping the leading `#` are skipped.
   */
  private extractApHashtags(note: Record<string, any>): string[] {
    const hashtags: string[] = [];
    if (!Array.isArray(note.tag)) return hashtags;

    for (const tag of note.tag) {
      if (tag?.type === 'Hashtag' && tag.name) {
        const normalized = normalizeHashtag(tag.name);
        if (normalized.length > 0) {
          hashtags.push(normalized);
        }
      }
    }
    return hashtags;
  }

  /**
   * Get a cached actor or fetch if missing/stale (>24h).
   *
   * Never blocks on remote network I/O when a cached actor already exists: a
   * stale cached actor is returned immediately and a background refresh is
   * enqueued. Only a completely missing actor triggers a blocking fetch (the
   * caller has nothing else to return).
   */
  async getOrFetchActor(actorUri: string): Promise<IFederatedActor | null> {
    const existing = await FederatedActor.findOne({ uri: actorUri }).lean<IFederatedActor>();
    if (existing) {
      const isStale = !existing.lastFetchedAt || Date.now() - existing.lastFetchedAt.getTime() > ACTOR_STALE_MS;
      if (isStale) {
        // Refresh in the background — never block the caller on remote I/O.
        this.refreshActorInBackground(actorUri, existing);
      }
      return existing;
    }
    return this.fetchRemoteActor(actorUri);
  }

  /**
   * Enqueue a fire-and-forget full-actor refresh. Safe to call on a client
   * request path: it returns synchronously and the fetch runs detached.
   *
   * Guards against refresh storms:
   *  - an in-flight refresh for the same URI short-circuits;
   *  - a recently-fetched actor (within ACTOR_REFRESH_MIN_INTERVAL_MS) is
   *    skipped unless it is missing essential profile fields.
   *
   * The avatar refresh is forced only when refreshing an actor that already
   * exists (so Oxy re-downloads/replaces it); first-time creation does not
   * force, matching the upstream guard.
   */
  refreshActorInBackground(actorUri: string, existing?: IFederatedActor): void {
    if (!FEDERATION_ENABLED) return;
    if (this.inFlightActorRefreshes.has(actorUri)) return;

    const missingProfile = !existing
      || !existing.avatarUrl
      || !existing.headerUrl
      || !existing.displayName;
    const lastFetchedMs = existing?.lastFetchedAt?.getTime();
    const refreshedRecently = typeof lastFetchedMs === 'number'
      && Date.now() - lastFetchedMs < ACTOR_REFRESH_MIN_INTERVAL_MS;

    // Skip if we refreshed recently AND the cached profile is already complete.
    if (refreshedRecently && !missingProfile) return;

    // Force avatar re-download only when the actor already exists (refresh),
    // not on first-time creation.
    const forceAvatarRefresh = Boolean(existing);

    this.inFlightActorRefreshes.add(actorUri);
    void (async () => {
      try {
        await this.fetchRemoteActor(actorUri, forceAvatarRefresh, existing?.acct);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[FedSync] background actor refresh failed for ${actorUri}: ${message}`);
      } finally {
        this.inFlightActorRefreshes.delete(actorUri);
      }
    })();
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

      const allHeaders: Record<string, string> = {
        'Content-Type': AP_CONTENT_TYPE,
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        'User-Agent': USER_AGENT,
        Accept: AP_CONTENT_TYPE,
        ...sigHeaders,
      };

      logger.debug(`[FedDeliver] POST ${targetInbox} body=${body} sig-headers=${sigHeaders['Signature']?.match(/headers="([^"]+)"/)?.[1]}`);

      const res = await fetch(targetInbox, {
        method: 'POST',
        headers: allHeaders,
        body,
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok || res.status === 202) return true;

      const responseBody = await res.text().catch(() => '');
      logger.debug(`Activity delivery failed to ${targetInbox}: ${res.status} ${res.statusText} body=${responseBody.slice(0, 500)}`);
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

    // Never block the follow request on a remote actor fetch. Use whatever is
    // cached; if the actor is unknown locally we still record the follow and
    // queue the Follow activity, then refresh the actor in the background.
    const cached = await FederatedActor.findOne({ uri: remoteActorUri }).lean<IFederatedActor>();

    // Always refresh the actor in the background so its inbox/profile stay
    // current (and so a missing actor gets resolved for delivery shortly).
    this.refreshActorInBackground(remoteActorUri, cached ?? undefined);

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
          actor = await this.fetchRemoteActor(remoteActorUri) as IFederatedActor | null;
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
          { 'federation.activityId': announcedId, 'stats.boostsCount': { $gt: 0 } },
          { $inc: { 'stats.boostsCount': -1 } },
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
    const extracted = this.extractApMedia(object);
    const { media, attachments } = await this.materializeFederatedMedia(
      extracted.media,
      extracted.attachments,
      actor.oxyUserId,
      { activityId: object.id, actorUri },
    );

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
    // Verify the deleting actor owns this post via Oxy user ID
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
    const announcedUri = this.extractAnnouncedObjectUri(activity.object);
    if (!announcedUri) return;

    // Increment the boost count on the original post when we already know it
    // locally (keeps engagement metrics accurate regardless of follow state).
    await Post.updateOne(
      { 'federation.activityId': announcedUri },
      { $inc: { 'stats.boostsCount': 1 } },
    );

    // Only import the boost into local feeds when the booster is followed by at
    // least one local user — mirrors the follow gate in handleCreate so we don't
    // ingest arbitrary remote content. Pushed boosts from followed actors should
    // appear in their followers' feeds exactly like native reposts.
    const hasFollower = await FederatedFollow.exists({
      remoteActorUri: actorUri,
      direction: 'outbound',
      status: 'accepted',
    });
    if (!hasFollower) return;

    // Resolve the booster's Oxy user id, then import the boost (ensures the
    // boosted Note exists locally and creates a native-shaped boost Post).
    const boosterActor = await this.getOrFetchActor(actorUri);
    const boosterOxyUserId = boosterActor?.oxyUserId ?? null;

    const created = await this.importAnnounce(activity, announcedUri, boosterOxyUserId);
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
        this.syncOutboxPosts(actor, 20).catch(err => {
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
      const ownerOxyUserId = existingPost?.oxyUserId ?? (await this.getOrFetchActor(actorUri))?.oxyUserId ?? null;
      const extracted = this.extractApMedia(object);
      const { media, attachments } = await this.materializeFederatedMedia(
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
