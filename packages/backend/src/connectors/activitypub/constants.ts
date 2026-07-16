import { registrableApex } from '@oxyhq/core';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

export const FEDERATION_DOMAIN = process.env.FEDERATION_DOMAIN || 'mention.earth';
export const ACTOR_DOMAIN = process.env.ACTOR_DOMAIN || FEDERATION_DOMAIN;
if (ACTOR_DOMAIN !== FEDERATION_DOMAIN) {
  logger.warn(`Federation domains differ: ACTOR_DOMAIN=${ACTOR_DOMAIN} FEDERATION_DOMAIN=${FEDERATION_DOMAIN}`);
}
export const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

/**
 * Oxy's identity apex — the anchor domain of the DID layer. Every Oxy/Mention
 * user is ALSO published as `acct:<username>@<apex>` (e.g. `acct:alice@oxy.so`),
 * so an actor on this apex is one of OUR OWN users, never a remote federated
 * source. Treating it as remote makes `ActorService.fetchRemoteActor` create
 * duplicate `FederatedActor` rows for local users and call Oxy
 * `PUT /users/resolve` against the platform's own identities — hence it is
 * folded into {@link isBlockedDomain} below.
 *
 * Derived from `OXY_API_URL`'s registrable domain via the Public Suffix List
 * (`https://api.oxy.so` → `oxy.so`); overridable with `OXY_IDENTITY_APEX` for
 * non-production anchors. The trailing literal is only reached if the API URL is
 * malformed (no registrable domain) and no override is set.
 */
const oxyApiHost = (() => {
  try {
    return new URL(OXY_API_URL).hostname;
  } catch {
    return OXY_API_URL;
  }
})();
export const OXY_IDENTITY_APEX = (
  process.env.OXY_IDENTITY_APEX
  || registrableApex(oxyApiHost)
  || 'oxy.so'
).toLowerCase();
export const FEDERATION_ENABLED = process.env.FEDERATION_ENABLED !== 'false';
export const FEDERATION_MAX_CONTENT_LENGTH = parseInt(process.env.FEDERATION_MAX_CONTENT_LENGTH || '50000', 10);
export const FEDERATION_DELIVERY_RETRIES = parseInt(process.env.FEDERATION_DELIVERY_RETRIES || '5', 10);
const FEDERATION_BLOCKED_DOMAINS = new Set(
  (process.env.FEDERATION_BLOCKED_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean)
);

export const AP_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
];

export const AP_CONTENT_TYPE = 'application/activity+json';
export const AP_ACCEPT_TYPES = [
  'application/activity+json',
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
];

/**
 * Returns true when an Accept header asks for ActivityPub JSON.
 *
 * Some federated clients send plain `application/ld+json`, differently-cased
 * media types, or profiled JSON-LD variants. Keep this intentionally aligned
 * with the Cloudflare Pages profile worker to avoid profile URL ↔ actor URL
 * redirect loops during ActivityPub discovery.
 */
export function isActivityPubAccept(accept: string | string[] | undefined): boolean {
  if (!accept) return false;
  const value = Array.isArray(accept) ? accept.join(',') : accept;
  const lower = value.toLowerCase();
  return lower.includes('activity+json') || lower.includes('ld+json');
}

export function actorUrl(username: string): string {
  return `https://${ACTOR_DOMAIN}/ap/users/${username}`;
}

/**
 * Canonical href for a hashtag — the SINGLE shape shared by the Note's `Hashtag`
 * `tag` entries and the body linkifier, so a `#tag` in the text and its
 * machine-readable tag point at the same URL. Mirrors Mastodon's `/tags/:name`.
 */
export function hashtagUrl(tag: string): string {
  return `https://${FEDERATION_DOMAIN}/hashtag/${encodeURIComponent(tag)}`;
}

export function inboxUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/inbox`;
}

export function outboxUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/outbox`;
}

/**
 * The actor's `featured` collection (pinned posts). Mastodon reads this URL from
 * the actor's `featured` property and fetches it on profile view — it is the ONLY
 * way a freshly-discovered account's posts populate its profile Posts tab
 * (Mastodon never backfills a remote timeline from the regular `outbox`). The
 * exact path only needs to be self-consistent with what the actor advertises;
 * this mirrors Mastodon's own `/collections/featured` convention under our
 * existing `/ap/users/:username` namespace.
 */
