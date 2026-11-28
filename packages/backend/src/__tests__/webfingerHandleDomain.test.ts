/**
 * WebFinger for accounts switched to the handle domain (`FEDERATION_HANDLE_DOMAIN`,
 * docs/mention-org-domain-move.md Phase 3), through the real engine router, the
 * real alias wrapper and the real app, on every host.
 *
 * A switched account answers `subject: acct:u@mention.org` for every resource
 * that names it, with its `self` link (the actor id) still on mention.earth. An
 * unswitched account, and every account while the policy is off, answers byte for
 * byte as before. The JRD cache only ever holds the engine's own answer.
 */
import type express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, mock } from 'bun:test';
import { INSTANCE_ACTOR_USERNAME, createUrlBuilders } from '@oxy.so/federation';
import { createWebfingerRouter, type WebfingerJrd } from '@oxy.so/federation/node';
import { createApp, type CreateAppDependencies } from '../app';
import type { AppRoutes } from '../appRoutes';
import {
  createFederationHandlePolicy,
  type FederationHandlePolicy,
} from '../connectors/activitypub/federationHandleDomain';
import { withWebfingerAliasDomains } from '../connectors/activitypub/webfingerAliasDomains';
import {
  actorUrlUsername,
  switchedWebfingerJrd,
  switchedWebfingerTarget,
  withWebfingerHandleDomain,
} from '../connectors/activitypub/webfingerHandleDomain';
import { isApexHost, isApexWebPlaneRequest } from '../middleware/apexFrontendProxy';

const EARTH = 'mention.earth';
const ORG = 'mention.org';
const WEB_ORIGIN = 'https://mention.org';
const urls = createUrlBuilders(EARTH, EARTH);

const PUBLIC_USERS = new Set(['alice', 'bob', 'hidden']);
const ERASED_USERS = new Set(['gone']);

const passThrough: RequestHandler = (_req, _res, next) => next();
const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(500).json({ error: 'test error' });
};

function engineRouter(cache: Map<string, WebfingerJrd>) {
  return createWebfingerRouter({
    domain: EARTH,
    federationEnabled: true,
    httpCacheTtlSeconds: 0,
    urls,
    resolveUser: async (username) => (PUBLIC_USERS.has(username) ? { id: username } : null),
    consent: {
      isSharingEnabledFromUser: () => true,
      getSharingStateByUsername: async (username) => {
        if (username === 'hidden') return 'disabled';
        return PUBLIC_USERS.has(username) ? 'enabled' : 'unknown-user';
      },
    },
    isActorGone: async (username) => ERASED_USERS.has(username),
    cache: {
      get: async (username) => cache.get(username) ?? null,
      set: (username, jrd) => {
        // What Redis stores: the serialized document.
        cache.set(username, JSON.parse(JSON.stringify(jrd)));
      },
    },
    logger: { error: () => {} },
  });
}

/** The production composition (`engine.routes.ts`): handle wrapper, alias wrapper, engine. */
function webfinger(policy: FederationHandlePolicy, cache = new Map<string, WebfingerJrd>()) {
  return withWebfingerHandleDomain(
    withWebfingerAliasDomains(engineRouter(cache), { domain: EARTH, aliasDomains: [ORG] }),
    { policy, urls, webOrigin: WEB_ORIGIN },
  );
}

