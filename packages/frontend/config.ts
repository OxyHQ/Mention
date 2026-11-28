import type { LogLevel } from '@oxy.so/core/logger';

// Explicit deployment configuration takes precedence in every build mode.
export const IS_DEVELOPMENT = process.env.NODE_ENV === 'development';

// Mirrors `LogLevel` from @oxy.so/core/logger — the levels the shared logger
// understands. Anything else in EXPO_PUBLIC_LOG_LEVEL is ignored.
const VALID_LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];
const configuredLogLevel = process.env.EXPO_PUBLIC_LOG_LEVEL;
export const LOG_LEVEL: LogLevel | undefined =
  configuredLogLevel && VALID_LOG_LEVELS.includes(configuredLogLevel as LogLevel)
    ? (configuredLogLevel as LogLevel)
    : undefined;
// Annotated because `process.env.*` widens to `any` here, which would otherwise
// propagate into every consumer of this constant.
export const LOG_DEBUG_FILTER: string = process.env.EXPO_PUBLIC_LOG_DEBUG ?? '';

export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? 'https://api.mention.earth' : 'http://localhost:4110');
export const API_URL_SOCKET =
  process.env.EXPO_PUBLIC_API_URL_SOCKET ?? API_URL.replace(/^http/, 'ws');

// Syra live-rooms backend. Mention's rooms feature is powered by Syra, so room
// HTTP + realtime traffic targets Syra (NOT api.mention.earth). The Oxy bearer
// token authenticates cross-app (same Oxy identity). Overridable per-environment.
export const SYRA_API_URL = process.env.EXPO_PUBLIC_SYRA_API_URL || 'https://api.syra.fm/api';
export const SYRA_SOCKET_URL = process.env.EXPO_PUBLIC_SYRA_SOCKET_URL || 'wss://api.syra.fm';

// Clarity owns personal work experience; edits use the current Oxy session.
export const CLARITY_API_URL =
  process.env.EXPO_PUBLIC_CLARITY_API_URL || 'https://api.clarity.surf';

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
// Required by @oxy.so/services for the cross-app device sign-in flow. Public and
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
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI ??
  process.env.EXPO_PUBLIC_WEB_BASE_URL ??
  'https://mention.earth';

// Public web origin used to build shareable deep links (posts, trends, rooms).
export const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_BASE_URL || 'https://mention.earth';

/**
 * The fediverse domain of this instance's accounts: the `@user@<domain>` handle
 * people are shown and that remote servers find through WebFinger. It is NOT the
 * web host. When the canonical web moves to mention.org, mention.earth stays the
 * ActivityPub identity for good (docs/mention-org-domain-move.md), so nothing that
 * names an account may derive it from `WEB_BASE_URL`. Mirrors the backend's
 * `FEDERATION_DOMAIN`, which has the same default.
 */
export const FEDERATION_DOMAIN: string =
  process.env.EXPO_PUBLIC_FEDERATION_DOMAIN?.trim().toLowerCase() || 'mention.earth';

/**
 * Every web host of the public Mention instance. A link on any of them names the
 * same page, so they all count as "ours" while this build's web host is one of them.
 */
export const PUBLIC_INSTANCE_WEB_HOSTS: readonly string[] = ['mention.earth', 'mention.org'];

/** The value of `EXPO_PUBLIC_WEB_ALIAS_HOSTS` that turns the aliases off. */
const NO_ALIAS_HOSTS = 'none';

/**
 * The other web hosts that serve this same app (`EXPO_PUBLIC_WEB_ALIAS_HOSTS`, a
 * comma-separated list of hostnames; `none` is the empty list). Unset or blank,
 * the public instance's hosts apply when `webBaseUrl` is on one of them, and no
 * host at all otherwise, so another deployment never claims mention.earth's links.
 * Exported for tests; read {@link WEB_ALIAS_HOSTS}.
 */
