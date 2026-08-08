import { createOxySecurityHeaders, type OxyCspExtensions } from '@oxyhq/core/server';
import compression from 'compression';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from 'express';
import type { AppRoutes } from './appRoutes';

export interface AppMiddleware {
  requestObservability: RequestHandler;
  rateLimiter: RequestHandler;
  bruteForceProtection: RequestHandler;
  globalErrorHandler: ErrorRequestHandler;
}

export interface CreateAppDependencies {
  frontendUrl?: string;
  federationDomain: string;
  isAllowedOrigin(origin: string): boolean;
  isApexHost(req: Request): boolean;
  isApexWebPlaneRequest(req: Request): boolean;
  countLocalPosts(): Promise<number>;
  logger: {
    debug(message: string, ...args: unknown[]): void;
  };
  middleware: AppMiddleware;
  routes: AppRoutes;
}

/**
 * Mention's additions to the Oxy CSP baseline (`@oxyhq/core/server`). Additive
 * only: the baseline already carries `'self'`, the Cloudflare Insights beacon
 * hosts, the Oxy API/CDN origins, inline styles and `data:` images/fonts, so
 * nothing it provides is restated here — only what is specific to Mention.
 */
const MENTION_CSP_EXTENSIONS: OxyCspExtensions = {
  connectSrc: [
    'blob:',
    'data:',
    'https://api.mention.earth',
    'wss://api.mention.earth',
    // Live rooms are served by Syra's backend and LiveKit, not api.mention.earth.
    'https://api.syra.fm',
    'wss://api.syra.fm',
    'https://livekit.oxy.so',
    'wss://livekit.oxy.so',
  ],
  // Federated media is user-supplied and lives on arbitrary remote instances.
  imgSrc: ['blob:', 'https:'],
  mediaSrc: ['data:', 'blob:', 'https:'],
  // External embed players (`utils/embedPlayer.ts`) mount these in an iframe.
  frameSrc: [
    'https://www.youtube-nocookie.com',
    'https://www.youtube.com',
    'https://player.vimeo.com',
    'https://open.spotify.com',
    'https://player.twitch.tv',
    'https://clips.twitch.tv',
    'https://w.soundcloud.com',
    'https://embed.music.apple.com',
    'https://embedr.flickr.com',
    'https://bandcamp.com',
  ],
  workerSrc: ['blob:'],
};

/**
 * Build the HTTP application only.
 *
 * All runtime-bearing dependencies are injected. This function never listens,
 * opens Postgres or Redis, creates Socket.IO, starts timers, or registers
 * schedulers.
 */