function createTestApp(webfingerRouter: RequestHandler) {
  const routes: AppRoutes = {
    health: passThrough,
    webTelemetry: passThrough,
    legacyRoot: passThrough,
    webfinger: webfingerRouter,
    apRateLimiter: passThrough,
    actor: passThrough,
    federationContent: passThrough,
    media: passThrough,
    crowdSourceWebhook: passThrough,
    oxyAccountEvents: passThrough,
    oxyFileEvents: passThrough,
    mcpOAuth: passThrough,
    webShell: passThrough,
    apexProxy: passThrough,
    publicApi: passThrough,
    requireAuth: passThrough,
    authenticatedApi: passThrough,
  };
  const deps: CreateAppDependencies = {
    frontendUrl: `https://${EARTH}`,
    federationDomain: EARTH,
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
  return createApp(deps);
}

const OFF = createFederationHandlePolicy({ federationDomain: EARTH });
const QA = createFederationHandlePolicy({
  federationDomain: EARTH,
  handleDomain: ORG,
  accounts: ['alice', 'hidden', 'gone'],
});
const ALL = createFederationHandlePolicy({
  federationDomain: EARTH,
  handleDomain: ORG,
  accounts: 'all',
});

const HOSTS: Array<Record<string, string>> = [
  { Host: EARTH },
  { Host: ORG },
  // The ALB path: Host rewritten, the client's host forwarded.
  { Host: 'api.mention.earth', 'X-Forwarded-Host': ORG },
  { Host: 'api.mention.org' },
];

async function finger(app: express.Express, resource: string, host: Record<string, string>) {
  let call = request(app).get('/.well-known/webfinger').query({ resource });
  for (const [name, value] of Object.entries(host)) call = call.set(name, value);
  const res = await call;
  return {
    status: res.status,
    contentType: res.headers['content-type'],
    cacheControl: res.headers['cache-control'],
    body: res.text,
  };
}

/** The switched answer, in the exact key order it is served. */
function switchedJrd(username: string) {
  return {
    subject: `acct:${username}@${ORG}`,
    aliases: [
      `https://${EARTH}/ap/users/${username}`,
      `${WEB_ORIGIN}/@${username}`,
      `acct:${username}@${EARTH}`,
    ],
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `https://${EARTH}/ap/users/${username}`,
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${WEB_ORIGIN}/@${username}`,
      },
    ],
  };
}

describe('the handle domain switched off (the default)', () => {
  it('is the wrapped router itself, so nothing can differ', () => {
    const inner = withWebfingerAliasDomains(engineRouter(new Map()), {
      domain: EARTH,
      aliasDomains: [ORG],
    });
    expect(withWebfingerHandleDomain(inner, { policy: OFF, urls, webOrigin: WEB_ORIGIN })).toBe(
      inner,
    );
    const handleDomainOnly = createFederationHandlePolicy({
      federationDomain: EARTH,
      handleDomain: ORG,
      accounts: [],
    });
    expect(
      withWebfingerHandleDomain(inner, { policy: handleDomainOnly, urls, webOrigin: WEB_ORIGIN }),
    ).toBe(inner);
  });
});

describe('a switched account', () => {
  const resources = [
    `acct:alice@${ORG}`,
    `acct:alice@${EARTH}`,
    'acct:ALICE@MENTION.ORG',
    `acct:alice@www.${ORG}`,
    `https://${EARTH}/ap/users/alice`,
    `https://${EARTH}/ap/users/Alice`,
  ];

  it.each(resources)('answers %s on every host with the mention.org handle', async (resource) => {
    const off = createTestApp(webfinger(OFF));
    const app = createTestApp(webfinger(QA));
    const today = await finger(off, `acct:alice@${EARTH}`, { Host: EARTH });
    for (const host of HOSTS) {
      const answer = await finger(app, resource, host);
      expect(answer.status).toBe(200);
      expect(answer.body).toBe(JSON.stringify(switchedJrd('alice')));
      // Same transport as today's answer: JRD content type, no-store.
      expect(answer.contentType).toBe(today.contentType);
      expect(answer.cacheControl).toBe(today.cacheControl);
    }
  });

  it('keeps the self link exactly the actor id Mastodon holds', async () => {
    const app = createTestApp(webfinger(QA));
    const res = await request(app)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:alice@${ORG}` })
      .expect(200);
    const self = res.body.links.find((link: { rel: string }) => link.rel === 'self');
    expect(self.href).toBe(urls.actor('alice'));
  });

  it('answers 410 for an erased account, on every resource form and host', async () => {
    const off = createTestApp(webfinger(OFF));
    const app = createTestApp(webfinger(QA));
    const today = await finger(off, `acct:gone@${EARTH}`, { Host: EARTH });
    expect(today.status).toBe(410);
    for (const resource of [`acct:gone@${ORG}`, `acct:gone@${EARTH}`, urls.actor('gone')]) {
      for (const host of HOSTS) {
        expect(await finger(app, resource, host)).toEqual(today);
      }
    }
  });

  it('answers 404 like today when the account stopped sharing', async () => {
    const off = createTestApp(webfinger(OFF));
    const app = createTestApp(webfinger(QA));
    for (const resource of [`acct:hidden@${ORG}`, `acct:hidden@${EARTH}`]) {
      const today = await finger(off, resource, { Host: EARTH });
      expect(today.status).toBe(404);
      expect(await finger(app, resource, { Host: ORG })).toEqual(today);
    }
    const viaActorUrl = await finger(app, urls.actor('hidden'), { Host: ORG });
    expect(viaActorUrl.status).toBe(404);
    expect(viaActorUrl.body).toBe(JSON.stringify({ error: 'User not found' }));
  });

  it('still refuses a domain that is not ours', async () => {
    const app = createTestApp(webfinger(QA));
    for (const domain of ['elsewhere.example', 'api.mention.org', 'mention.org.example']) {
      await request(app)
        .get('/.well-known/webfinger')
        .query({ resource: `acct:alice@${domain}` })
        .expect(404, { error: 'Unknown domain' });
    }
  });
});

describe('an unswitched account while others have switched', () => {
  it.each([
    `acct:bob@${EARTH}`,
    `acct:bob@${ORG}`,
    `acct:nobody@${ORG}`,
    urls.actor('bob'),
    `acct:${INSTANCE_ACTOR_USERNAME}@${EARTH}`,
    `acct:${INSTANCE_ACTOR_USERNAME}@${ORG}`,
    'acct:bob',
    'https://mention.org/@bob',
  ])('answers %s byte for byte as today', async (resource) => {
    const off = createTestApp(webfinger(OFF));
    const app = createTestApp(webfinger(QA));
    for (const host of HOSTS) {
      expect(await finger(app, resource, host)).toEqual(await finger(off, resource, host));
    }
  });

  it('never switches the instance actor, even for `all`', async () => {
    const off = createTestApp(webfinger(OFF));
    const app = createTestApp(webfinger(ALL));
    const resource = `acct:${INSTANCE_ACTOR_USERNAME}@${ORG}`;
    expect(await finger(app, resource, { Host: ORG })).toEqual(
      await finger(off, resource, { Host: ORG }),
    );
    const bob = await finger(app, `acct:bob@${EARTH}`, { Host: EARTH });
    expect(bob.body).toBe(JSON.stringify(switchedJrd('bob')));
  });

  it('leaves host-meta alone', async () => {
    const off = createTestApp(webfinger(OFF));
    const app = createTestApp(webfinger(ALL));
    for (const path of ['/.well-known/host-meta', '/.well-known/host-meta.json']) {
      const before = await request(off).get(path).set('Host', ORG);
      const after = await request(app).get(path).set('Host', ORG);
      expect(after.status).toBe(200);
      expect(after.text).toBe(before.text);
    }
  });
});

describe('the JRD cache', () => {
  it('stores the engine answer, never the switched one, and serves hits switched', async () => {
    const cache = new Map<string, WebfingerJrd>();
    const app = createTestApp(webfinger(QA, cache));
    const off = createTestApp(webfinger(OFF));
    const today = JSON.parse((await finger(off, `acct:alice@${EARTH}`, { Host: EARTH })).body);

    await request(app)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:alice@${ORG}` });
    expect(cache.get('alice')).toEqual(today);

    // A hit is switched on the way out too.
    const hit = await finger(app, `acct:alice@${EARTH}`, { Host: ORG });
    expect(hit.body).toBe(JSON.stringify(switchedJrd('alice')));
    expect(cache.get('alice')).toEqual(today);
  });

  it('is shared by switched and unswitched answers without mixing them', async () => {
    const cache = new Map<string, WebfingerJrd>();
    const switchedApp = createTestApp(webfinger(QA, cache));
    const offApp = createTestApp(webfinger(OFF, cache));

    await request(switchedApp)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:alice@${ORG}` });
    // The rollout list is emptied (rollback): the very next answer is today's, from the same cache.
    const rolledBack = await request(offApp)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:alice@${ORG}` })
      .expect(200);
    expect(rolledBack.body.subject).toBe(`acct:alice@${EARTH}`);
    expect(rolledBack.body).not.toHaveProperty('aliases');

    // And the other way: an entry written while off is served switched once switched.
    await request(offApp)
      .get('/.well-known/webfinger')
      .query({ resource: `acct:bob@${EARTH}` });
    const allApp = createTestApp(webfinger(ALL, cache));
    const switched = await finger(allApp, `acct:bob@${ORG}`, { Host: ORG });
    expect(switched.body).toBe(JSON.stringify(switchedJrd('bob')));
  });
});

