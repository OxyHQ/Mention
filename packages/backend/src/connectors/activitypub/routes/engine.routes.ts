import { type Request } from 'express';
import rateLimit from 'express-rate-limit';
import type { User } from '@oxyhq/core';
import {
  createWebfingerRouter,
  createActorRouter,
  type WebfingerJrd,
  type FollowPage,
} from '@oxyhq/federation/node';
import { logger } from '../../../utils/logger';
import { getRedisClient } from '../../../utils/redis';
import { RedisStore } from '../../../middleware/rateLimitStore';
import { hashedIpKey } from '../../../utils/ipKey';
import { getServiceOxyClient } from '../../../utils/oxyHelpers';
import UserSettings from '../../../models/UserSettings';
import { getPublicKey } from '../crypto';
import { buildLocalActorObject } from '../actorObject';
import { actorService } from '../actor.service';
import { inboxProcessingService } from '../inbox.service';
import { enqueueInboxActivity } from '../../../queue/producers';
import { webfingerCacheKey } from '../webfingerCache';
import {
  FEDERATION_DOMAIN,
  FEDERATION_ENABLED,
  AP_CONTENT_TYPE,
  isActivityPubAccept,
  federationUrls,
  resolveOxyUser,
} from '../constants';
import {
  isFediverseSharingEnabledFromUser,
  getFediverseSharingStateByUsername,
} from '../../../services/fediverseSharing';

/**
 * Mention's binding of the shared `@oxyhq/federation` webfinger + actor + inbox
 * routers.
 *
 * The routers themselves (discovery bytes, the HTTP-signature-verified inbox, the
 * 404-when-sharing-off gate, the follow-graph collection pages) live in the engine
 * so every Oxy app federates identically; this module supplies Mention's domain
 * config, the Oxy profile/consent reads, the key custody, the banner, the actor
 * builder, the Redis JRD cache, the inbox enqueue transport, the inbound
 * dispatcher, and the Oxy follow-graph page fetch.
 *
 * The CONTENT routes (outbox / featured / per-post dereference) stay in
 * `ap.routes.ts`, mounted on the SAME `/ap/users/:username/*` prefix the actor
 * advertises.
 */

/** WebFinger JRD cache TTL (seconds) — matches the engine's response `max-age`. */
const WEBFINGER_CACHE_TTL = 3600;

/**
 * Rate-limit the AP protocol endpoints (300 req/min per IP — abuse/DDoS guard).
 * Mounted ONCE at `/ap` in `server.ts`, before both the engine actor router and
 * the content router, so every `/ap/*` request is counted exactly once. AP
 * endpoints are anonymous (remote servers), so key by an HMAC of the
 * IPv6-subnet-normalized IP — the raw address must never reach a Redis key.
 */
export const apRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:ap:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too Many Requests' },
  keyGenerator: (req: Request) => hashedIpKey(req),
});

/**
 * Fetch one page of a user's follow graph (followers OR following) from the Oxy
 * API — the AUTHORITATIVE graph containing BOTH local Mention edges AND the
 * federated edges `handleIncomingFollow` bridges in.
 */
async function fetchFollowPage(
  userId: string,
  direction: 'followers' | 'following',
  offset: number,
  limit: number,
): Promise<FollowPage> {
  const oxy = getServiceOxyClient();
  if (direction === 'followers') {
    const result = await oxy.getUserFollowers(userId, { limit, offset });
    return {
      members: Array.isArray(result.followers) ? (result.followers as User[]) : [],
      total: typeof result.total === 'number' ? result.total : 0,
      hasMore: result.hasMore === true,
    };
  }
  const result = await oxy.getUserFollowing(userId, { limit, offset });
  return {
    members: Array.isArray(result.following) ? (result.following as User[]) : [],
    total: typeof result.total === 'number' ? result.total : 0,
    hasMore: result.hasMore === true,
  };
}

/** WebFinger + host-meta discovery router. */
export const webfingerRouter = createWebfingerRouter({
  domain: FEDERATION_DOMAIN,
  federationEnabled: FEDERATION_ENABLED,
  urls: federationUrls,
  resolveUser: (username) => resolveOxyUser(username),
  consent: {
    isSharingEnabledFromUser: (user) => isFediverseSharingEnabledFromUser(user),
    getSharingStateByUsername: (username) => getFediverseSharingStateByUsername(username),
  },
  cache: {
    get: async (username) => {
      const redis = getRedisClient();
      if (!redis?.isReady) return null;
      try {
        const cached = await redis.get(webfingerCacheKey(username));
        return cached ? (JSON.parse(cached) as WebfingerJrd) : null;
      } catch {
        // Redis unavailable / malformed entry — treat as a cache miss.
        return null;
      }
    },
    set: (username, jrd) => {
      const redis = getRedisClient();
      if (redis?.isReady) {
        redis.setEx(webfingerCacheKey(username), WEBFINGER_CACHE_TTL, JSON.stringify(jrd)).catch(() => {});
      }
    },
  },
  logger: { error: (message, detail) => logger.error(message, detail) },
});

/** Actor GET + inbox POST + followers/following router. */
export const actorRouter = createActorRouter({
  domain: FEDERATION_DOMAIN,
  federationEnabled: FEDERATION_ENABLED,
  apContentType: AP_CONTENT_TYPE,
  urls: federationUrls,
  wantsActivityPub: (accept) => isActivityPubAccept(accept),
  getPublicKey: (username) => getPublicKey(username),
  resolveUser: (username) => resolveOxyUser(username),
  consent: {
    isSharingEnabledFromUser: (user) => isFediverseSharingEnabledFromUser(user),
    getSharingStateByUsername: (username) => getFediverseSharingStateByUsername(username),
  },
  buildLocalActorObject,
  getBanner: async (oxyUserId) => {
    const settings = await UserSettings.findOne({ oxyUserId }, { profileHeaderImage: 1 })
      .lean<{ profileHeaderImage?: string } | null>();
    return settings?.profileHeaderImage ?? null;
  },
  inbound: {
    fetchPublicKey: (keyId) => actorService.fetchPublicKey(keyId),
    // The apex (mention.earth) is CF-proxied → ALB → backend, which rewrites the
    // origin Host to api.mention.earth while Mastodon signs over mention.earth
    // (forwarded in X-Forwarded-Host). Reconstruct the signed `host` line from it.
    trustForwardedHost: true,
    enqueueInboxActivity: (job) => enqueueInboxActivity(job),
    processInboxActivity: (activity, verifiedActorUri) =>
      inboxProcessingService.processInboxActivity(activity, verifiedActorUri),
  },
  fetchFollowPage,
  logger: {
    debug: (message, detail) => (detail === undefined ? logger.debug(message) : logger.debug(message, detail)),
    warn: (message, detail) => (detail === undefined ? logger.warn(message) : logger.warn(message, detail)),
    error: (message, detail) => (detail === undefined ? logger.error(message) : logger.error(message, detail)),
  },
});
