/**
 * mention.org is the same service as mention.earth (docs/mention-org-domain-move.md),
 * so every well-known document must answer there byte for byte as it does on the
 * apex: the App Links / Universal Links documents, Apple Pay's file, NodeInfo,
 * host-meta and WebFinger. None of them may depend on the request host, and none
 * may fall through to the SPA proxy on the alias.
 *
 * WebFinger additionally accepts `acct:<user>@mention.org` and resolves it to the
 * SAME local actor as `acct:<user>@mention.earth`: the subject and every link stay
 * on mention.earth, which is how a remote server learns the canonical account.
 */
import type express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, mock } from 'bun:test';
import { INSTANCE_ACTOR_USERNAME, createUrlBuilders } from '@oxy.so/federation';
import { createWebfingerRouter } from '@oxy.so/federation/node';
import { createApp, type CreateAppDependencies } from '../app';
import type { AppRoutes } from '../appRoutes';
import {
  canonicalWebfingerResource,
  withWebfingerAliasDomains,
} from '../connectors/activitypub/webfingerAliasDomains';
import { isApexHost, isApexWebPlaneRequest } from '../middleware/apexFrontendProxy';

const DOMAIN = 'mention.earth';
const ALIAS = 'mention.org';

const passThrough: RequestHandler = (_req, _res, next) => next();
const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(500).json({ error: 'test error' });
};

/** The real engine WebFinger router over a directory holding one public user, alice. */
function webfinger(aliasDomains: readonly string[]) {
  const engine = createWebfingerRouter({
    domain: DOMAIN,
    federationEnabled: true,
    httpCacheTtlSeconds: 0,
    urls: createUrlBuilders(DOMAIN, DOMAIN),
    resolveUser: async (username) => (username === 'alice' ? { id: 'u1' } : null),
    consent: {
      isSharingEnabledFromUser: () => true,
      getSharingStateByUsername: async (username) =>
        username === 'alice' ? 'enabled' : 'unknown-user',
    },
    cache: { get: async () => null, set: () => {} },
    logger: { error: () => {} },
  });
  return withWebfingerAliasDomains(engine, { domain: DOMAIN, aliasDomains });
}

function createTestApp(aliasDomains: readonly string[] = [ALIAS]) {
  // Stands in for the real apex proxy, keyed on the REAL apex predicate: any
  // request it reaches on either web host comes back as the SPA shell.
  const apexProxy = mock<RequestHandler>((req, res, next) => {
    if (!isApexHost(req)) return next();
    res.status(200).type('html').send('<!doctype html><div id="root"></div>');
  });
  const routes: AppRoutes = {
    health: passThrough,
    webTelemetry: passThrough,
    legacyRoot: passThrough,
    webfinger: webfinger(aliasDomains),
    apRateLimiter: passThrough,
    actor: passThrough,
    federationContent: passThrough,
    media: passThrough,
    crowdSourceWebhook: passThrough,
    oxyAccountEvents: passThrough,
    oxyFileEvents: passThrough,
    mcpOAuth: passThrough,
    webShell: passThrough,
    apexProxy,
    publicApi: passThrough,
    requireAuth: passThrough,
    authenticatedApi: passThrough,
  };
  const deps: CreateAppDependencies = {
    frontendUrl: `https://${DOMAIN}`,
    federationDomain: DOMAIN,
    isAllowedOrigin: () => true,
    isApexHost,
    isApexWebPlaneRequest,
    getNodeinfoStatistics: mock().mockRejectedValue(new Error('none')),
    getNodeinfoLocalUsers: mock().mockRejectedValue(new Error('none')),
    logger: { debug: mock() },
    middleware: {
      requestObservability: passThrough,
      contentAccessScope: passThrough,
      rateLimiter: passThrough,
      bruteForceProtection: passThrough,
      globalErrorHandler: errorHandler,
    },
    routes,
  };
  return { app: createApp(deps), apexProxy };
}

/** What a verifier or a remote server sees: status, type, cache policy and the body bytes. */
async function answer(app: express.Express, path: string, host: Record<string, string>) {
  let call = request(app).get(path);
  for (const [name, value] of Object.entries(host)) call = call.set(name, value);
  const res = await call;
  return {
    status: res.status,
    contentType: res.headers['content-type'],
    cacheControl: res.headers['cache-control'],
    location: res.headers.location,
    body: res.text,
  };
}

const WELL_KNOWN_PATHS = [
  '/.well-known/assetlinks.json',
  '/.well-known/apple-app-site-association',
  '/.well-known/apple-developer-merchantid-domain-association',
  '/.well-known/nodeinfo',
  '/nodeinfo/2.0',
  '/.well-known/host-meta',
  '/.well-known/host-meta.json',
  `/.well-known/webfinger?resource=acct:alice@${DOMAIN}`,
  `/.well-known/webfinger?resource=acct:nobody@${DOMAIN}`,
  '/.well-known/unknown-document',
];

