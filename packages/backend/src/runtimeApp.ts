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
import { Post } from './models/Post';
import { setRuntimeOxyClient } from './runtime/oxyClient';
import { globalErrorHandler } from './utils/error';
import { isAllowedOrigin } from './utils/allowedOrigins';
import { logger } from './utils/logger';

/** Compose production HTTP dependencies. Runtime bootstrap calls this once. */
export function createRuntimeApp() {
  initConnectors();

  const oxy = new OxyServices({ baseURL: config.oxyApiUrl });
  setRuntimeOxyClient(oxy);

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
    countLocalPosts: () => Post.estimatedDocumentCount(),
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
