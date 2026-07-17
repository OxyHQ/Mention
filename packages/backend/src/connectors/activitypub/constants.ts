import { registrableApex } from '@oxyhq/core';
import { createDomainPolicy, createUrlBuilders } from '@oxyhq/federation';
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

/**
 * Per-instance ActivityPub URL builders, bound to Mention's FEDERATION_DOMAIN /
 * ACTOR_DOMAIN via the shared `@oxyhq/federation` factory. The URL SHAPES live in
 * the engine (so every Oxy app federates identically); this module owns only the
 * domain configuration. `actorUrl` is `ACTOR_DOMAIN`-scoped; the rest are
 * `FEDERATION_DOMAIN`-scoped — unchanged from the previous hand-written builders.
 */
export const federationUrls = createUrlBuilders(FEDERATION_DOMAIN, ACTOR_DOMAIN);
export const actorUrl = federationUrls.actor;
export const inboxUrl = federationUrls.inbox;
export const outboxUrl = federationUrls.outbox;
export const featuredUrl = federationUrls.featured;
export const followersUrl = federationUrls.followers;
export const followingUrl = federationUrls.following;
export const sharedInboxUrl = federationUrls.sharedInbox;

/**
 * Canonical href for a hashtag — the SINGLE shape shared by the Note's `Hashtag`
 * `tag` entries and the body linkifier, so a `#tag` in the text and its
 * machine-readable tag point at the same URL. Mirrors Mastodon's `/tags/:name`.
 */
export function hashtagUrl(tag: string): string {
  return `https://${FEDERATION_DOMAIN}/hashtag/${encodeURIComponent(tag)}`;
}

/**
 * Mention's per-instance domain policy, bound via the shared `@oxyhq/federation`
 * factory. `isBlockedDomain` rejects our own ActivityPub domains, the Oxy identity
 * apex (both publish our own users), and any configured `FEDERATION_BLOCKED_DOMAINS`;
 * `extractLocalPostId` recognises our own AP post URIs. The URI/domain LOGIC lives
 * in the engine; this module owns the domain configuration.
 */
const domainPolicy = createDomainPolicy({
  domain: FEDERATION_DOMAIN,
  actorDomain: ACTOR_DOMAIN,
  identityApex: OXY_IDENTITY_APEX,
  blockedDomains: FEDERATION_BLOCKED_DOMAINS,
});
export const isBlockedDomain = domainPolicy.isBlockedDomain;
export const extractLocalPostIdFromApUri = domainPolicy.extractLocalPostId;

export const USER_AGENT = `Mention/${FEDERATION_DOMAIN} (ActivityPub)`;

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