describe('the pieces', () => {
  it('reads an actor URL only in the exact shape the actor id has', () => {
    expect(actorUrlUsername(`https://${EARTH}/ap/users/alice`, urls)).toBe('alice');
    expect(actorUrlUsername(`HTTPS://MENTION.EARTH/ap/users/Alice`, urls)).toBe('alice');
    for (const resource of [
      `https://${EARTH}/ap/users/`,
      `https://${EARTH}/ap/users/alice/`,
      `https://${EARTH}/ap/users/alice/inbox`,
      `https://${EARTH}/ap/users/alice?x=1`,
      `https://${EARTH}/ap/users/alice#main-key`,
      `https://${EARTH}/ap/users/a%6cice`,
      `http://${EARTH}/ap/users/alice`,
      `https://${ORG}/ap/users/alice`,
      `https://${EARTH}.evil.example/ap/users/alice`,
      `https://${EARTH}/@alice`,
    ]) {
      expect(actorUrlUsername(resource, urls)).toBeUndefined();
    }
  });

  it('names a switched target only, and rewrites only the actor URL form', () => {
    const options = { policy: QA, urls };
    expect(switchedWebfingerTarget(`acct:alice@${ORG}`, options)).toEqual({ username: 'alice' });
    expect(switchedWebfingerTarget(`acct:Alice@${EARTH}`, options)).toEqual({ username: 'alice' });
    expect(switchedWebfingerTarget(urls.actor('alice'), options)).toEqual({
      username: 'alice',
      rewrittenResource: `acct:alice@${EARTH}`,
    });
    for (const resource of [
      `acct:bob@${ORG}`,
      urls.actor('bob'),
      'acct:alice',
      ['acct:alice@mention.org'],
      undefined,
      42,
    ]) {
      expect(switchedWebfingerTarget(resource, options)).toBeUndefined();
    }
  });

  it('rewrites only the engine answer for exactly that account', () => {
    const options = { policy: QA, urls, webOrigin: WEB_ORIGIN };
    const engine = {
      subject: `acct:alice@${EARTH}`,
      links: [
        { rel: 'self', type: 'application/activity+json', href: urls.actor('alice') },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `https://${EARTH}/@alice`,
        },
      ],
    };
    expect(switchedWebfingerJrd(engine, 'alice', options)).toEqual(switchedJrd('alice'));
    expect(switchedWebfingerJrd(engine, 'bob', options)).toBeUndefined();
    expect(
      switchedWebfingerJrd({ ...engine, subject: `acct:alice@${ORG}` }, 'alice', options),
    ).toBeUndefined();
    expect(
      switchedWebfingerJrd(
        { ...engine, links: [{ rel: 'self', href: 'https://elsewhere.example/alice' }] },
        'alice',
        options,
      ),
    ).toBeUndefined();
    expect(switchedWebfingerJrd({ ...engine, links: [null] }, 'alice', options)).toBeUndefined();
    expect(switchedWebfingerJrd({ error: 'User not found' }, 'alice', options)).toBeUndefined();
    expect(switchedWebfingerJrd(null, 'alice', options)).toBeUndefined();
  });
});
