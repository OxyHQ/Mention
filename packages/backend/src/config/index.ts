import * as z from 'zod';

const withoutTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const optionalString = (minimumLength = 1) =>
  z.preprocess(emptyAsUndefined, z.string().min(minimumLength).optional());

const trimmedOptionalString = z.preprocess(
  emptyAsUndefined,
  z.string().trim().min(1).optional(),
);

const integerFromEnv = (
  fallback: number,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER }: { minimum?: number; maximum?: number } = {},
) =>
  z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

const booleanFromEnv = (fallback: boolean) =>
  z.preprocess(
    emptyAsUndefined,
    z
      .enum(['true', 'false'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),
  );

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'must use http:// or https://');

const httpOrigin = httpUrl
  .refine((value) => {
    const url = new URL(value);
    return (
      /^\/*$/.test(url.pathname) &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, 'must be an origin without credentials, path, query or fragment')
  .transform(withoutTrailingSlash);

const optionalHttpOrigin = z.preprocess(emptyAsUndefined, httpOrigin.optional());

const redisUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'redis:' || protocol === 'rediss:';
  }, 'must use redis:// or rediss://');

const optionalRedisUrl = z.preprocess(emptyAsUndefined, redisUrl.optional());

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (value) =>
      value === 'localhost' ||
      /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        value,
      ),
    'must be a DNS hostname',
  );

const optionalDomain = z.preprocess(emptyAsUndefined, domain.optional());

const host = z
  .string()
  .trim()
  .max(253)
  .refine((value) => {
    if (/[/@?#\s]/.test(value)) return false;
    try {
      return new URL(`https://${value}`).hostname.length > 0;
    } catch {
      return false;
    }
  }, 'must be a hostname, optionally with a port, and must not include a URL scheme');

const optionalHost = z.preprocess(emptyAsUndefined, host.optional());

const commaSeparatedDomains = (fallback: readonly string[] = []) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return [...fallback];
      if (Array.isArray(value)) return value;
      return String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    z.array(domain),
  );

const separatedUrls = (fallback: readonly string[]) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') return [...fallback];
      if (Array.isArray(value)) return value;
      return String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    z.array(httpUrl).min(1),
  );

const exactIpList = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((entry) => entry.trim().replace(/^::ffff:/, ''))
      .filter(Boolean);
  },
  z.array(
    z
      .string()
      .refine(
        (value) =>
          /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) ||
          /^[0-9a-f:]+$/i.test(value),
        'must be an IPv4 or IPv6 address',
      )
      .refine((value) => {
        if (value.includes(':')) return value.length <= 45;
        return value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
      }, 'must be a valid IP address'),
  ),
);

const feedToggle = z.preprocess(
  emptyAsUndefined,
  z
    .enum(['on', 'off', 'true', 'false', '1', '0'])
    .optional()
    .transform((value) =>
      value === undefined ? undefined : value === 'on' || value === 'true' || value === '1',
    ),
);

const feedModuleSelection = (allowed: readonly string[]) =>
  z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .trim()
      .min(1)
      .optional()
      .refine((value) => {
        if (value === undefined) return true;
        const normalized = value.toLowerCase();
        if (['default', 'on', 'true', '1', 'off', 'false', '0'].includes(normalized)) {
          return true;
        }
        const entries = value.split(',').map((entry) => entry.trim());
        return (
          entries.length > 0 &&
          entries.every((entry) => entry.length > 0 && allowed.includes(entry))
        );
      }, 'contains an unknown or empty feed module id'),
  );

const phase2bSignalIds = [
  'coldStartBoost',
  'penalizeSeen',
  'verifiedBoost',
  'socialProof',
  'noveltyBoost',
  'localBoost',
  'languageMismatchPenalty',
  'starterPackBoost',
  'mediaBoost',
  'positivity',
  'conversational',
  'dwellTime',
  'reciprocityBoost',
] as const;

const discoveryGateModuleIds = [
  'minLength',
  'lowEffortGate',
  'nativeEngagement',
  'minQuality',
] as const;

const claudeRedirects = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
] as const;

const chatGptRedirects = [
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chat.openai.com/connector_platform_oauth_redirect',
] as const;

/**
 * The only schema allowed to read backend runtime environment variables.
 * Invalid supplied values fail fast; defaults apply only when a value is absent
 * or blank, never when it is malformed.
 */
const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .optional(),
    // Local dev default only — ECS injects PORT explicitly (oxy-infra
    // terraform-uswest2/app-services-realtime.tf). 4110 is Mention's slot in
    // the per-app port map so several Oxy backends can run side by side.
    PORT: integerFromEnv(4_110, { minimum: 1, maximum: 65_535 }),

    // PostgreSQL — the only store this service opens. Optional in the schema so
    // a task that does not touch the database (and every unit test) still
    // parses; every entry point that needs a pool asserts it for itself.
    DATABASE_URL: trimmedOptionalString,
    PG_MAX_POOL_SIZE: integerFromEnv(20, { minimum: 1, maximum: 1_000 }),
    PG_IDLE_TIMEOUT_SECONDS: integerFromEnv(30, { minimum: 1 }),
    PG_CONNECT_TIMEOUT_SECONDS: integerFromEnv(10, { minimum: 1 }),
    PG_MAX_LIFETIME_SECONDS: integerFromEnv(1_800, { minimum: 1 }),
    /**
     * Per-statement timing, the per-request roundtrip tally, and the slow-query
     * log (`db/queryMetrics.ts`).
     *
     * DEFAULT ON, because the cost is one `hrtime` pair and one histogram
     * observation per statement — immeasurable beside the round trip it
     * measures — and a database metric that is off in production measures
     * nothing. The switch exists so it can be taken out of the path entirely
     * (the client is then left completely unpatched) if it is ever implicated
     * in an incident, not because it is expected to be.
     *
     * DEFAULT OFF UNDER TEST, because the slow-query line goes through the same
     * `logger.warn` the application uses. A suite that asserts "this path warns
     * about nothing" would then pass or fail on how fast the machine running it
     * happens to be: `listSubscriptionVisibility` asserted exactly that, and its
     * own multi-row fixture insert took 350 ms on a CI runner and under the
     * 200 ms threshold here, so the failure appeared only in CI. Instrumentation
     * is observability, not behaviour, and must not decide whether a suite is
     * green. The two suites that exercise it set `queryMetricsEnabled` before
     * connecting, so nothing about it goes unmeasured; an explicit
     * `DB_QUERY_METRICS_ENABLED` still wins in every environment.
     */
    DB_QUERY_METRICS_ENABLED: booleanFromEnv(process.env.NODE_ENV !== 'test'),
    /**
     * Statements at or above this take a `warn` line carrying the SQL text.
     *
     * 200 ms is roughly two orders of magnitude above an indexed point lookup
     * against this schema, so an ordinary request logs nothing and a statement
     * that trips it is genuinely worth reading. Lower it to profile; raising it
     * past a second makes the line redundant with the shared slow-operation
     * warning `recordLatency` already emits.
     */
    DB_SLOW_QUERY_MS: integerFromEnv(200, { minimum: 1, maximum: 600_000 }),

    REDIS_URL: optionalRedisUrl,
    REDIS_URI: optionalRedisUrl,
    REDIS_HOST: optionalHost,
    REDIS_PORT: integerFromEnv(6_379, { minimum: 1, maximum: 65_535 }),
    REDIS_DB: integerFromEnv(0, { maximum: 1_024 }),
    REDIS_PASSWORD: optionalString(),

    CACHE_USER_TTL: integerFromEnv(300, { minimum: 1 }),
    CACHE_POST_TTL: integerFromEnv(120, { minimum: 1 }),
    CACHE_FEED_TTL: integerFromEnv(900, { minimum: 1 }),
    CACHE_FOLLOW_TTL: integerFromEnv(600, { minimum: 1 }),
    FEDIVERSE_SHARING_CACHE_TTL_SECONDS: integerFromEnv(600, { minimum: 1 }),
    VIEWER_RECENT_TOPICS_TTL_SECONDS: integerFromEnv(6 * 60 * 60, { minimum: 1 }),
    USER_SUMMARY_CACHE_TTL_SECONDS: integerFromEnv(10 * 60, { minimum: 1 }),
    // Deliberately the shortest cache TTL here: it holds an AUTHORIZATION answer
    // (which channels' inboxes a person may read), and its staleness window is
    // exactly how long a removed operator keeps reading. See
    // `services/notificationInbox.ts`.
    NOTIFICATION_INBOX_CACHE_TTL_SECONDS: integerFromEnv(60, { minimum: 1 }),
    DWELL_AGGREGATE_TTL_SECONDS: integerFromEnv(7 * 24 * 60 * 60, { minimum: 1 }),
    SYRA_PODCAST_CACHE_TTL_SECONDS: integerFromEnv(300, { minimum: 1 }),

    MENTION_PUBLIC_API_URL: optionalHttpOrigin,
    FRONTEND_URL: optionalHttpOrigin,
    MENTION_FRONTEND_ORIGIN: z.preprocess(
      emptyAsUndefined,
      httpOrigin.default('https://mention.earth'),
    ),
    MENTION_WEB_ORIGIN: z.preprocess(
      emptyAsUndefined,
      httpOrigin.default('https://mention.earth'),
    ),
    MENTION_API_ORIGIN: z.preprocess(
      emptyAsUndefined,
      httpOrigin.default('https://api.mention.earth'),
    ),
    WEB_SHELL_ORIGIN: z.preprocess(
      emptyAsUndefined,
      httpOrigin.default('https://mention-frontend.pages.dev'),
    ),
    OXY_API_URL: z.preprocess(emptyAsUndefined, httpOrigin.default('https://api.oxy.so')),
    OXY_MEDIA_CDN_ORIGIN: z.preprocess(
      emptyAsUndefined,
      httpOrigin.default('https://cloud.oxy.so'),
    ),

    FEDERATION_DOMAIN: z.preprocess(emptyAsUndefined, domain.default('mention.earth')),
    ACTOR_DOMAIN: optionalDomain,
    OXY_IDENTITY_APEX: optionalDomain,
    FEDERATION_ENABLED: booleanFromEnv(true),
    FEDERATION_MAX_CONTENT_LENGTH: integerFromEnv(50_000, {
      minimum: 1,
      maximum: 2 * 1_024 * 1_024,
    }),
    FEDERATION_DELIVERY_RETRIES: integerFromEnv(5, { maximum: 20 }),
    FEDERATION_BLOCKED_DOMAINS: commaSeparatedDomains(),
    FEDERATION_MEDIA_CACHE_WRITE_ENABLED: booleanFromEnv(false),

    MENTION_MCP_PUBLIC_URL: z.preprocess(
      emptyAsUndefined,
      httpOrigin.default('https://mcp.mention.earth'),
    ),
    MCP_LINK_TOKEN_TTL_SECONDS: integerFromEnv(900, { minimum: 30, maximum: 86_400 }),
    MCP_MAX_BUNDLE_MEMBERS: integerFromEnv(8, { minimum: 1, maximum: 100 }),
    MCP_ACCESS_TOKEN_TTL_SECONDS: integerFromEnv(3_600, { minimum: 60, maximum: 86_400 }),
    MCP_AUTH_CODE_TTL_SECONDS: integerFromEnv(300, { minimum: 30, maximum: 3_600 }),
    MCP_OAUTH_REDIRECT_URIS_CLAUDE: separatedUrls(claudeRedirects),
    MCP_OAUTH_REDIRECT_URIS_CHATGPT: separatedUrls(chatGptRedirects),
    MENTION_MCP_JWT_SECRET: optionalString(32),

    ATPROTO_ENABLED: booleanFromEnv(false),
    ATPROTO_APPVIEW: z.preprocess(emptyAsUndefined, host.default('public.api.bsky.app')),
    ATPROTO_PLC_DIRECTORY: z.preprocess(emptyAsUndefined, host.default('plc.directory')),
    ATPROTO_BRIDGE_ENABLED: booleanFromEnv(false),

    GIF_LIBRARY_WRITE_ENABLED: booleanFromEnv(true),
    KLIPY_MEDIA_HOSTS: commaSeparatedDomains(['klipy.com']),
    GIF_MEDIA_PROXY_SECRET: optionalString(32),
    KLIPY_APP_KEY: trimmedOptionalString,
    FFMPEG_PATH: z.preprocess(emptyAsUndefined, z.string().trim().min(1).default('ffmpeg')),

    OXY_SERVICE_API_KEY: trimmedOptionalString,
    OXY_SERVICE_API_SECRET: optionalString(),
    OXY_SERVICE_TOKEN: optionalString(),
    MENTION_OXY_CLIENT_ID: trimmedOptionalString,
    IP_HASH_SALT: optionalString(16),
    DEVICE_ID_SALT: optionalString(16),
    FIREBASE_SERVICE_ACCOUNT_BASE64: trimmedOptionalString,
    FIREBASE_PROJECT_ID: trimmedOptionalString,

    MENTION_DID: trimmedOptionalString,
    MENTION_PRIVATE_KEY: optionalString(),
    MENTION_PUBLIC_KEY: optionalString(),
    MENTION_NODE_PUBLIC_KEY: optionalString(),
    MENTION_NODE_BASE_URL: optionalHttpOrigin,

    ALIA_API_URL: z.preprocess(emptyAsUndefined, httpOrigin.default('https://api.alia.onl')),
    ALIA_API_KEY: optionalString(),
    SYRA_API_URL: z.preprocess(emptyAsUndefined, httpOrigin.default('https://api.syra.fm')),
    POST_CLASSIFICATION_ENABLED: booleanFromEnv(false),

    FOR_YOU_DISCOVERY_GATE_AB: feedToggle,
    FOR_YOU_DISCOVERY_GATE: feedModuleSelection(discoveryGateModuleIds),
    FOR_YOU_PHASE2B_SIGNALS: feedModuleSelection(phase2bSignalIds),

    /**
     * CrowdSource participatory moderation (§14.6).
     *
     * The names come from the packages, not from §14.6's table, and the difference
     * is deliberate. `@oxyhq/crowdsource` reads `CROWDSOURCE_SERVICE_KEY` (the
     * applicationId, credentialId and secret as ONE opaque value) and
     * `CROWDSOURCE_BASE_URL`; `@oxyhq/crowdsource-express` reads
     * `CROWDSOURCE_WEBHOOK_SECRET` and `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`.
     * §14.6's `CROWDSOURCE_APP_ID` is absent on purpose: the applicationId comes
     * off the credential and there is no surface anywhere that can carry one, so a
     * variable holding it could only ever disagree with the credential.
     */
    CROWDSOURCE_ENABLED: booleanFromEnv(false),
    CROWDSOURCE_SERVICE_KEY: optionalString(),
    CROWDSOURCE_BASE_URL: optionalHttpOrigin,
    CROWDSOURCE_WEBHOOK_SECRET: optionalString(16),
    CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS: optionalString(16),
    CROWDSOURCE_OUTBOX_BATCH_SIZE: integerFromEnv(50, { minimum: 1, maximum: 500 }),
    CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS: integerFromEnv(5_000, {
      minimum: 250,
      maximum: 300_000,
    }),
    /**
     * `observe` is the first deployment and the default (§14.6's safe rollout):
     * decisions are received, stored and planned, and nothing is removed.
     */
    CROWDSOURCE_ENFORCEMENT_MODE: z.preprocess(
      emptyAsUndefined,
      z.enum(['observe', 'manual', 'automatic']).default('observe'),
    ),

    INTERNAL_METRICS_ENABLED: booleanFromEnv(false),
    INTERNAL_METRICS_TOKEN: optionalString(32),
    METRICS_ALLOWED_IPS: exactIpList,
  })
  .superRefine((environment, context) => {
    if (
      environment.REDIS_URL &&
      environment.REDIS_URI &&
      environment.REDIS_URL !== environment.REDIS_URI
    ) {
      context.addIssue({
        code: 'custom',
        path: ['REDIS_URI'],
        message: 'must match REDIS_URL when both aliases are supplied',
      });
    }
    if (environment.INTERNAL_METRICS_ENABLED && !environment.INTERNAL_METRICS_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['INTERNAL_METRICS_TOKEN'],
        message: 'is required when INTERNAL_METRICS_ENABLED=true',
      });
    }
    const hasOxyKey = Boolean(environment.OXY_SERVICE_API_KEY);
    const hasOxySecret = Boolean(environment.OXY_SERVICE_API_SECRET);
    if (hasOxyKey !== hasOxySecret) {
      context.addIssue({
        code: 'custom',
        path: [hasOxyKey ? 'OXY_SERVICE_API_SECRET' : 'OXY_SERVICE_API_KEY'],
        message: 'OXY_SERVICE_API_KEY and OXY_SERVICE_API_SECRET must be configured together',
      });
    }
    /**
     * A half-configured integration is worse than a disabled one: reports would be
     * delivered and decisions would never arrive, or the reverse, and either way the
     * gap is invisible until somebody wonders why a case never came back. Both
     * directions are required together.
     */
    if (environment.CROWDSOURCE_ENABLED) {
      if (!environment.CROWDSOURCE_SERVICE_KEY) {
        context.addIssue({
          code: 'custom',
          path: ['CROWDSOURCE_SERVICE_KEY'],
          message: 'is required when CROWDSOURCE_ENABLED=true',
        });
      }
      if (!environment.CROWDSOURCE_WEBHOOK_SECRET) {
        context.addIssue({
          code: 'custom',
          path: ['CROWDSOURCE_WEBHOOK_SECRET'],
          message:
            'is required when CROWDSOURCE_ENABLED=true — without it no decision can ever be verified, so reports would leave and nothing would come back',
        });
      }
    }
    const hasFirebaseCredential = Boolean(environment.FIREBASE_SERVICE_ACCOUNT_BASE64);
    const hasFirebaseProject = Boolean(environment.FIREBASE_PROJECT_ID);
    if (hasFirebaseCredential !== hasFirebaseProject) {
      context.addIssue({
        code: 'custom',
        path: [
          hasFirebaseCredential ? 'FIREBASE_PROJECT_ID' : 'FIREBASE_SERVICE_ACCOUNT_BASE64',
        ],
        message: 'Firebase credential and project id must be configured together',
      });
    }
    const mentionSigningValues = [
      environment.MENTION_DID,
      environment.MENTION_PRIVATE_KEY,
      environment.MENTION_PUBLIC_KEY,
    ];
    const mentionSigningCount = mentionSigningValues.filter(Boolean).length;
    if (mentionSigningCount !== 0 && mentionSigningCount !== mentionSigningValues.length) {
      context.addIssue({
        code: 'custom',
        path: ['MENTION_DID'],
        message: 'MENTION_DID, MENTION_PRIVATE_KEY and MENTION_PUBLIC_KEY must be configured together',
      });
    }
  });

