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
    oxyAccountEvents: passThrough,
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
  it('observes public, federation and rejected private requests without a dashboard connection', async () => {
    const { createApp } = await import('../app');
    const deps = createDependencies();
    const responses: Array<{ path: string; status: number }> = [];
    deps.middleware.activity = (req, res, next) => {
      const path = req.path;
      res.once('finish', () => responses.push({ path, status: res.statusCode }));
      next();
    };
    deps.routes.requireAuth = (_req, res) => { res.sendStatus(401); };
    const app = createApp(deps);
    await request(app).get('/feed').set('Host', 'api.mention.earth').expect(200);
    await request(app).get('/.well-known/webfinger').set('Host', 'mention.earth').expect(200);
    await request(app).get('/private-request').set('Host', 'api.mention.earth').expect(401);
    expect(responses).toEqual([
      { path: '/feed', status: 200 },
      { path: '/.well-known/webfinger', status: 200 },
      { path: '/private-request', status: 401 },
    ]);
  });

  it('imports and creates the app without connections, timers, sockets, or listen', async () => {
    vi.resetModules();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const listenSpy = vi.spyOn(express.application, 'listen');
    // The store this asserts about is POSTGRES. It used to be
    // `utils/database.connectToDatabase`, and that module is gone with the Mongo
    // migration one-shot — but the PROPERTY is not Mongo-specific and survives
    // the port: constructing the app must open nothing, whichever store the app
    // has. Re-pointing it keeps the assertion; deleting it would have quietly
    // dropped the guard along with its subject.
    const postgres = await import('../db/postgres');
    const redis = await import('../utils/redis');
    const storeConnectSpy = vi.spyOn(postgres, 'connectPostgres');
    const redisClientSpy = vi.spyOn(redis, 'getRedisClient');
    const { createApp } = await import('../app');

    const deps = createDependencies();
    const app = createApp(deps);

    expect(app).toBeDefined();
    expect(app.get('io')).toBeUndefined();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(storeConnectSpy).not.toHaveBeenCalled();
    expect(redisClientSpy).not.toHaveBeenCalled();
    expect(deps.countLocalPosts).not.toHaveBeenCalled();
  });

  it('serves health without runtime bootstrap', async () => {
    const { createApp } = await import('../app');
    await request(createApp(createDependencies()))
      .get('/health/live')
      .expect(200, 'live');
  });

  it('keeps federation and web shell ahead of the apex proxy and API routers', async () => {
    const { createApp } = await import('../app');
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
    const { createApp } = await import('../app');

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
    const { createApp } = await import('../app');
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
    const { createApp } = await import('../app');
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
    const { createApp } = await import('../app');
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

  it('mounts the Oxy account-event webhook ahead of every body parser and auth layer', async () => {
    const { createApp } = await import('../app');
    const deps = createDependencies();
    const webhook = express.Router();
    webhook.post('/oxy/account-events', (req, res) => {
      // Synchronous facts only, for the reason the CrowdSource test above gives.
      res.json({ parsedBodyType: typeof req.body, readableEnded: req.readableEnded });
    });
    deps.routes.oxyAccountEvents = webhook;
    const requireAuth = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(401).end();
    });
    deps.routes.requireAuth = requireAuth;

    const app = createApp(deps);

    await request(app)
      .post('/webhooks/oxy/account-events')
      .set('Host', 'api.mention.earth')
      .set('Content-Type', 'application/secevent+jwt')
      .send('a.b.c')
      .expect(200, { parsedBodyType: 'undefined', readableEnded: false });
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it('captures raw JSON, reconstructs filter queries and handles nodeinfo failures', async () => {
    const { createApp } = await import('../app');
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
    const { createApp } = await import('../app');
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

  it('states a referrer policy that still identifies this origin', async () => {
    // helmet's default is `no-referrer`, which sends nothing at all. That is not
    // a privacy win worth its cost here: the path never travels under either
    // policy, so the only difference is whether a third party learns the reader
    // came from Mention. Sending nothing made every outbound link look like
    // direct traffic to the site receiving it, and made YouTube refuse to embed
    // (error 153, ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER).
    //
    // Pinned because the failure mode is silent: delete the option in `app.ts`
    // and helmet quietly restores `no-referrer` with nothing to notice.
    // Deliberately NOT `/health/live`: the health router is mounted ahead of
    // `createOxySecurityHeaders`, so it carries no security headers at all and
    // would assert nothing. Asserting `no-referrer` is absent is not enough
    // either — an endpoint outside the middleware satisfies that too.
    const { createApp } = await import('../app');
    const deps = createDependencies();
    const publicApi = express.Router();
    publicApi.get('/probe', (_req, res) => res.type('text/plain').send('probe'));
    deps.routes.publicApi = publicApi;

    const response = await request(createApp(deps))
      .get('/probe')
      .set('Host', 'api.mention.earth')
      .expect(200);

    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('allows the embedded Alia client to reach only its exact API origin', async () => {
    const { createApp } = await import('../app');
    const deps = createDependencies();
    const publicApi = express.Router();
    publicApi.get('/probe', (_req, res) => res.type('text/plain').send('probe'));
    deps.routes.publicApi = publicApi;

    const response = await request(createApp(deps))
      .get('/probe')
      .set('Host', 'api.mention.earth')
      .expect(200);

    const policy = response.headers['content-security-policy'];
    expect(policy).toBeTypeOf('string');
    const connectSources = String(policy)
      .split(';')
      .find((directive) => directive.startsWith('connect-src '))
      ?.split(/\s+/)
      .slice(1);

    expect(connectSources).toContain('https://api.alia.onl');
    expect(connectSources).not.toContain('https:');
  });
});

describe('managed instance discovery and branding', () => {
  it('publishes only this process deployment and uses its own API in CSP', async () => {
    const { createApp } = await import('../app');
    const { managedMentionDeploymentSchema, publicDeploymentInfo } = await import('@mention/shared-types/deployment');
    const { default: example } = await import('../../../shared-types/__tests__/fixtures/managed-deployment.json');
    const deployment = managedMentionDeploymentSchema.parse(example);
    const dependencies = createDependencies();
    dependencies.deployment = publicDeploymentInfo(deployment);
    dependencies.federationDomain = 'social.alpha.example';
    dependencies.frontendUrl = deployment.publicBaseUrl;
    const app = createApp(dependencies);
    const discovery = await request(app).get('/.well-known/mention-instance')
      .set('Host', 'api.beta.example').set('X-Forwarded-Host', 'social.beta.example')
      .set('X-Tenant-Id', '22222222-2222-4222-8222-222222222222').expect(200);
    expect(discovery.body).toEqual(publicDeploymentInfo(deployment));
    expect(discovery.text).not.toContain('admin-alpha');
    expect(discovery.text).not.toContain('member-alpha');
    expect(discovery.text).not.toContain(deployment.shellBaseUrl);
    expect(discovery.headers.vary).toContain('Origin');
    expect(discovery.headers['content-security-policy']).toContain(deployment.apiBaseUrl);
    expect(discovery.headers['content-security-policy']).toContain('wss://api.alpha.example');
    expect(discovery.headers['content-security-policy']).not.toContain('api.beta.example');

    const manifest = await request(app).get('/manifest.json').expect(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.body.name).toBe(deployment.branding.name);
    expect(manifest.body.theme_color).toBe(deployment.branding.accentColor);
    expect(manifest.body.icons[0].src).toBe(deployment.branding.iconUrl);
    expect(manifest.body.share_target.action).toBe('/compose');
    const nodeinfo = await request(app).get('/nodeinfo/2.0').expect(200);
    expect(nodeinfo.body.openRegistrations).toBe(false);
    expect(nodeinfo.body.software.version).toBe(deployment.release.version);
    expect(nodeinfo.body.metadata.sourceUrl).toBe(deployment.release.sourceUrl);
    const pointer = await request(app).get('/.well-known/nodeinfo').expect(200);
    expect(pointer.body.links[0].href).toBe('https://social.alpha.example/nodeinfo/2.0');
  });

  /**
   * `iconUrl` is OPTIONAL on the branding schema, so a real deployment can omit
   * it — and the manifest has to stay valid when it does. `icons: []` is the
   * honest answer: a manifest with no icons installs with the browser's own
   * fallback, whereas an entry whose `src` is `undefined` serialises to a
   * malformed icon that a user agent rejects, taking the whole manifest with it.
   */
  it('serves an installable manifest for a deployment that ships no icon', async () => {
    const { createApp } = await import('../app');
    const { managedMentionDeploymentSchema, publicDeploymentInfo } = await import('@mention/shared-types/deployment');
    const { default: example } = await import('../../../shared-types/__tests__/fixtures/managed-deployment.json');
    const { iconUrl: _omitted, ...brandingWithoutIcon } = example.branding;
    const deployment = managedMentionDeploymentSchema.parse({ ...example, branding: brandingWithoutIcon });
    expect(deployment.branding.iconUrl).toBeUndefined();

    const dependencies = createDependencies();
    dependencies.deployment = publicDeploymentInfo(deployment);
    dependencies.frontendUrl = deployment.publicBaseUrl;

    const manifest = await request(createApp(dependencies)).get('/manifest.json').expect(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.body.icons).toEqual([]);
    expect(manifest.body.name).toBe(deployment.branding.name);
    expect(manifest.body.theme_color).toBe(deployment.branding.accentColor);
  });
});
