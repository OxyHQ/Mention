import type { LogLevel } from '@oxyhq/core/logger';

// Base URLs (prod first → env → fallback)
export const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

// Mirrors `LogLevel` from @oxyhq/core/logger — the levels the shared logger
// understands. Anything else in EXPO_PUBLIC_LOG_LEVEL is ignored.
const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'silent',
  'error',
  'warn',
  'info',
  'debug',
];
const configuredLogLevel = process.env.EXPO_PUBLIC_LOG_LEVEL;
export const LOG_LEVEL: LogLevel | undefined =
  configuredLogLevel && VALID_LOG_LEVELS.includes(configuredLogLevel as LogLevel)
    ? (configuredLogLevel as LogLevel)
    : undefined;
// Annotated because `process.env.*` widens to `any` here, which would otherwise
// propagate into every consumer of this constant.
export const LOG_DEBUG_FILTER: string = process.env.EXPO_PUBLIC_LOG_DEBUG ?? '';

export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.mention.earth'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4110');
export const API_URL_SOCKET =
  process.env.NODE_ENV === "production"
    ? "wss://api.mention.earth"
    : (process.env.EXPO_PUBLIC_API_URL_SOCKET ?? "ws://localhost:4110");

// Syra live-rooms backend. Mention's rooms feature is powered by Syra, so room
// HTTP + realtime traffic targets Syra (NOT api.mention.earth). The Oxy bearer
// token authenticates cross-app (same Oxy identity). Overridable per-environment.
export const SYRA_API_URL =
  process.env.EXPO_PUBLIC_SYRA_API_URL || 'https://api.syra.fm/api';
export const SYRA_SOCKET_URL =
  process.env.EXPO_PUBLIC_SYRA_SOCKET_URL || 'wss://api.syra.fm';

// Oxy is ALWAYS the production identity provider — there is deliberately no
// localhost fallback here, unlike `API_URL` above. Oxy owns the account, and a
// build that quietly points identity at a port nothing is listening on does not
// fail loudly: it renders a signed-out app whose feed simply will not load, which
// reads as a broken feed rather than as a missing backend. That happened on a
// device build made without a `.env`, and the previous `NODE_ENV`-keyed fallback
// is what made it silent: any build that was not marked production defaulted to a
// local port instead of to Oxy.
// Overridable for a non-production Oxy environment; the default is never local.
export const OXY_BASE_URL = process.env.EXPO_PUBLIC_OXY_BASE_URL || 'https://api.oxy.so';

// Mention's registered Oxy OAuth client id (ApplicationCredential publicKey).
// Required by @oxyhq/services for the cross-app device sign-in flow. Public and
// safe to commit — it travels inside the bundle, so it cannot be confidential.
// The deploy workflow injects the PRODUCTION id from the
// EXPO_PUBLIC_OXY_CLIENT_ID secret; the value below is only a fallback so a
// local build runs unconfigured, and is deliberately NOT the production id — a
// fallback that is correct in production hides the case where the env var stops
// being injected, because nothing changes when it does.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_ba07b16e89bd180d2b58c09b02db550e727fa598ed73e2f2';

/** Registered OAuth redirect surface for this web origin (exact match). */
export const OXY_AUTH_REDIRECT_URI =
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI ?? 'https://mention.earth';

// Public web origin used to build shareable deep links (posts, trends, rooms).
export const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL || 'https://mention.earth';

// Stripe Payment Links (open in browser)
export const STRIPE_LINK_PLUS = process.env.EXPO_PUBLIC_STRIPE_LINK_PLUS || '';
export const STRIPE_LINK_FILE = process.env.EXPO_PUBLIC_STRIPE_LINK_FILE || '';

// KLIPY API
export const KLIPY_APP_KEY = process.env.EXPO_PUBLIC_KLIPY_APP_KEY || '';
