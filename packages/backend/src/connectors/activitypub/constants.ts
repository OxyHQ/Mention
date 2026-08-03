import { type User } from '@oxyhq/core';
import { createDomainPolicy, createUrlBuilders } from '@oxyhq/federation';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { getBlockedDomainPolicy, resolveFederationBlocks } from './federationBlockPolicy';
import { OXY_IDENTITY_APEX } from './ownDomain';

export const FEDERATION_DOMAIN = config.federation.domain;
export const ACTOR_DOMAIN = config.federation.actorDomain;
if (ACTOR_DOMAIN !== FEDERATION_DOMAIN) {
  logger.warn(`Federation domains differ: ACTOR_DOMAIN=${ACTOR_DOMAIN} FEDERATION_DOMAIN=${FEDERATION_DOMAIN}`);
}
export const OXY_API_URL = config.oxyApiUrl;

export const FEDERATION_ENABLED = config.federation.enabled;
export const FEDERATION_MAX_CONTENT_LENGTH = config.federation.maxContentLength;
export const FEDERATION_DELIVERY_RETRIES = config.federation.deliveryRetries;
/**
 * Every moderation block in force, in the exact form the public transparency
 * page renders — the committed policy file unioned with the
 * `FEDERATION_BLOCKED_DOMAINS` emergency lever. See
 * {@link ./federationBlockPolicy} for why the list is committed rather than
 * configured.
 */
export const FEDERATION_BLOCKS = resolveFederationBlocks(
  getBlockedDomainPolicy(),
  config.federation.blockedDomains,
);

/**
 * The enforced set, DERIVED from the published list rather than assembled beside
 * it. That derivation is what makes the transparency page structurally unable to
 * disagree with the server: a domain can only be blocked here by first being
 * published there.
 */
const FEDERATION_BLOCKED_DOMAINS = new Set(FEDERATION_BLOCKS.map((block) => block.domain));

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
 * apex (both publish our own users), and every published moderation block
 * ({@link FEDERATION_BLOCKS}); `extractLocalPostId` recognises our own AP post
 * URIs. The URI/domain LOGIC lives in the engine; this module owns the domain
 * configuration.
 *
 * The first two are NOT moderation decisions and are deliberately absent from the
 * published list — see the note in `./federationBlockPolicy`.
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
export async function resolveOxyUser(username: string): Promise<User | null> {
  // Service-authed Oxy client — the process-wide request-auth client is
  // unauthenticated and reserved for validating incoming request tokens
  // (`oxy.auth()`), so resolving a profile on it returns nothing.
  const oxy = getServiceOxyClient();
  try {
    return await oxy.getProfileByUsername(username);
  } catch (err) {
    logger.debug('[Federation] profile lookup failed; trying profile search', err);
    try {
      const response = await oxy.searchProfiles(username);
      const results = Array.isArray(response) ? response : response?.data;
      return results?.find?.((u: { username?: string }) =>
        u.username?.toLowerCase() === username.toLowerCase()
      ) || null;
    } catch (searchErr) {
      logger.warn('[Federation] Oxy user resolution failed', searchErr);
      return null;
    }
  }
}
