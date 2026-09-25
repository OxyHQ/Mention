/**
 * App Links / Universal Links gate (#1126).
 *
 * `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`
 * used to fall through to the apex SPA proxy and come back `200 text/html`, so
 * neither Android nor iOS could verify `mention.earth`. This pins three things:
 * the documents are JSON from the backend, an unknown well-known path is a 404
 * and never reaches the SPA, and the ids in the documents are the ids the app
 * is actually built with (`packages/frontend/app.config.js`).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { CreateAppDependencies } from '../app';
import { createApp } from '../app';
import type { AppRoutes } from '../appRoutes';
import {
  ANDROID_SIGNING_CERT_SHA256,
  APPLE_TEAM_ID,
  MENTION_APP_ID,
  createAppAssociationRouter,
} from '../routes/appAssociation.routes';

const APEX = 'mention.earth';

/** The React Native template debug keystore. Its private key is public. */
const RN_TEMPLATE_DEBUG_CERT =
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C';

interface ExpoIntentFilter {
  autoVerify?: boolean;
  data: Array<{ scheme: string; host: string }>;
}

function loadProductionAppConfig() {
  const require = createRequire(import.meta.url);
  const configPath = path.resolve(__dirname, '../../../frontend/app.config.js');
  const saved = { env: process.env.EXPO_PUBLIC_ENV, variant: process.env.APP_VARIANT };
  process.env.EXPO_PUBLIC_ENV = 'production';
  delete process.env.APP_VARIANT;
  try {
    const factory = require(configPath) as (config: unknown) => {
      expo: {
        ios: { bundleIdentifier: string; associatedDomains?: string[] };
        android: { package: string; intentFilters: ExpoIntentFilter[] };
      };
    };
    return factory({}).expo;
  } finally {
    if (saved.env === undefined) delete process.env.EXPO_PUBLIC_ENV;
    else process.env.EXPO_PUBLIC_ENV = saved.env;
    if (saved.variant !== undefined) process.env.APP_VARIANT = saved.variant;
  }
}

const passThrough: RequestHandler = (_req, _res, next) => next();
const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
  res.status(500).json({ error: 'test error' });
};

function createTestApp() {
  // Stands in for the real apex proxy: the shell Worker's SPA fallback answers
  // every path it is asked for with the HTML shell.
  const apexProxy = vi.fn<RequestHandler>((req, res, next) => {
    if (req.headers.host !== APEX) return next();
    res.status(200).type('html').send('<!doctype html><div id="root"></div>');
  });
  const routes: AppRoutes = {
    health: passThrough,
    internalMetrics: passThrough,
    webTelemetry: passThrough,
    legacyRoot: passThrough,
    webfinger: passThrough,
    apRateLimiter: passThrough,
    actor: passThrough,
    federationContent: passThrough,
    atprotoBridge: passThrough,
    atprotoBridgeMeta: passThrough,
    wellKnownBridge: passThrough,
    media: passThrough,
    crowdSourceWebhook: passThrough,
    mcpOAuth: passThrough,
    webShell: passThrough,
    apexProxy,
    publicApi: passThrough,
    requireAuth: passThrough,
    authenticatedApi: passThrough,
  };
  const deps: CreateAppDependencies = {
    frontendUrl: `https://${APEX}`,
    federationDomain: APEX,
    isAllowedOrigin: () => true,
    isApexHost: (req) => req.headers.host === APEX,
    isApexWebPlaneRequest: (req) => req.headers.host === APEX,
    countLocalPosts: vi.fn().mockResolvedValue(0),
    logger: { debug: vi.fn() },
    middleware: {
      requestObservability: passThrough,
      rateLimiter: passThrough,
      bruteForceProtection: passThrough,
      globalErrorHandler: errorHandler,
    },
    routes,
  };
  return { app: createApp(deps), apexProxy };
}

describe('app association documents', () => {
  it('serves assetlinks.json on the apex as JSON, with no redirect and without the SPA', async () => {
    const { app, apexProxy } = createTestApp();
    const res = await request(app).get('/.well-known/assetlinks.json').set('Host', APEX);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    expect(res.headers.location).toBeUndefined();
    expect(apexProxy).not.toHaveBeenCalled();
    expect(res.body).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: MENTION_APP_ID,
          sha256_cert_fingerprints: [...ANDROID_SIGNING_CERT_SHA256],
        },
      },
    ]);
  });

  it('lists only well-formed fingerprints, and never the public React Native debug key', () => {
    expect(ANDROID_SIGNING_CERT_SHA256.length).toBeGreaterThan(0);
    for (const fingerprint of ANDROID_SIGNING_CERT_SHA256) {
      expect(fingerprint).toMatch(/^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/);
    }
    expect(ANDROID_SIGNING_CERT_SHA256).not.toContain(RN_TEMPLATE_DEBUG_CERT);
  });

  it('answers the AASA with JSON: the document when a Team ID is set, else a 404', async () => {
    const { app, apexProxy } = createTestApp();
    const res = await request(app).get('/.well-known/apple-app-site-association').set('Host', APEX);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    expect(apexProxy).not.toHaveBeenCalled();
    expect(res.status).toBe(APPLE_TEAM_ID ? 200 : 404);

    const configured = express().use(createAppAssociationRouter('ABCDE12345'));
    const aasa = await request(configured).get('/.well-known/apple-app-site-association').expect(200);
    expect(aasa.headers['content-type']).toMatch(/^application\/json\b/);
    expect(aasa.body.applinks.details).toEqual([
      expect.objectContaining({ appIDs: [`ABCDE12345.${MENTION_APP_ID}`] }),
    ]);
    // Backend-owned apex surfaces must stay in the browser; the catch-all is last.
    const components = aasa.body.applinks.details[0].components as Array<Record<string, unknown>>;
    expect(components.at(-1)).toEqual({ '/': '/*' });
    for (const excluded of ['/.well-known/*', '/ap/*', '/xrpc/*', '/media/*']) {
      expect(components).toContainEqual({ '/': excluded, exclude: true });
    }
  });

  it('never lets an unknown /.well-known path fall through to the SPA shell', async () => {
    const { app, apexProxy } = createTestApp();
    const res = await request(app).get('/.well-known/does-not-exist').set('Host', APEX);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json\b/);
    expect(apexProxy).not.toHaveBeenCalled();
  });

  it('names the package and bundle id the app is built with, and verifies only hosts it serves', () => {
    const expo = loadProductionAppConfig();
    expect(expo.android.package).toBe(MENTION_APP_ID);
    expect(expo.ios.bundleIdentifier).toBe(MENTION_APP_ID);
    expect(expo.ios.associatedDomains).toEqual([`applinks:${APEX}`]);

    // Every https host in an autoVerify filter must serve our assetlinks.json.
    // This backend serves it for the apex only, so any other host (it once
    // claimed all of `https://oxy.so`) is a verification that cannot pass.
    const verifiedHttpsHosts = expo.android.intentFilters
      .filter((filter) => filter.autoVerify)
      .flatMap((filter) => filter.data)
      .filter((data) => data.scheme === 'https')
      .map((data) => data.host);
    expect(verifiedHttpsHosts).toEqual([APEX]);
  });
});
