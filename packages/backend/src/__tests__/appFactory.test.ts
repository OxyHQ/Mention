import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateAppDependencies } from '../app';
import type { AppRoutes } from '../appRoutes';

const passThrough: RequestHandler = (_req, _res, next) => next();
const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(500).json({ error: 'test error' });
};

function routerWith(
  path: string,
  body: string,
): RequestHandler {
  const router = express.Router();
  router.get(path, (_req, res) => res.status(200).send(body));
  return router;
}

function createRoutes(): AppRoutes {
  const apexProxy: RequestHandler = (req, res, next) => {
    if (req.headers.host === 'mention.earth') {
      res.status(200).send('apex');
      return;
    }
    next();
  };

  return {
    health: routerWith('/health/live', 'live'),
    internalMetrics: passThrough,
    webTelemetry: passThrough,
    legacyRoot: passThrough,
    webfinger: routerWith('/webfinger', 'federation'),
    apRateLimiter: passThrough,
    actor: routerWith('/users/alice', 'actor'),
    federationContent: passThrough,
    atprotoBridge: passThrough,
    atprotoBridgeMeta: passThrough,
    wellKnownBridge: passThrough,
    media: passThrough,
    crowdSourceWebhook: passThrough,
    mcpOAuth: passThrough,
    webShell: routerWith('/@alice', 'web-shell'),
    apexProxy,
    publicApi: routerWith('/feed', 'api'),
    requireAuth: passThrough,
    authenticatedApi: passThrough,
  };
}

