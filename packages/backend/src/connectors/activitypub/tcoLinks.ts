import { createTcoLinkExpander } from '@oxy.so/federation/node';
import type { PostContentVariant } from '@mention/shared-types';
import { fetchUpstreamSingleHop } from '../../utils/safeUpstreamFetch';
import { getRedisClient } from '../../utils/redis';
import { withRedisFallback } from '../../utils/redisHelpers';
import { USER_AGENT } from './constants';

/** A `t.co` id names one link forever, so its expansion is kept a long time. */
const TCO_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const cacheKey = (id: string) => `tco:${id}`;

/**
 * X's `t.co` wrapper unwrapped into the link the author posted — the rule and
 * its limits live in `@oxy.so/federation`. Mention supplies the SSRF-safe hop
 * and a Redis cache, so the same link in many bridged posts costs one request.
 */
export const expandTcoLinks = createTcoLinkExpander({
  userAgent: USER_AGENT,
  fetchSingleHop: async (url, init) => {
    const { response, status, headers } = await fetchUpstreamSingleHop(url, init);
    response.destroy();
    const { location } = headers;
    return new Response(null, {
      status,
      headers: typeof location === 'string' ? { location } : {},
    });
  },
  cache: {
    get: (id) => {
      const redis = getRedisClient();
      return withRedisFallback(redis, () => redis.get(cacheKey(id)), null, 'tcoLinkGet');
    },
    set: async (id, target) => {
      const redis = getRedisClient();
      await withRedisFallback(
        redis,
        () => redis.set(cacheKey(id), target, { EX: TCO_CACHE_TTL_SECONDS }),
        null,
        'tcoLinkSet',
      );
    },
  },
});

/** {@link expandTcoLinks} over every body of a post. */
export function expandVariantTcoLinks(
  variants: PostContentVariant[],
): Promise<PostContentVariant[]> {
  return Promise.all(
    variants.map(async (variant) => ({ ...variant, text: await expandTcoLinks(variant.text) })),
  );
}