export type RuntimeEnvironment = z.output<typeof environmentSchema>;
type EnvironmentSource = Readonly<Record<string, string | undefined>>;

/** Parse an explicit source; exported so configuration validation is unit-testable. */
export function parseRuntimeEnvironment(source: EnvironmentSource): RuntimeEnvironment {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid Mention runtime configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

const environment = parseRuntimeEnvironment(process.env);

export interface RedisConnectionConfig {
  url?: string;
  host: string;
  port: number;
  password?: string;
  db: number;
  explicitlyConfigured: boolean;
}

function redisConfigFrom(environmentValue: RuntimeEnvironment): RedisConnectionConfig {
  return {
    url: environmentValue.REDIS_URL ?? environmentValue.REDIS_URI,
    host: environmentValue.REDIS_HOST ?? 'localhost',
    port: environmentValue.REDIS_PORT,
    password: environmentValue.REDIS_PASSWORD,
    db: environmentValue.REDIS_DB,
    explicitlyConfigured: Boolean(
      environmentValue.REDIS_URL ||
        environmentValue.REDIS_URI ||
        environmentValue.REDIS_HOST,
    ),
  };
}

/** Secret-bearing Redis connection settings. Callers must never log this object. */
export function getRedisConnectionConfig(): RedisConnectionConfig {
  return { ...redisConfigFrom(environment) };
}

/**
 * Dynamic configured-state check retained for lifecycle/tests that intentionally
 * toggle Redis after module import. Parsing still happens here, centrally.
 */
export function isRedisRuntimeConfigured(
  source: EnvironmentSource = process.env,
): boolean {
  const redisEnvironment = z
    .object({
      REDIS_URL: optionalRedisUrl,
      REDIS_URI: optionalRedisUrl,
      REDIS_HOST: optionalHost,
    })
    .superRefine((value, context) => {
      if (value.REDIS_URL && value.REDIS_URI && value.REDIS_URL !== value.REDIS_URI) {
        context.addIssue({
          code: 'custom',
          path: ['REDIS_URI'],
          message: 'must match REDIS_URL when both aliases are supplied',
        });
      }
    })
    .parse(source);
  return Boolean(redisEnvironment.REDIS_URL || redisEnvironment.REDIS_URI || redisEnvironment.REDIS_HOST);
}

function parseDynamicFeedFlags(source: EnvironmentSource = process.env) {
  return z
    .object({
      FOR_YOU_DISCOVERY_GATE_AB: feedToggle,
      FOR_YOU_DISCOVERY_GATE: feedModuleSelection(discoveryGateModuleIds),
      FOR_YOU_PHASE2B_SIGNALS: feedModuleSelection(phase2bSignalIds),
    })
    .parse(source);
}

export function isDiscoveryGateExperimentEnabled(): boolean | undefined {
  return parseDynamicFeedFlags().FOR_YOU_DISCOVERY_GATE_AB;
}

export function getDiscoveryGateSelection(): string | undefined {
  return parseDynamicFeedFlags().FOR_YOU_DISCOVERY_GATE;
}

export function getPhase2bSignalSelection(): string | undefined {
  return parseDynamicFeedFlags().FOR_YOU_PHASE2B_SIGNALS;
}

/** Resolve the MCP JWT key at call time so rotation/tests do not use a stale key. */
export function getMcpJwtSecret(): string {
  const value = optionalString(32).parse(process.env.MENTION_MCP_JWT_SECRET);
  if (!value) throw new Error('MENTION_MCP_JWT_SECRET is not configured');
  return value;
}

export interface OxyServiceCredentials {
  apiKey?: string;
  apiSecret?: string;
  token?: string;
}

export function getOxyServiceCredentials(): OxyServiceCredentials {
  return {
    apiKey: environment.OXY_SERVICE_API_KEY,
    apiSecret: environment.OXY_SERVICE_API_SECRET,
    token: environment.OXY_SERVICE_TOKEN,
  };
}

export function getGifMediaProxySecret(): string | undefined {
  return environment.GIF_MEDIA_PROXY_SECRET;
}

export function getKlipyAppKey(): string {
  return environment.KLIPY_APP_KEY ?? '';
}

export function getAliaApiKey(): string | undefined {
  return environment.ALIA_API_KEY;
}

export function getIpHashSalt(
  source: EnvironmentSource = process.env,
): string | undefined {
  const parsed = z
    .object({
      IP_HASH_SALT: optionalString(16),
      DEVICE_ID_SALT: optionalString(16),
      MENTION_MCP_JWT_SECRET: optionalString(32),
    })
    .parse(source);
  // Prefer a dedicated salt. Existing deployments can safely fall back to the
  // already-required MCP signing secret: hashedIpKey domain-separates its input
  // with `rl|`, so no raw IP or cross-purpose token material is exposed.
  return (
    parsed.IP_HASH_SALT ??
    parsed.DEVICE_ID_SALT ??
    parsed.MENTION_MCP_JWT_SECRET
  );
}

export function getFirebaseConfig():
  | { serviceAccountBase64: string; projectId: string }
  | undefined {
  if (!environment.FIREBASE_SERVICE_ACCOUNT_BASE64 || !environment.FIREBASE_PROJECT_ID) {
    return undefined;
  }
  return {
    serviceAccountBase64: environment.FIREBASE_SERVICE_ACCOUNT_BASE64,
    projectId: environment.FIREBASE_PROJECT_ID,
  };
}

export interface MentionSigningConfig {
  did: string;
  privateKey: string;
  publicKey: string;
}

export interface MentionSigningValues {
  did?: string;
  privateKey?: string;
  publicKey?: string;
}

export function getMentionSigningValues(
  source: EnvironmentSource = process.env,
): MentionSigningValues {
  const parsed = z
    .object({
      MENTION_DID: trimmedOptionalString,
      MENTION_PRIVATE_KEY: optionalString(),
      MENTION_PUBLIC_KEY: optionalString(),
    })
    .parse(source);
  return {
    did: parsed.MENTION_DID,
    privateKey: parsed.MENTION_PRIVATE_KEY,
    publicKey: parsed.MENTION_PUBLIC_KEY,
  };
}

/** Dynamic because signing tests and key rotation intentionally alter the env. */
export function getMentionSigningConfig(
  source: EnvironmentSource = process.env,
): MentionSigningConfig | undefined {
  const parsed = getMentionSigningValues(source);
  if (!parsed.did || !parsed.privateKey || !parsed.publicKey) {
    return undefined;
  }
  return {
    did: parsed.did,
    privateKey: parsed.privateKey,
    publicKey: parsed.publicKey,
  };
}

export function getMentionNodeConfig(
  source: EnvironmentSource = process.env,
): { publicKey?: string; baseUrl?: string } {
  const parsed = z
    .object({
      MENTION_NODE_PUBLIC_KEY: optionalString(),
      MENTION_NODE_BASE_URL: optionalHttpOrigin,
    })
    .parse(source);
  return {
    publicKey: parsed.MENTION_NODE_PUBLIC_KEY,
    baseUrl: parsed.MENTION_NODE_BASE_URL,
  };
}

export const config = {
  runtime: {
    nodeEnv: environment.NODE_ENV,
    port: environment.PORT,
    isProduction: environment.NODE_ENV === 'production',
  },
  logging: {
    level: environment.LOG_LEVEL ?? (environment.NODE_ENV === 'production' ? 'info' : 'debug'),
  },
  postgres: {
    /**
     * Absent means no pool is opened. A task that never queries boots fine
     * without it; anything that does asserts it at its own entry point.
     */
    url: environment.DATABASE_URL,
    /**
     * A Postgres connection is a server-side PROCESS, not a thread, so an
     * oversized pool costs the database real memory. Raise deliberately,
     * against a measurement.
     */
    maxPoolSize: environment.PG_MAX_POOL_SIZE,
    idleTimeoutSeconds: environment.PG_IDLE_TIMEOUT_SECONDS,
    connectTimeoutSeconds: environment.PG_CONNECT_TIMEOUT_SECONDS,
    maxLifetimeSeconds: environment.PG_MAX_LIFETIME_SECONDS,
    queryMetricsEnabled: environment.DB_QUERY_METRICS_ENABLED,
    slowQueryMs: environment.DB_SLOW_QUERY_MS,
  },
  frontendUrl: environment.FRONTEND_URL,
  oxyApiUrl: environment.OXY_API_URL,
  federationDomain: environment.FEDERATION_DOMAIN,
  publicApiUrl: environment.MENTION_PUBLIC_API_URL ?? 'http://localhost:4110',
  redis: {
    configured: redisConfigFrom(environment).explicitlyConfigured,
  },
  federation: {
    domain: environment.FEDERATION_DOMAIN,
    actorDomain: environment.ACTOR_DOMAIN ?? environment.FEDERATION_DOMAIN,
    oxyIdentityApex: environment.OXY_IDENTITY_APEX,
    enabled: environment.FEDERATION_ENABLED,
    maxContentLength: environment.FEDERATION_MAX_CONTENT_LENGTH,
    deliveryRetries: environment.FEDERATION_DELIVERY_RETRIES,
    blockedDomains: environment.FEDERATION_BLOCKED_DOMAINS,
    mediaCacheWriteEnabled: environment.FEDERATION_MEDIA_CACHE_WRITE_ENABLED,
  },
  mcp: {
    resourceUrl: environment.MENTION_MCP_PUBLIC_URL,
    issuer: environment.MENTION_PUBLIC_API_URL ?? 'http://localhost:4110',
    frontendOrigin: environment.MENTION_FRONTEND_ORIGIN,
    linkTokenTtlSeconds: environment.MCP_LINK_TOKEN_TTL_SECONDS,
    maxBundleMembers: environment.MCP_MAX_BUNDLE_MEMBERS,
    accessTokenTtlSeconds: environment.MCP_ACCESS_TOKEN_TTL_SECONDS,
    authCodeTtlSeconds: environment.MCP_AUTH_CODE_TTL_SECONDS,
    oauthRedirectUris: {
      claude: environment.MCP_OAUTH_REDIRECT_URIS_CLAUDE,
      chatGpt: environment.MCP_OAUTH_REDIRECT_URIS_CHATGPT,
    },
  },
  web: {
    origin: environment.MENTION_WEB_ORIGIN,
    shellOrigin: environment.WEB_SHELL_ORIGIN,
    apiOrigin: environment.MENTION_API_ORIGIN,
    oxyMediaCdnOrigin: environment.OXY_MEDIA_CDN_ORIGIN,
  },
  atproto: {
    enabled: environment.ATPROTO_ENABLED,
    appViewHost: environment.ATPROTO_APPVIEW,
    plcDirectoryHost: environment.ATPROTO_PLC_DIRECTORY,
    bridgeEnabled: environment.ATPROTO_BRIDGE_ENABLED,
  },
  gif: {
    libraryWriteEnabled: environment.GIF_LIBRARY_WRITE_ENABLED,
    allowedMediaDomains: environment.KLIPY_MEDIA_HOSTS,
  },
  media: {
    ffmpegPath: environment.FFMPEG_PATH,
  },
  identity: {
    mentionOxyClientId: environment.MENTION_OXY_CLIENT_ID,
  },
  internalMetrics: {
    enabled: environment.INTERNAL_METRICS_ENABLED,
    token: environment.INTERNAL_METRICS_TOKEN,
    allowedIps: environment.METRICS_ALLOWED_IPS,
  },
  cache: {
    userTTL: environment.CACHE_USER_TTL,
    postTTL: environment.CACHE_POST_TTL,
    feedTTL: environment.CACHE_FEED_TTL,
    followTTL: environment.CACHE_FOLLOW_TTL,
    fediverseSharingTtlSeconds: environment.FEDIVERSE_SHARING_CACHE_TTL_SECONDS,
    viewerRecentTopicsTtlSeconds: environment.VIEWER_RECENT_TOPICS_TTL_SECONDS,
    userSummaryTtlSeconds: environment.USER_SUMMARY_CACHE_TTL_SECONDS,
    notificationInboxTtlSeconds: environment.NOTIFICATION_INBOX_CACHE_TTL_SECONDS,
    dwellAggregateTtlSeconds: environment.DWELL_AGGREGATE_TTL_SECONDS,
    syraPodcastTtlSeconds: environment.SYRA_PODCAST_CACHE_TTL_SECONDS,
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
    apiUrl: environment.ALIA_API_URL,
    model: 'alia-v1',
    timeoutMs: 30_000,
  },
  syra: {
    apiUrl: environment.SYRA_API_URL,
  },
  classification: {
    enabled: environment.POST_CLASSIFICATION_ENABLED,
  },
  crowdSource: {
    enabled: environment.CROWDSOURCE_ENABLED,
    serviceKey: environment.CROWDSOURCE_SERVICE_KEY,
    baseUrl: environment.CROWDSOURCE_BASE_URL,
    webhookSecret: environment.CROWDSOURCE_WEBHOOK_SECRET,
    webhookPreviousSecret: environment.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS,
    outboxBatchSize: environment.CROWDSOURCE_OUTBOX_BATCH_SIZE,
    outboxPollIntervalMs: environment.CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS,
    enforcementMode: environment.CROWDSOURCE_ENFORCEMENT_MODE,
  },
} as const;

/**
 * The variables a task cannot boot without.
 *
 * **No `MONGODB_*` variable is among them, and none may come back.** Mongo is
 * gone from this package — no driver, no models, no copier — so a variable
 * naming it could only ever be read by something that should not exist.
 */
export function validateEnvironment(): void {
  const missing: string[] = [];
  if (config.runtime.isProduction && !config.frontendUrl) missing.push('FRONTEND_URL');
  if (config.runtime.isProduction && !environment.MENTION_PUBLIC_API_URL) {
    missing.push('MENTION_PUBLIC_API_URL');
  }
  if (config.runtime.isProduction && !getIpHashSalt()) {
    missing.push('IP_HASH_SALT');
  }
  if (config.runtime.isProduction && !environment.MENTION_MCP_JWT_SECRET) {
    missing.push('MENTION_MCP_JWT_SECRET');
  }
  if (config.classification.enabled && !getAliaApiKey()) {
    missing.push('ALIA_API_KEY');
  }
  if (
    config.gif.libraryWriteEnabled &&
    !environment.KLIPY_APP_KEY &&
    config.runtime.isProduction
  ) {
    missing.push('KLIPY_APP_KEY');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required runtime configuration: ${missing.join(', ')}`);
  }
}