function createDependencies(): CreateAppDependencies {
  return {
    frontendUrl: 'https://mention.earth',
    federationDomain: 'mention.earth',
    isAllowedOrigin: () => true,
    isApexHost: (req) => req.headers.host === 'mention.earth',
    isApexWebPlaneRequest: (req) => req.headers.host === 'mention.earth',
    countLocalPosts: vi.fn().mockResolvedValue(0),
    logger: { debug: vi.fn() },
    middleware: {
      requestObservability: passThrough,
      rateLimiter: passThrough,
      bruteForceProtection: passThrough,
      globalErrorHandler: errorHandler,
    },
    routes: createRoutes(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createApp', () => {
  it('imports and creates the app without connections, timers, sockets, or listen', async () => {
    vi.resetModules();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const listenSpy = vi.spyOn(express.application, 'listen');
    const database = await import('../utils/database.js');
    const redis = await import('../utils/redis.js');
    const mongoConnectSpy = vi.spyOn(database, 'connectToDatabase');
    const redisClientSpy = vi.spyOn(redis, 'getRedisClient');
    const { createApp } = await import('../app.js');

    const deps = createDependencies();
    const app = createApp(deps);

    expect(app).toBeDefined();
    expect(app.get('io')).toBeUndefined();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(mongoConnectSpy).not.toHaveBeenCalled();
    expect(redisClientSpy).not.toHaveBeenCalled();
    expect(deps.countLocalPosts).not.toHaveBeenCalled();
  });

  it('serves health without runtime bootstrap', async () => {
    const { createApp } = await import('../app.js');
    await request(createApp(createDependencies()))
      .get('/health/live')
      .expect(200, 'live');
  });

  it('keeps federation and web shell ahead of the apex proxy and API routers', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp(createDependencies());

    await request(app)
      .get('/.well-known/webfinger')
      .set('Host', 'mention.earth')
      .expect(200, 'federation');
    await request(app)
      .get('/ap/users/alice')
      .set('Host', 'mention.earth')
      .expect(200, 'actor');
    await request(app)
      .get('/@alice')
      .set('Host', 'mention.earth')
      .expect(200, 'web-shell');
    await request(app)
      .get('/feed')
      .set('Host', 'mention.earth')
      .expect(200, 'apex');
    await request(app)
      .get('/feed')
      .set('Host', 'api.mention.earth')
      .expect(200, 'api');
  });

  it('applies bounded CORS and handles preflight before application routes', async () => {
    const { createApp } = await import('../app.js');

    const allowed = createDependencies();
    await request(createApp(allowed))
      .get('/feed')
      .set('Host', 'api.mention.earth')
      .set('Origin', 'https://client.example')
      .expect('Access-Control-Allow-Origin', 'https://client.example')
      .expect('Access-Control-Allow-Credentials', 'true')
      .expect('Cache-Control', /no-store/)
      .expect(200);

    const fallback = createDependencies();
    fallback.isAllowedOrigin = () => false;
    await request(createApp(fallback))
      .get('/feed')
      .set('Host', 'api.mention.earth')
      .set('Origin', 'https://untrusted.example')
      .expect('Access-Control-Allow-Origin', 'https://mention.earth')
      .expect(200);

    const noFallback = createDependencies();
    noFallback.isAllowedOrigin = () => false;
    delete noFallback.frontendUrl;
    const noFallbackResponse = await request(createApp(noFallback))
      .get('/feed')
      .set('Host', 'api.mention.earth')
      .set('Origin', 'https://untrusted.example')
      .expect(200);
    expect(noFallbackResponse.headers['access-control-allow-origin']).toBeUndefined();

    await request(createApp(createDependencies()))
      .options('/anything')
      .set('Host', 'api.mention.earth')
      .expect('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
      .expect(204);
  });

  it('does not attach API no-store headers to federation or apex web-plane requests', async () => {
    const { createApp } = await import('../app.js');
    const app = createApp(createDependencies());

    for (const path of [
      '/ap/users/alice',
      '/.well-known/webfinger',
      '/xrpc/unknown',
      '/ap-bridge/unknown',
    ]) {
      const response = await request(app)
        .get(path)
        .set('Host', 'api.mention.earth');
      expect(response.headers['cache-control'] ?? '').not.toContain('no-store');
    }

    const apex = await request(app)
      .get('/feed')
      .set('Host', 'mention.earth')
      .expect(200);
    expect(apex.headers['cache-control'] ?? '').not.toContain('no-store');
  });

  it('bypasses API throttles only for the apex web plane', async () => {
    const { createApp } = await import('../app.js');
    const deps = createDependencies();
    const rateLimiter = vi.fn<RequestHandler>(passThrough);
    const bruteForceProtection = vi.fn<RequestHandler>(passThrough);
    deps.middleware.rateLimiter = rateLimiter;
    deps.middleware.bruteForceProtection = bruteForceProtection;
    const app = createApp(deps);

    await request(app).get('/feed').set('Host', 'mention.earth').expect(200, 'apex');
    expect(rateLimiter).not.toHaveBeenCalled();
    expect(bruteForceProtection).not.toHaveBeenCalled();

    await request(app).get('/feed').set('Host', 'api.mention.earth').expect(200, 'api');
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(bruteForceProtection).toHaveBeenCalledTimes(1);
  });

  /**
   * The CrowdSource webhook signature covers the bytes that arrived. `express.json`
   * consumes the stream and those bytes stop existing, so the mount ORDER is part of
   * the security property rather than a tidiness preference — and it is the kind of
   * thing a later refactor moves without noticing. This asserts what the middleware
   * actually observes: an unconsumed stream and no parsed body.
   */
  it('mounts the CrowdSource webhook ahead of the JSON body parser', async () => {
    const { createApp } = await import('../app.js');
    const deps = createDependencies();

    const webhook = express.Router();
    webhook.post('/crowdsource', (req, res) => {
      /**
       * Answered from SYNCHRONOUS facts first, deliberately.
       *
       * The obvious version of this test waits for `req.on('end')` — but when a parser
       * ran first the stream is already ended, `end` never fires again, and the failure
       * arrives as a five-second timeout that names nothing. A timeout is also the kind
       * of failure a later reader "fixes" by raising the limit. `req.body` and
       * `readableEnded` are both observable immediately and say exactly what happened.
       */
      const alreadyConsumed = req.readableEnded || req.body !== undefined;
      if (alreadyConsumed) {
        res.json({ parsedBodyType: typeof req.body, readableEnded: req.readableEnded });
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.json({
          parsedBodyType: typeof req.body,
          readableEnded: false,
          bytes: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    deps.routes.crowdSourceWebhook = webhook;

    const app = createApp(deps);

    await request(app)
      .post('/webhooks/crowdsource')
      .set('Host', 'api.mention.earth')
      .set('Content-Type', 'application/json')
      .send('{"id":"evt_1"}')
      .expect(200, {
        // `undefined` is what proves no parser ran; an `object` here means
        // `express.json` consumed and replaced the signed bytes.
        parsedBodyType: 'undefined',
        readableEnded: false,
        bytes: '{"id":"evt_1"}',
      });
  });

  it('captures raw JSON, reconstructs filter queries and handles nodeinfo failures', async () => {
    const { createApp } = await import('../app.js');
    const deps = createDependencies();
    const publicApi = express.Router();
    publicApi.post('/raw', (req, res) => {
      res.json({
        rawBody: (req as express.Request & { rawBody?: string }).rawBody,
      });
    });
    publicApi.get('/filters', (req, res) => {
      res.json(req.query);
    });
    deps.routes.publicApi = publicApi;
    const app = createApp(deps);

    await request(app)
      .post('/raw')
      .set('Host', 'api.mention.earth')
      .send({ hello: 'world' })
      .expect(200, { rawBody: '{"hello":"world"}' });

    const filters = await request(app)
      .get('/filters')
      .query({
        'filters[language]': 'es',
        'filters[visibility]': 'public',
        untouched: 'yes',
      })
      .set('Host', 'api.mention.earth')
      .expect(200);
    expect(filters.body.filters).toEqual({
      language: 'es',
      visibility: 'public',
    });
    expect(filters.body.untouched).toBe('yes');

    await request(app)
      .get('/.well-known/nodeinfo')
      .set('Host', 'api.mention.earth')
      .expect(200)
      .expect(({ body }) => {
        expect(body.links[0].href).toBe('https://mention.earth/nodeinfo/2.0');
      });

    await request(app)
      .get('/nodeinfo/2.0')
      .set('Host', 'api.mention.earth')
      .expect(200)
      .expect(({ body }) => {
        expect(body.usage.localPosts).toBe(0);
      });

    deps.countLocalPosts = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const failedNodeinfo = createApp(deps);
    await request(failedNodeinfo)
      .get('/nodeinfo/2.0')
      .set('Host', 'api.mention.earth')
      .expect(200)
      .expect(({ body }) => {
        expect(body.usage.localPosts).toBe(0);
      });
    expect(deps.logger.debug).toHaveBeenCalledWith(
      'nodeinfo: failed to estimate post count, defaulting to 0',
      expect.any(Error),
    );
  });

  it('compresses ordinary large responses but honors both opt-out paths', async () => {
    const { createApp } = await import('../app.js');
    const deps = createDependencies();
    const publicApi = express.Router();
    const largeBody = 'x'.repeat(4096);
    publicApi.get('/large', (_req, res) => res.type('text/plain').send(largeBody));
    publicApi.get('/media/proxy', (_req, res) => res.type('text/plain').send(largeBody));
    deps.routes.publicApi = publicApi;
    const app = createApp(deps);

    await request(app)
      .get('/large')
      .set('Host', 'api.mention.earth')
      .set('Accept-Encoding', 'gzip')
      .expect('Content-Encoding', 'gzip')
      .expect(200);

    const explicitlyDisabled = await request(app)
      .get('/large')
      .set('Host', 'api.mention.earth')
      .set('Accept-Encoding', 'gzip')
      .set('x-no-compression', '1')
      .expect(200);
    expect(explicitlyDisabled.headers['content-encoding']).toBeUndefined();

    const mediaProxy = await request(app)
      .get('/media/proxy')
      .set('Host', 'api.mention.earth')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(mediaProxy.headers['content-encoding']).toBeUndefined();
  });
});
