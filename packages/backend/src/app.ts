import compression from 'compression';
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
} from 'express';
import helmet from 'helmet';
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

const CSP_CONNECT_SRC = [
  "'self'",
  'blob:',
  'data:',
  'https://api.mention.earth',
  'wss://api.mention.earth',
  'https://api.oxy.so',
  'wss://api.oxy.so',
  'https://cloud.oxy.so',
  'https://api.syra.fm',
  'wss://api.syra.fm',
  'https://livekit.oxy.so',
  'wss://livekit.oxy.so',
];

const CSP_FRAME_SRC = [
  "'self'",
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
];

/**
 * Build the HTTP application only.
 *
 * All runtime-bearing dependencies are injected. This function never listens,
 * opens Mongo/Redis, creates Socket.IO, starts timers, or registers schedulers.
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

  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'connect-src': CSP_CONNECT_SRC,
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
        'media-src': ["'self'", 'data:', 'blob:', 'https:'],
        'frame-src': CSP_FRAME_SRC,
        'worker-src': ["'self'", 'blob:'],
      },
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
