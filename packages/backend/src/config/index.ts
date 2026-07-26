import * as z from 'zod';
import { logger } from '../utils/logger';

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const nonNegativeInt = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);

const booleanFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(String(fallback) as 'true' | 'false')
    .transform((value) => value === 'true');

/**
 * Environment parsing happens once. Invalid numeric values fail immediately
 * instead of silently becoming NaN and leaking into timeouts, pools or limits.
 * Secrets stay out of the exported reader-facing configuration object.
 */
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_READ_PREFERENCE: z
    .enum(['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'])
    .optional(),
  MONGODB_SOCKET_TIMEOUT_MS: positiveInt(45_000),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: positiveInt(20_000),
  MONGODB_MAX_RETRIES: positiveInt(5),
  MONGODB_MAX_POOL_SIZE: positiveInt(100),
  MONGODB_MIN_POOL_SIZE: nonNegativeInt(10),
  MONGODB_MAX_IDLE_TIME_MS: positiveInt(60_000),
  MONGODB_HEARTBEAT_FREQUENCY_MS: positiveInt(10_000),
  CACHE_USER_TTL: positiveInt(300),
  CACHE_POST_TTL: positiveInt(120),
  CACHE_FEED_TTL: positiveInt(900),
  CACHE_FOLLOW_TTL: positiveInt(600),
  MENTION_PUBLIC_API_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  OXY_API_URL: z.string().url().default('https://api.oxy.so'),
  FEDERATION_DOMAIN: z.string().min(1).default('mention.earth'),
  ALIA_API_URL: z.string().url().default('https://api.alia.onl'),
  ALIA_API_KEY: z.string().default(''),
  SYRA_API_URL: z.string().url().default('https://api.syra.fm'),
  POST_CLASSIFICATION_ENABLED: booleanFromEnv(false),
  INTERNAL_METRICS_ENABLED: booleanFromEnv(false),
  INTERNAL_METRICS_TOKEN: z.string().min(32).optional(),
  METRICS_ALLOWED_IPS: z.string().default(''),
}).superRefine((environment, context) => {
  if (environment.MONGODB_MIN_POOL_SIZE > environment.MONGODB_MAX_POOL_SIZE) {
    context.addIssue({
      code: 'custom',
      path: ['MONGODB_MIN_POOL_SIZE'],
      message: 'must not exceed MONGODB_MAX_POOL_SIZE',
    });
  }
  if (environment.INTERNAL_METRICS_ENABLED && !environment.INTERNAL_METRICS_TOKEN) {
    context.addIssue({
      code: 'custom',
      path: ['INTERNAL_METRICS_TOKEN'],
      message: 'is required when INTERNAL_METRICS_ENABLED=true',
    });
  }
});

const parsedEnvironment = environmentSchema.safeParse(process.env);
if (!parsedEnvironment.success) {
  const message = z.prettifyError(parsedEnvironment.error);
  throw new Error(`Invalid Mention runtime configuration:\n${message}`);
}

const environment = parsedEnvironment.data;
const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

export const config = {
  runtime: {
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    isProduction: environment.NODE_ENV === 'production',
  },
  mongoUri: environment.MONGODB_URI,
  mongoReadPreference:
    environment.MONGODB_READ_PREFERENCE ??
    (environment.NODE_ENV === 'production' ? 'secondaryPreferred' : 'primary'),
  frontendUrl: environment.FRONTEND_URL,
  oxyApiUrl: withoutTrailingSlash(environment.OXY_API_URL),
  federationDomain: environment.FEDERATION_DOMAIN,
  publicApiUrl: withoutTrailingSlash(
    environment.MENTION_PUBLIC_API_URL ?? 'http://localhost:3000',
  ),
  internalMetrics: {
    enabled: environment.INTERNAL_METRICS_ENABLED,
    token: environment.INTERNAL_METRICS_TOKEN,
    allowedIps: environment.METRICS_ALLOWED_IPS
      .split(',')
      .map((value) => value.trim().replace(/^::ffff:/, ''))
      .filter(Boolean),
  },
  cache: {
    userTTL: environment.CACHE_USER_TTL,
    postTTL: environment.CACHE_POST_TTL,
    feedTTL: environment.CACHE_FEED_TTL,
    followTTL: environment.CACHE_FOLLOW_TTL,
    l1MaxEntries: 1_000,
    l1TTL: 60,
  },
  rateLimit: {
    authenticated: { max: 1_000, windowMs: 15 * 60 * 1_000 },
    unauthenticated: { max: 100, windowMs: 15 * 60 * 1_000 },
  },
  socket: {
    pingTimeout: 60_000,
    pingInterval: 20_000,
    upgradeTimeout: 30_000,
    connectTimeout: 45_000,
    maxBufferSize: 1e6,
    compressionThreshold: 1_024,
  },
  db: {
    socketTimeoutMS: environment.MONGODB_SOCKET_TIMEOUT_MS,
    serverSelectionTimeoutMS: environment.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    maxRetries: environment.MONGODB_MAX_RETRIES,
    maxPoolSize: environment.MONGODB_MAX_POOL_SIZE,
    minPoolSize: environment.MONGODB_MIN_POOL_SIZE,
    maxIdleTimeMS: environment.MONGODB_MAX_IDLE_TIME_MS,
    heartbeatFrequencyMS: environment.MONGODB_HEARTBEAT_FREQUENCY_MS,
  },
  feed: {
    defaultLimit: 20,
    maxLimit: 100,
    queryTimeoutMs: 15_000,
    slowQueryThresholdMs: 100,
    rankedCandidateMultiplier: 2,
    scoreEpsilon: 0.001,
  },
  posts: {
    maxSources: 5,
    maxSourceTitleLength: 200,
    maxArticleTitleLength: 280,
    maxArticleExcerptLength: 280,
    defaultPollDurationDays: 7,
    maxPollDurationDays: 30,
    maxEventNameLength: 200,
    maxEventLocationLength: 200,
    maxEventDescriptionLength: 500,
    defaultPageSize: 20,
    maxPageSize: 100,
    defaultNearbyRadiusMeters: 10_000,
    maxNearbyPosts: 50,
    maxAreaPosts: 100,
    defaultLikesLimit: 50,
    maxHashtagLength: 100,
    maxHashtagsPerPost: 30,
    maxTextLength: 25_000,
    maxAltTextLength: 2_000,
  },
  search: {
    maxDateRangeDays: 365,
    maxTimeMS: 3_000,
  },
  alia: {
    apiUrl: withoutTrailingSlash(environment.ALIA_API_URL),
    apiKey: environment.ALIA_API_KEY,
    model: 'alia-v1',
    timeoutMs: 30_000,
  },
  syra: {
    apiUrl: withoutTrailingSlash(environment.SYRA_API_URL),
  },
  classification: {
    enabled: environment.POST_CLASSIFICATION_ENABLED,
  },
} as const;

export function validateEnvironment(): void {
  const missing: string[] = [];
  if (!config.mongoUri) missing.push('MONGODB_URI');
  if (config.runtime.isProduction && !config.frontendUrl) missing.push('FRONTEND_URL');
  if (config.runtime.isProduction && !environment.MENTION_PUBLIC_API_URL) {
    missing.push('MENTION_PUBLIC_API_URL');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required runtime configuration: ${missing.join(', ')}`);
  }

  if (!config.alia.apiKey) {
    logger.warn('ALIA_API_KEY is not set; AI features are disabled');
  }
}
