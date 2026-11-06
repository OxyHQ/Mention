import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { SyraApiError } from '@syra.fm/sdk';
import { RedisStore } from '../middleware/rateLimitStore';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { syraClient } from '../utils/syraPodcast';

/**
 * GET /api/apple-podcasts/:collectionId — the Syra show for an Apple Podcasts show.
 *
 * A profile link to an Apple Podcasts show opens Syra instead of Apple. Syra
 * imports the show's feed the first time and knows it after, so this asks Syra
 * through its SDK and answers with the show's Syra URL. Public: a profile is
 * read by people with no session.
 */
export const applePodcastRateLimiter = rateLimit({
  store: new RedisStore({ prefix: 'rate-limit:apple-podcast:', windowMs: 60 * 1000 }),
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req: Request) => hashedIpKey(req),
  message: { error: 'Too Many Requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const router = Router();

router.get('/:collectionId', async (req: Request, res: Response) => {
  const collectionId = String(req.params.collectionId);
  try {
    const link = await syraClient.resolveApplePodcast(collectionId);
    res.json({ data: link });
  } catch (err) {
    if (err instanceof TypeError) {
      res.status(400).json({ error: 'An Apple Podcasts collection id is numeric' });
      return;
    }
    if (err instanceof SyraApiError && err.status === 404) {
      res.status(404).json({ error: 'Apple has no podcast with this id' });
      return;
    }
    logger.warn('[apple-podcast] Syra resolve failed', {
      collectionId,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(502).json({ error: 'Syra is unavailable' });
  }
});

export default router;
