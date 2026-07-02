import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { FEDERATION_DOMAIN, FEDERATION_ENABLED, actorUrl, resolveOxyUser } from '../constants';
import { logger } from '../../../utils/logger';
import { getRedisClient } from '../../../utils/redis';
import { isFediverseSharingEnabledFromUser } from '../../../services/fediverseSharing';
import { webfingerCacheKey } from '../webfingerCache';

const router = Router();

const WEBFINGER_CACHE_TTL = 3600; // 1 hour in seconds

const webfingerSchema = z.object({
  resource: z.string().startsWith('acct:', 'Resource must start with acct:'),
});

/**
 * WebFinger endpoint — resolves acct: URIs to ActivityPub actor URLs.
 * GET /.well-known/webfinger?resource=acct:username@mention.earth
 */
router.get('/webfinger', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) {
    return res.status(404).json({ error: 'Federation is disabled' });
  }

  const parsed = webfingerSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const acct = parsed.data.resource.replace('acct:', '');
  const atIndex = acct.indexOf('@');
  if (atIndex === -1) {
    return res.status(400).json({ error: 'Invalid acct format' });
  }

  const username = acct.substring(0, atIndex);
  const domain = acct.substring(atIndex + 1);

  if (domain.toLowerCase() !== FEDERATION_DOMAIN.toLowerCase()) {
    return res.status(404).json({ error: 'Unknown domain' });
  }

  try {
    // Check Redis cache first
    const cacheKey = webfingerCacheKey(username);
    const redis = getRedisClient();
    if (redis?.isReady) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          res.set('Content-Type', 'application/jrd+json; charset=utf-8');
          res.set('Cache-Control', `max-age=${WEBFINGER_CACHE_TTL}`);
          return res.json(JSON.parse(cached));
        }
      } catch {
        // Redis unavailable, fall through to DB
      }
    }

    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Sharing OFF must be indistinguishable from a nonexistent user — same
    // 404 body, no separate error code. Derived from the user object already
    // resolved above (no second Oxy lookup).
    if (!(await isFediverseSharingEnabledFromUser(user))) {
      return res.status(404).json({ error: 'User not found' });
    }

    const response = {
      subject: `acct:${username}@${FEDERATION_DOMAIN}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorUrl(username),
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `https://${FEDERATION_DOMAIN}/@${username}`,
        },
        // NOTE: the `http://ostatus.org/schema/1.0/subscribe` (remote-follow) rel
        // is intentionally omitted — Mention has no authorize-interaction /
        // remote-follow endpoint to point it at, and a dangling template would be
        // worse than its absence. Add it here once that endpoint exists.
      ],
    };

    // Cache in Redis
    if (redis?.isReady) {
      redis.setEx(cacheKey, WEBFINGER_CACHE_TTL, JSON.stringify(response)).catch(() => {});
    }

    res.set('Content-Type', 'application/jrd+json; charset=utf-8');
    res.set('Cache-Control', `max-age=${WEBFINGER_CACHE_TTL}`);
    return res.json(response);
  } catch (err) {
    logger.error('WebFinger error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const HOST_META_CACHE_CONTROL = `max-age=${60 * 60 * 24}`; // 24h — host-meta is effectively static
const WEBFINGER_TEMPLATE = `https://${FEDERATION_DOMAIN}/.well-known/webfinger?resource={uri}`;

/**
 * host-meta (XRD/XML) — public fediverse discovery document (RFC 6415).
 * Advertises the WebFinger LRDD template so software that resolves accounts via
 * host-meta (rather than hitting /.well-known/webfinger directly) can find it.
 * GET /.well-known/host-meta
 */
router.get('/host-meta', (_req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) {
    return res.status(404).json({ error: 'Federation is disabled' });
  }
  const xrd = `<?xml version="1.0" encoding="UTF-8"?>
<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">
  <Link rel="lrdd" type="application/jrd+json" template="${WEBFINGER_TEMPLATE}"/>
</XRD>
`;
  res.set('Content-Type', 'application/xrd+xml; charset=utf-8');
  res.set('Cache-Control', HOST_META_CACHE_CONTROL);
  return res.send(xrd);
});

/**
 * host-meta (JRD/JSON variant) — same LRDD template as the XML document, for
 * clients that request the JSON representation.
 * GET /.well-known/host-meta.json
 */
router.get('/host-meta.json', (_req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) {
    return res.status(404).json({ error: 'Federation is disabled' });
  }
  res.set('Content-Type', 'application/jrd+json; charset=utf-8');
  res.set('Cache-Control', HOST_META_CACHE_CONTROL);
  return res.json({
    links: [
      {
        rel: 'lrdd',
        type: 'application/jrd+json',
        template: WEBFINGER_TEMPLATE,
      },
    ],
  });
});

export default router;
