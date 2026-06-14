/**
 * Single source of truth for CORS allowed origins across the backend.
 *
 * In production ONLY explicitly allowlisted production origins pass.
 * Development origins (localhost / 127.0.0.1 / LAN IPs) are gated behind
 * NODE_ENV !== 'production' so they can never be honoured in production,
 * even if an attacker spoofs the Origin header.
 */

const isProduction = process.env.NODE_ENV === 'production';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mention.earth';

/**
 * Production origins that are always allowed regardless of environment.
 */
const PRODUCTION_ORIGINS: readonly string[] = [
  FRONTEND_URL,
  'https://agora.mention.earth',
];

/**
 * Returns the static list of allowed CORS origins for the current environment.
 * Development-only origins (localhost) are included exclusively outside production.
 *
 * Note: arbitrary localhost ports / LAN IPs are matched dynamically by
 * `isAllowedOrigin` (dev only) rather than enumerated here.
 */
export function getAllowedOrigins(): string[] {
  if (isProduction) {
    return [...PRODUCTION_ORIGINS];
  }
  return [
    ...PRODUCTION_ORIGINS,
    'http://localhost:8081',
    'http://localhost:8082',
  ];
}

/**
 * Matches private/loopback dev hosts: localhost, 127.0.0.1, and RFC1918 LAN
 * ranges (10.x, 172.16–31.x, 192.168.x) on any port, http or https.
 * Never matches in production.
 */
const DEV_ORIGIN_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/;

/**
 * Authoritative CORS origin check.
 *
 * - Always allows the production allowlist.
 * - Outside production, also allows any localhost / 127.0.0.1 / LAN-IP origin
 *   (any port) so the Expo dev server and physical test devices can connect.
 * - In production, dev origins are rejected.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (getAllowedOrigins().includes(origin)) return true;
  if (!isProduction && DEV_ORIGIN_PATTERN.test(origin)) return true;
  return false;
}