export function featuredUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/collections/featured`;
}

export function followersUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/followers`;
}

export function followingUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/following`;
}

export function sharedInboxUrl(): string {
  return `https://${FEDERATION_DOMAIN}/ap/inbox`;
}

/**
 * Domains where WE mint ActivityPub URIs. Used to recognise our own post URIs
 * (see {@link extractLocalPostIdFromApUri}); the Oxy identity apex is NOT here
 * because Oxy does not mint Mention post URIs — it only publishes user DIDs.
 */
const LOCAL_DOMAINS = new Set([
  FEDERATION_DOMAIN.toLowerCase(),
  ACTOR_DOMAIN.toLowerCase(),
]);

/**
 * Returns true if the domain should be rejected for federation.
 *
 * Includes our own ActivityPub domains AND Oxy's identity apex
 * ({@link OXY_IDENTITY_APEX}) — both publish our own users, so resolving an
 * actor there would create duplicate `FederatedActor` rows for local users —
 * plus any explicitly configured `FEDERATION_BLOCKED_DOMAINS`.
 */
export function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return LOCAL_DOMAINS.has(d) || d === OXY_IDENTITY_APEX || FEDERATION_BLOCKED_DOMAINS.has(d);
}

export const USER_AGENT = `Mention/${FEDERATION_DOMAIN} (ActivityPub)`;

/**
 * Extract a local Post id from an ActivityPub object URI that points at one of
 * our own posts. Local note URIs are minted as
 * `https://<our-domain>/ap/users/<username>/posts/<postId>` (see
 * `buildCreateNoteActivity` and the outbox route), so a remote Like/Announce
 * that targets one of our posts carries that URI as its `object`.
 *
 * Returns the trailing `<postId>` segment only when the URI host is one of our
 * own federation domains and the path matches the canonical scheme; otherwise
 * returns null (the object is a remote/imported post, resolved by
 * `federation.activityId` instead). Caller must still validate the id is a real
 * ObjectId before querying.
 */
export function extractLocalPostIdFromApUri(objectUri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(objectUri);
  } catch {
    return null;
  }
  if (!LOCAL_DOMAINS.has(parsed.host.toLowerCase())) return null;
  const match = parsed.pathname.match(/^\/ap\/users\/[^/]+\/posts\/([^/]+)\/?$/);
  return match ? match[1] : null;
}

/** Path segments that typically separate an actor path from a post ID in ActivityPub URIs. */
const POST_PATH_SEGMENTS = new Set(['statuses', 'posts', 'notes', 'objects', 'activities']);

/**
 * Given an ActivityPub activity/object ID (URL), extract the actor URI by
 * trimming everything from the first recognised post-path segment onward.
 *
 * e.g. "https://mastodon.social/users/alice/statuses/12345"
 *    → "https://mastodon.social/users/alice"
 *
 * Returns null when the URL is malformed or no post-path segment is found.
 */
export function extractActorUriFromActivityId(activityId: string): string | null {
  try {
    const url = new URL(activityId);
    const segments = url.pathname.split('/').filter(Boolean);
    const statusIdx = segments.findIndex(s => POST_PATH_SEGMENTS.has(s));
    if (statusIdx < 1) return null;
    return `${url.origin}/${segments.slice(0, statusIdx).join('/')}`;
  } catch {
    return null;
  }
}

/**
 * Resolve an Oxy user by username (tries getUserByUsername, falls back to searchUsers).
 * Returns the user object or null.
 */
export async function resolveOxyUser(username: string): Promise<any> {
  // Service-authed Oxy client — the bare `oxy` singleton in server.ts is
  // unauthenticated and reserved for validating incoming request tokens
  // (`oxy.auth()`), so resolving a profile on it returns nothing.
  const oxy = getServiceOxyClient();
  try {
    return await oxy.getProfileByUsername(username);
  } catch (err) {
    logger.debug(`[Federation] getProfileByUsername('${username}') failed, trying searchProfiles`, err);
    try {
      const response = await oxy.searchProfiles(username);
      const results = Array.isArray(response) ? response : response?.data;
      return results?.find?.((u: { username?: string }) =>
        u.username?.toLowerCase() === username.toLowerCase()
      ) || null;
    } catch (searchErr) {
      logger.warn(`[Federation] resolveOxyUser('${username}') failed completely`, searchErr);
      return null;
    }
  }
}
