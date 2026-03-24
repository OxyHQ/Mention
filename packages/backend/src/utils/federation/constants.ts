export const FEDERATION_DOMAIN = process.env.FEDERATION_DOMAIN || 'mention.earth';
export const ACTOR_DOMAIN = process.env.ACTOR_DOMAIN || 'oxy.so';
export const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
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

export function actorUrl(username: string): string {
  return `https://${ACTOR_DOMAIN}/ap/users/${username}`;
}

export function inboxUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/inbox`;
}

export function outboxUrl(username: string): string {
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}/outbox`;
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

/** Own domains that must never be treated as remote federated sources. */
const LOCAL_DOMAINS = new Set([
  FEDERATION_DOMAIN.toLowerCase(),
  ACTOR_DOMAIN.toLowerCase(),
]);

/**
 * Returns true if the domain should be rejected for federation.
 * Includes our own domains (prevents duplicate users) and explicitly blocked domains.
 */
export function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return LOCAL_DOMAINS.has(d) || FEDERATION_BLOCKED_DOMAINS.has(d);
}

export const USER_AGENT = `Mention/${FEDERATION_DOMAIN} (ActivityPub)`;

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
  const { oxy } = require('../../../server.js');
  try {
    return await oxy.getUserByUsername(username);
  } catch {
    try {
      const results = await oxy.searchUsers(username);
      return results?.find?.((u: any) =>
        u.username?.toLowerCase() === username.toLowerCase()
      ) || null;
    } catch {
      return null;
    }
  }
}
