import { logger } from '../../utils/logger';
import sanitizeHtml from 'sanitize-html';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import {
  FEDERATION_ENABLED,
  AP_CONTENT_TYPE,
  AP_ACCEPT_TYPES,
  isBlockedDomain,
} from './constants';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { decode as decodeEntities } from 'he';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import {
  signedFetch,
  firstStringUrl,
  normalizeFederatedAcct,
  domainFromAcct,
} from './helpers';
import { readBoundedResponseBody } from '../shared/httpBody';
import { resolveOxyExternalUser } from '../identity';
import type { NormalizedExternalActor } from '../types';

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

function sameOriginUrl(a: string, b: string): boolean {
  try {
    return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase();
  } catch {
    return false;
  }
}

function actorPublicKeyIsSelfConsistent(actor: Record<string, any>): boolean {
  const publicKey = actor.publicKey;
  if (!publicKey || typeof publicKey !== 'object') return true;

  const publicKeyId = typeof publicKey.id === 'string' ? publicKey.id : undefined;
  if (publicKeyId && !sameOriginUrl(publicKeyId, actor.id)) return false;

  const owner = typeof publicKey.owner === 'string' ? publicKey.owner : undefined;
  if (owner && owner !== actor.id) return false;

  return true;
}

function acctMatchesActorHost(acct: string | undefined, actorHost: string): acct is string {
  if (!acct) return false;
  const domain = domainFromAcct(acct)?.toLowerCase();
  if (!domain) return false;
  const normalizedActorHost = actorHost.toLowerCase();
  return domain === normalizedActorHost || normalizedActorHost === `www.${domain}`;
}

/**
 * Resolution, caching and refresh of remote ActivityPub actors.
 *
 * Extracted verbatim from the former monolithic FederationService — same behavior,
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
      // Reject our own/blocked domains before any network I/O. Oxy's identity
      // apex publishes every local user as `acct:<user>@<apex>` (DID layer), so
      // resolving such an actor would create a duplicate FederatedActor row for
      // a local user and POST `/users/resolve` against the platform's own
      // identity. A malformed URI throws here and is handled by the catch below,
      // matching the prior behaviour where `signedFetch` would have failed.
      const requestedHost = new URL(actorUri).hostname.toLowerCase();
      if (isBlockedDomain(requestedHost)) {
        logger.info(`[FedSync] fetchRemoteActor skipping own/blocked domain ${requestedHost} for ${actorUri}`);
        return null;
      }

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

      if (!sameOriginUrl(actorUri, actor.id)) {
        logger.warn(`[FedSync] rejecting actor ${actorUri}: fetched URI is not authoritative for claimed id ${actor.id}`);
        return null;
      }

      if (!actorPublicKeyIsSelfConsistent(actor)) {
        logger.warn(`[FedSync] rejecting actor ${actorUri}: publicKey is not self-consistent for claimed id ${actor.id}`);
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
      // Re-check against the RESOLVED host/acct (post-redirect / WebFinger), which
      // can differ from the originally-requested URI host the early-return guard
      // (~line 167, before any network I/O) already screened. WebFinger/redirects
      // may land us on an own/blocked domain even when the requested URI did not —
      // so this guard is NOT redundant with the early one and must stay.
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
        protocol: 'activitypub',
        uri: actor.id,
        username,
        domain,
        acct,
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
      // `resolveOxyExternalUser` (the network-neutral identity bridge shared with
      // the atproto connector) creates the federated Oxy user if it does not
      // exist, updates it when changed, and mirrors the banner — using a service
      // token for `PUT /users/resolve`. This connector then stamps its own
      // FederatedActor row with the resolved id.
      if (fedActor) {
        try {
          const normalized: NormalizedExternalActor = {
            network: 'activitypub',
            externalId: actor.id,
            handle: acct,
            displayName: decodeEntities(actor.name || username),
            avatarUrl,
            bannerUrl: headerUrl,
            bio: actor.summary ? htmlToPlainText(actor.summary) : undefined,
            followersCount,
            followingCount,
            postsCount,
            oxyUserId: fedActor.oxyUserId ?? undefined,
          };
          const oxyId = await resolveOxyExternalUser(normalized, { forceAvatarRefresh });
          if (oxyId && fedActor.oxyUserId !== oxyId) {
            await FederatedActor.updateOne({ _id: fedActor._id }, { $set: { oxyUserId: oxyId } });
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
      || !existing.headerUrl;
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
