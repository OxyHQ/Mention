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
    countLocalPosts: async () => {
      // `count(*)` rather than an estimate. Mongo's `estimatedDocumentCount`
      // read collection metadata for free; the Postgres analogue
      // (`pg_class.reltuples`) is only as fresh as the last autovacuum and
      // reports 0 on a table that has never been analyzed — which is exactly
      // what a freshly-migrated instance looks like. This value is a nodeinfo
      // statistic read at most once per request from a cached surface, so an
      // exact count is affordable and honest.
      const [row] = await getDb().select({ count: count() }).from(posts);
      return row?.count ?? 0;
    },
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