export function parseWebAliasHosts(value: string | undefined, webBaseUrl: string): string[] {
  const text = value?.trim() ?? '';
  if (text.toLowerCase() === NO_ALIAS_HOSTS) return [];
  if (text.length === 0) {
    let webHost: string;
    try {
      webHost = new URL(webBaseUrl).hostname.toLowerCase();
    } catch {
      return [];
    }
    return PUBLIC_INSTANCE_WEB_HOSTS.includes(webHost) ? [...PUBLIC_INSTANCE_WEB_HOSTS] : [];
  }
  const hosts: string[] = [];
  for (const entry of text.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      hosts.push(new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname);
    } catch {
      // A malformed entry names no host; the others still count.
    }
  }
  return [...new Set(hosts)];
}

/** The other web hosts of this app; links on them are this instance's own links. */
export const WEB_ALIAS_HOSTS: readonly string[] = parseWebAliasHosts(
  process.env.EXPO_PUBLIC_WEB_ALIAS_HOSTS,
  WEB_BASE_URL,
);

// Allo store listings, offered when Allo is not installed and a profile's
// "Message" or a post's "Send in Allo" is pressed (hooks/useOpenInAllo.tsx).
// Unset while Allo has no listing.
export const ALLO_APP_STORE_URL = process.env.EXPO_PUBLIC_ALLO_APP_STORE_URL || '';
export const ALLO_PLAY_STORE_URL = process.env.EXPO_PUBLIC_ALLO_PLAY_STORE_URL || '';

// KLIPY API
export const KLIPY_APP_KEY = process.env.EXPO_PUBLIC_KLIPY_APP_KEY || '';

// Non-secret, build-time branding generated from the server deployment manifest.
export const INSTANCE_NAME = process.env.EXPO_PUBLIC_INSTANCE_NAME || 'Mention';
export const INSTANCE_LOGO_URL = process.env.EXPO_PUBLIC_INSTANCE_LOGO_URL || '';
export const INSTANCE_ABOUT = process.env.EXPO_PUBLIC_INSTANCE_ABOUT || '';
export const INSTANCE_ACCENT_COLOR = process.env.EXPO_PUBLIC_INSTANCE_ACCENT_COLOR || '';
export const INSTANCE_SOURCE_URL = process.env.EXPO_PUBLIC_INSTANCE_SOURCE_URL || '';
export const INSTANCE_REVISION = process.env.EXPO_PUBLIC_INSTANCE_REVISION || '';

/**
 * This deployment's MCP server — the resource an AI connector is authorized
 * for. Oxy lists every connector an account authorized; the ones for this
 * resource are the ones Mention's settings show.
 */
export const MCP_RESOURCE_URL = (
  process.env.EXPO_PUBLIC_MCP_URL || 'https://mcp.mention.earth'
).replace(/\/+$/, '');

// Public identity of the reviewed standalone Mention Plus product and offer.
// Empty configuration never invents an offer or enables a payment.
export const MENTION_PLUS_OFFER_ID = process.env.EXPO_PUBLIC_MENTION_PLUS_OFFER_ID;
export const MENTION_PLUS_OFFER_VERSION = process.env.EXPO_PUBLIC_MENTION_PLUS_OFFER_VERSION;
export const MENTION_PLUS_ANNUAL_OFFER_ID = process.env.EXPO_PUBLIC_MENTION_PLUS_ANNUAL_OFFER_ID;
export const MENTION_PLUS_ANNUAL_OFFER_VERSION =
  process.env.EXPO_PUBLIC_MENTION_PLUS_ANNUAL_OFFER_VERSION;
export const MENTION_PLUS_PRODUCT_ID = process.env.EXPO_PUBLIC_MENTION_PLUS_PRODUCT_ID;
export const MENTION_PLUS_CAPABILITY_KEY = process.env.EXPO_PUBLIC_MENTION_PLUS_CAPABILITY_KEY;

/** Explicit development-only UI simulation; the sheet also requires a loopback host. */
export const MENTION_PLUS_UI_PREVIEW =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ &&
  process.env.EXPO_PUBLIC_MENTION_PLUS_UI_PREVIEW === 'true';