describe('well-known documents on the mention.org alias host', () => {
  it.each(WELL_KNOWN_PATHS)(
    '%s answers identically on mention.org and mention.earth',
    async (path) => {
      const { app, apexProxy } = createTestApp();
      const apex = await answer(app, path, { Host: DOMAIN });
      expect(apex.status).not.toBe(500);

      for (const host of [
        { Host: ALIAS },
        // The ALB path: Host rewritten, the client's host forwarded.
        { Host: 'api.mention.earth', 'X-Forwarded-Host': ALIAS },
        { Host: 'api.mention.org' },
      ]) {
        expect(await answer(app, path, host)).toEqual(apex);
      }
      // Never the SPA shell, on any host.
      expect(apexProxy).not.toHaveBeenCalled();
    },
  );

  it('serves the canonical domain in host-meta and NodeInfo on the alias', async () => {
    const { app } = createTestApp();
    const hostMeta = await request(app).get('/.well-known/host-meta.json').set('Host', ALIAS);
    expect(hostMeta.body.links[0].template).toBe(
      `https://${DOMAIN}/.well-known/webfinger?resource={uri}`,
    );
    const nodeinfo = await request(app).get('/.well-known/nodeinfo').set('Host', ALIAS);
    expect(nodeinfo.body.links[0].href).toBe(`https://${DOMAIN}/nodeinfo/2.0`);
  });
});

describe('WebFinger acct: on the alias domain', () => {
  it('resolves acct:alice@mention.org to the same actor, subject and links as @mention.earth', async () => {
    const { app } = createTestApp();
    const canonical = await request(app)
      .get(`/.well-known/webfinger?resource=acct:alice@${DOMAIN}`)
      .set('Host', DOMAIN)
      .expect(200);
    expect(canonical.body).toEqual({
      subject: `acct:alice@${DOMAIN}`,
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: `https://${DOMAIN}/ap/users/alice`,
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `https://${DOMAIN}/@alice`,
        },
      ],
    });

    for (const resource of [
      `acct:alice@${ALIAS}`,
      'acct:alice@MENTION.ORG',
      // The engine's one host rule (`isSameFederationHost`) drops a leading `www.`.
      `acct:alice@www.${ALIAS}`,
    ]) {
      for (const host of [DOMAIN, ALIAS]) {
        const res = await request(app)
          .get('/.well-known/webfinger')
          .query({ resource })
          .set('Host', host)
          .expect(200);
        expect(res.headers['content-type']).toBe(canonical.headers['content-type']);
        expect(res.body).toEqual(canonical.body);
      }
    }
  });

  it('answers the instance actor on the alias with its canonical identity', async () => {
    const { app } = createTestApp();
    const canonical = await request(app)
      .get(`/.well-known/webfinger?resource=acct:${INSTANCE_ACTOR_USERNAME}@${DOMAIN}`)
      .expect(200);
    const alias = await request(app)
      .get(`/.well-known/webfinger?resource=acct:${INSTANCE_ACTOR_USERNAME}@${ALIAS}`)
      .expect(200);
    expect(alias.body).toEqual(canonical.body);
    expect(alias.body.subject).toBe(`acct:${INSTANCE_ACTOR_USERNAME}@${DOMAIN}`);
  });

  it('keeps refusing every other domain, and an unknown user on the alias', async () => {
    const { app } = createTestApp();
    for (const domain of [
      'api.mention.org',
      'mention.org.example',
      'elsewhere.example',
      `alice@${ALIAS}`,
    ]) {
      await request(app)
        .get(`/.well-known/webfinger?resource=acct:alice@${domain}`)
        .set('Host', ALIAS)
        .expect(404, { error: 'Unknown domain' });
    }
    await request(app)
      .get(`/.well-known/webfinger?resource=acct:nobody@${ALIAS}`)
      .set('Host', ALIAS)
      .expect(404, { error: 'User not found' });
    await request(app).get(`/.well-known/webfinger?resource=https://${ALIAS}/@alice`).expect(400);
  });

  it('refuses the alias domain when no alias is configured', async () => {
    const { app } = createTestApp([]);
    await request(app)
      .get(`/.well-known/webfinger?resource=acct:alice@${ALIAS}`)
      .expect(404, { error: 'Unknown domain' });
  });

  it('rewrites only an acct: resource on an alias domain', () => {
    const aliases = [ALIAS];
    expect(canonicalWebfingerResource(`acct:alice@${ALIAS}`, DOMAIN, aliases)).toBe(
      `acct:alice@${DOMAIN}`,
    );
    expect(canonicalWebfingerResource(` acct:alice@${ALIAS}`, DOMAIN, aliases)).toBeUndefined();
    expect(canonicalWebfingerResource(`acct:alice@${DOMAIN}`, DOMAIN, aliases)).toBeUndefined();
    expect(canonicalWebfingerResource('acct:alice', DOMAIN, aliases)).toBeUndefined();
    expect(canonicalWebfingerResource(['acct:alice@mention.org'], DOMAIN, aliases)).toBeUndefined();
    expect(canonicalWebfingerResource(undefined, DOMAIN, aliases)).toBeUndefined();
  });
});
