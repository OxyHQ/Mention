import { Router, Request, Response } from 'express';
import { logger } from '../utils/logger';
import { FEDERATION_ENABLED, USER_AGENT } from '../utils/federation/constants';

const router = Router();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];
const PROXY_TIMEOUT = 15000;

/**
 * GET /media/proxy?url={encodedUrl}
 * Proxy remote media from federated instances.
 * Prevents direct client-to-remote-server requests (privacy + CORS).
 */
router.get('/proxy', async (req: Request, res: Response) => {
  if (!FEDERATION_ENABLED) return res.status(404).json({ error: 'Federation disabled' });

  const url = req.query.url as string;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only HTTPS URLs allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/*, video/*',
      },
      signal: AbortSignal.timeout(PROXY_TIMEOUT),
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Upstream fetch failed' });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!ALLOWED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
      return res.status(400).json({ error: 'Unsupported media type' });
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_FILE_SIZE) {
      return res.status(413).json({ error: 'File too large' });
    }

    // Stream the response
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // 24h cache
    res.set('X-Content-Type-Options', 'nosniff');

    if (contentLength > 0) {
      res.set('Content-Length', String(contentLength));
    }

    // Pipe the readable stream
    const reader = response.body?.getReader();
    if (!reader) {
      return res.status(502).json({ error: 'No response body' });
    }

    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.length;
      if (totalBytes > MAX_FILE_SIZE) {
        reader.cancel();
        return res.status(413).end();
      }

      res.write(value);
    }

    return res.end();
  } catch (err) {
    logger.debug('Media proxy error:', err);
    return res.status(502).json({ error: 'Proxy fetch failed' });
  }
});

export default router;
