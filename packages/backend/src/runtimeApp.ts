import { OxyServices } from '@oxyhq/core';
import { createOxyRateLimit } from '@oxyhq/core/server';
import { createApp } from './app';
import { appRoutePredicates, createAppRoutes } from './appRoutes';
import { config } from './config';
import { initConnectors } from './connectors';
import { RedisStore } from './middleware/rateLimitStore';
import { bruteForceProtection } from './middleware/security';
import { createOptionalAuth } from './middleware/optionalAuth';
import { requestObservability } from './middleware/requestObservability';
import { count } from 'drizzle-orm';
import { getDb } from './db/postgres';
import { posts } from './db/schema/posts';
import { setRuntimeOxyClient } from './runtime/oxyClient';
import { globalErrorHandler } from './utils/error';
import { isAllowedOrigin } from './utils/allowedOrigins';
import { logger } from './utils/logger';
import { createCache } from './utils/cache';

/**
 * Nodeinfo's `localPosts`, cached for five minutes.
 *
 * A federation-discovery statistic that other instances poll — the number is
 * approximate to its consumers by nature, and nobody can tell a five-minute-old
 * post count from a live one. Long enough that a crawl storm costs one scan,
 * short enough that the figure stays honest.
 *
 * Module scope rather than inside `createRuntimeApp`: the bootstrap calls that
 * once, so the two are equivalent today, but a cache built per call would
 * silently lose its single-flight the moment anything constructed a second app
 * (a test harness, most likely).
 */
const NODEINFO_POST_COUNT_TTL_SECONDS = 300;
const NODEINFO_POST_COUNT_KEY = 'nodeinfo:v1:localposts';
const nodeinfoPostCountCache = createCache({
  name: 'NodeinfoPostCountCache',
  ttlSeconds: NODEINFO_POST_COUNT_TTL_SECONDS,
});

/**
 * `localPosts` for `GET /nodeinfo/2.0`, served from {@link nodeinfoPostCountCache}.
 *
 * Exported so the cache's behaviour is testable without standing up the whole
 * runtime app — `createRuntimeApp` constructs Oxy, Redis stores, connectors and
 * every route, none of which this needs.
 */
export function countLocalPostsCached(): Promise<number> {
  return nodeinfoPostCountCache.getOrCompute(NODEINFO_POST_COUNT_KEY, async () => {
    const [row] = await getDb().select({ count: count() }).from(posts);
    return row?.count ?? 0;
  });
}

/** Compose production HTTP dependencies. Runtime bootstrap calls this once. */
export function createRuntimeApp() {
  initConnectors();

  const oxy = new OxyServices({ baseURL: config.oxyApiUrl });
  setRuntimeOxyClient(oxy);

  // `rate-limit:api:` belongs to THIS limiter — the app-wide one, whose scope is
  // the entire API surface. Route-level limiters must not reuse it: they key
  // authenticated callers as `user:<id>` exactly as this one does, so a shared
  // prefix is a shared counter, and the Lua in `rateLimitStore` hands the whole
  // key one TTL — whichever limiter creates it. See `middleware/rateLimiter.ts`.
  const redisStore = new RedisStore({
    prefix: 'rate-limit:api:',
    windowMs: 15 * 60 * 1000,
  });
  const rateLimiter = createOxyRateLimit(oxy, { store: redisStore });
  const optionalAuth = createOptionalAuth(oxy);
  const routes = createAppRoutes({ oxy, optionalAuth });

  const app = createApp({
    frontendUrl: config.frontendUrl,
    federationDomain: config.federationDomain,
    isAllowedOrigin,
    ...appRoutePredicates,
    // `count(*)` rather than an estimate. Mongo's `estimatedDocumentCount` read
    // collection metadata for free; the Postgres analogue (`pg_class.reltuples`)
    // is only as fresh as the last autovacuum and reports 0 on a table that has
    // never been analyzed — which is exactly what a freshly-migrated instance
    // looks like.
    //
    // The original comment here claimed this was "read at most once per request
    // from a cached surface", and the exact count was affordable BECAUSE of
    // that. There was no cache: `GET /nodeinfo/2.0` is public, unauthenticated
    // and advertised through `/.well-known/nodeinfo`, so every fediverse crawler
    // that discovered this instance ran an unbounded sequential scan of `posts`
    // — the one table in the schema that only grows. `countLocalPostsCached`
    // makes the claim true.
    countLocalPosts: countLocalPostsCached,
    logger,
    middleware: {
      requestObservability,
      rateLimiter,
      bruteForceProtection,
      globalErrorHandler,
    },
    routes,
  });

  return { app, oxy };
}
