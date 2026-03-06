import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { FEDERATION_DOMAIN, FEDERATION_ENABLED, actorUrl, resolveOxyUser } from '../utils/federation/constants';
import { logger } from '../utils/logger';

const router = Router();

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
    const user = await resolveOxyUser(username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.set('Content-Type', 'application/jrd+json; charset=utf-8');
    res.set('Cache-Control', 'max-age=3600');
    return res.json({
      subject: `acct:${username}@${FEDERATION_DOMAIN}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorUrl(username),
        },
      ],
    });
  } catch (err) {
    logger.error('WebFinger error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