export function createApp(deps: CreateAppDependencies): express.Express {
  const { middleware, routes } = deps;
  const app = express();

  app.set('trust proxy', 1);
  app.use(middleware.requestObservability);

  // CORS must precede every route so failures (including 429/500) carry it.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && deps.isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (deps.frontendUrl) {
      res.setHeader('Access-Control-Allow-Origin', deps.frontendUrl);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version',
    );
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (
      !deps.isApexHost(req) &&
      !req.path.startsWith('/ap/') &&
      !req.path.startsWith('/.well-known/') &&
      !req.path.startsWith('/xrpc/') &&
      !req.path.startsWith('/ap-bridge/')
    ) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  });

  app.use(routes.health);
  app.use(routes.internalMetrics);

  // `helmet` must stay a DIRECT dependency of this package even though nothing
  // here imports it: `@oxyhq/core` requires it at runtime but declares it as an
  // OPTIONAL peerDependency, so it is installed only because we declare it.
  // Dropping it from package.json uninstalls it and this call throws at boot.
  app.use(createOxySecurityHeaders({
    csp: MENTION_CSP_EXTENSIONS,
    helmet: {
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // Match the baseline's `frame-ancestors 'none'`; helmet's SAMEORIGIN
      // default would state a different policy to pre-CSP browsers.
      frameguard: { action: 'deny' },
    },
  }));

  app.use(compression({
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      if (req.path === '/media/proxy') return false;
      return compression.filter(req, res);
    },
    level: 6,
    threshold: 1024,
  }));

  /**
   * MUST stay ahead of `express.json` below.
   *
   * A CrowdSource webhook signature covers the bytes that arrived, and once a JSON
   * parser has consumed the stream those bytes no longer exist. The `verify` hook
   * below keeps a UTF-8 STRING copy for ActivityPub HTTP signatures, which is not
   * what `@oxyhq/crowdsource-express` accepts — it looks for a Buffer, finds a
   * parsed `req.body` instead, and REFUSES rather than verifying a signature over a
   * re-serialisation. So mounting this after the parser does not silently verify the
   * wrong bytes; it fails every delivery, loudly. Mounted here anyway, because a
   * moderation decision that arrives correctly is better than one that arrives as an
   * error handler entry.
   *
   * It also sits ahead of the rate limiter, deliberately: the HMAC is the
   * authentication (§10.8) and it is verified over a body bounded by the
   * middleware's own limit, while a 429 to CrowdSource would put a decision back on
   * a retry schedule for no reason.
   */
  app.use('/webhooks', routes.crowdSourceWebhook);

  app.use(express.json({
    limit: '1mb',
    type: ['application/json', 'application/activity+json', 'application/ld+json'],
    verify: (req: express.Request & { rawBody?: string }, _res, buffer) => {
      req.rawBody = buffer?.length ? buffer.toString('utf8') : undefined;
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use((req, res, next) => {
    if (deps.isApexWebPlaneRequest(req)) return next();
    return middleware.rateLimiter(req, res, next);
  });
  app.use((req, res, next) => {
    if (deps.isApexWebPlaneRequest(req)) return next();
    return middleware.bruteForceProtection(req, res, next);
  });
  app.use(routes.webTelemetry);

  app.use((req, _res, next) => {
    const query = req.query;
    if (query && typeof query === 'object') {
      const filters: Record<string, express.Request['query'][string]> = {};
      for (const key of Object.keys(query)) {
        const match = key.match(/^filters\[(.+)\]$/);
        if (match && !filters[match[1]]) {
          filters[match[1]] = query[key];
        }
      }
      if (Object.keys(filters).length > 0) {
        // Express 5 exposes `req.query` through a prototype getter that reparses
        // the URL on every access. Mutating one getter result is therefore lost
        // before the route handler reads it. Pin the normalized value on this
        // request instance so every downstream access observes the same object.
        Object.defineProperty(req, 'query', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: { ...query, filters },
        });
      }
    }
    next();
  });

  app.get('/', routes.legacyRoot);

  // Federation endpoints must stay ahead of web shell and the apex proxy.
  app.use('/.well-known', routes.webfinger);
  app.get('/.well-known/nodeinfo', (_req, res) => {
    res.json({
      links: [{
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
        href: `https://${deps.federationDomain}/nodeinfo/2.0`,
      }],
    });
  });
  app.get('/nodeinfo/2.0', async (_req, res) => {
    let postCount = 0;
    try {
      postCount = await deps.countLocalPosts();
    } catch (error) {
      deps.logger.debug('nodeinfo: failed to estimate post count, defaulting to 0', error);
    }
    res.json({
      version: '2.0',
      software: { name: 'mention', version: '1.0.0' },
      protocols: ['activitypub'],
      usage: {
        users: { total: 0 },
        localPosts: postCount,
      },
      openRegistrations: true,
    });
  });
  app.use('/ap', routes.apRateLimiter);
  app.use('/ap', routes.actor);
  app.use('/ap', routes.federationContent);
  app.use('/xrpc', routes.atprotoBridge);
  app.use('/ap-bridge', routes.atprotoBridgeMeta);
  app.use('/.well-known', routes.wellKnownBridge);
  app.use('/media', routes.media);
  app.use(routes.mcpOAuth);

  app.use('/', routes.webShell);
  app.use(routes.apexProxy);
  app.use('/', routes.publicApi);
  app.use('/', routes.requireAuth, routes.authenticatedApi);

  app.use(middleware.globalErrorHandler);
  return app;
}

export default createApp;
