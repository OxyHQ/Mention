import type { IncomingMessage } from 'node:http';
import { logger } from '../../utils/logger';
import sanitizeHtml from 'sanitize-html';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import {
  FEDERATION_ENABLED,
  AP_CONTENT_TYPE,
  AP_ACCEPT_TYPES,
  isBlockedDomain,
} from '../../utils/federation/constants';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { decode as decodeEntities } from 'he';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { contentTypeFamily, fetchUpstreamFollowingRedirects, fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { isAllowedMediaType } from '../mediaCache/mediaTypes';
import UserSettings from '../../models/UserSettings';
import {
  signedFetch,
  firstStringUrl,
  normalizeFederatedAcct,
  domainFromAcct,
} from './sharedFederationHelpers';

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

const WEBFINGER_TIMEOUT_MS = 10000;
const WEBFINGER_MAX_BYTES = 256 * 1024;

function acctMatchesActorHost(acct: string | undefined, actorHost: string): acct is string {
  if (!acct) return false;
  const domain = domainFromAcct(acct)?.toLowerCase();
  if (!domain) return false;
  const normalizedActorHost = actorHost.toLowerCase();
  return domain === normalizedActorHost || normalizedActorHost === `www.${domain}`;
}

/** Maximum bytes accepted for a remote federated actor banner image. */
const ACTOR_BANNER_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

async function readBoundedResponseBody(response: IncomingMessage, maxBytes: number): Promise<ArrayBuffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        response.destroy(new Error('remote banner exceeds size limit'));
        throw new Error('remote banner exceeds size limit');
      }
      chunks.push(buffer);
    }
  } finally {
    if (!response.destroyed) response.destroy();
  }

  const body = Buffer.concat(chunks, totalBytes);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
}

/**
 * Resolution, caching and refresh of remote ActivityPub actors.
 *
 * Extracted verbatim from the monolithic FederationService — same behavior,
 * same public method signatures. This is the base sub-service: it depends only
 * on the shared low-level helpers and the Oxy service client, never on the other
 * federation sub-services, so it can be imported directly without a cycle.
 */
export class ActorService {
  /**
   * Actor URIs with an in-flight background refresh. Guards against launching
   * multiple concurrent `fetchRemoteActor` calls for the same actor (refresh
   * storms) when a profile is viewed repeatedly while the first fetch is still
   * running.
   */
  private readonly inFlightActorRefreshes = new Set<string>();

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
      const { response, status } = await fetchUpstreamSingleHop(url, {
        headers: { Accept: 'application/jrd+json, application/json' },
        signal: AbortSignal.timeout(WEBFINGER_TIMEOUT_MS),
        headersTimeoutMs: WEBFINGER_TIMEOUT_MS,
      });
      if (status < 200 || status >= 300) {
        response.destroy();
        return null;
      }

      const body = await readBoundedResponseBody(response, WEBFINGER_MAX_BYTES);
      const data = JSON.parse(Buffer.from(body).toString('utf8')) as {
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
      const verifiedAcctHint = acctMatchesActorHost(canonicalAcctHint, actorHost)
        ? canonicalAcctHint
        : undefined;
      const verifiedActorWebfinger = acctMatchesActorHost(actorWebfinger, actorHost)
        ? actorWebfinger
        : undefined;
      const acct = verifiedAcctHint
        || verifiedActorWebfinger
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
          // Download and upload remote banner to Oxy (same pattern as avatar), but
          // only through the shared SSRF-safe upstream fetcher: it validates the
          // original URL and every redirect hop, pins DNS, and applies timeouts.
          if (oxyId && headerUrl) {
            try {
              const deadline = AbortSignal.timeout(WEBFINGER_TIMEOUT_MS);
              const { response: imgRes } = await fetchUpstreamFollowingRedirects(headerUrl, {}, deadline);
              if ((imgRes.statusCode ?? 0) >= 200 && (imgRes.statusCode ?? 0) < 300) {
                const contentType = contentTypeFamily(imgRes.headers);
                if (!contentType.startsWith('image/') || !isAllowedMediaType(contentType)) {
                  imgRes.destroy();
                  throw new Error(`remote banner content-type not allowed: ${contentType || 'unknown'}`);
                }
                const buffer = await readBoundedResponseBody(imgRes, ACTOR_BANNER_MAX_BYTES);
                const blob = new Blob([buffer], { type: contentType });
                const asset = await oxyClient.uploadProfileBanner(blob, oxyId);
                const fileId = asset?.file?.id;
                if (fileId) {
                  await UserSettings.updateOne(
                    { oxyUserId: oxyId },
                    { $set: { profileHeaderImage: fileId } },
                    { upsert: true },
                  );
                }
              } else {
                imgRes.destroy();
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

  /**
   * Resolve a remote actor URI to its listable Oxy user id (the federated user
   * the actor already resolves to). Returns null when the actor cannot be
   * resolved to an Oxy user — callers must then skip, because federated
   * engagement is only ever recorded against a real, listable user.
   */
  async resolveActorOxyUserId(actorUri: string): Promise<string | null> {
    const actor = await this.getOrFetchActor(actorUri);
    return actor?.oxyUserId ?? null;
  }

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

export const actorService = new ActorService();
export default actorService;
