export const FEDERATION_DOMAIN = process.env.FEDERATION_DOMAIN || 'mention.earth';
export const FEDERATION_ENABLED = process.env.FEDERATION_ENABLED !== 'false';
export const FEDERATION_MAX_CONTENT_LENGTH = parseInt(process.env.FEDERATION_MAX_CONTENT_LENGTH || '50000', 10);
export const FEDERATION_DELIVERY_RETRIES = parseInt(process.env.FEDERATION_DELIVERY_RETRIES || '5', 10);
export const FEDERATION_BLOCKED_DOMAINS = (process.env.FEDERATION_BLOCKED_DOMAINS || '')
  .split(',')
  .map(d => d.trim().toLowerCase())
  .filter(Boolean);

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
  return `https://${FEDERATION_DOMAIN}/ap/users/${username}`;
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

export function isBlockedDomain(domain: string): boolean {
  return FEDERATION_BLOCKED_DOMAINS.includes(domain.toLowerCase());
}

export const USER_AGENT = `Mention/${FEDERATION_DOMAIN} (ActivityPub)`;

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
