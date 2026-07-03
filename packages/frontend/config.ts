// Base URLs (prod first → env → fallback)
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.mention.earth'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000');
export const SOCKET_URL =
  process.env.NODE_ENV === "production"
    ? "wss://api.mention.earth"
    : (process.env.API_URL_SOCKET ?? "ws://localhost:3000");

export const API_URL_SOCKET =
  process.env.NODE_ENV === "production"
    ? "wss://api.mention.earth"
    : (process.env.API_URL_SOCKET ?? "ws://localhost:3000");

// Syra live-rooms backend. Mention's rooms feature is powered by Syra, so room
// HTTP + realtime traffic targets Syra (NOT api.mention.earth). The Oxy bearer
// token authenticates cross-app (same Oxy identity). Overridable per-environment.
export const SYRA_API_URL =
  process.env.EXPO_PUBLIC_SYRA_API_URL || 'https://api.syra.fm/api';
export const SYRA_SOCKET_URL =
  process.env.EXPO_PUBLIC_SYRA_SOCKET_URL || 'wss://api.syra.fm';

export const API_URL_SOCKET_CHAT =
  process.env.API_URL_SOCKET_CHAT ||
  (process.env.NODE_ENV === 'production' ? 'wss://api.mention.earth' : 'http://localhost:4000');
export const API_OXY_CHAT =
  process.env.API_OXY_CHAT ||
  (process.env.NODE_ENV === 'production' ? 'wss://api.mention.earth' : 'http://localhost:4000');
export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://localhost:3001');

export const OXY_AUTH_URL =
  process.env.EXPO_PUBLIC_OXY_AUTH_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://auth.oxy.so' : 'http://localhost:3002');

// Mention's registered Oxy OAuth client id (ApplicationCredential publicKey).
// Required by @oxyhq/services for the cross-app device sign-in flow. Public and
// safe to commit; overridable per-environment via EXPO_PUBLIC_OXY_CLIENT_ID.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_ba07b16e89bd180d2b58c09b02db550e727fa598ed73e2f2';

// Public web origin used to build shareable deep links (posts, trends, rooms).
export const WEB_BASE_URL =
  process.env.EXPO_PUBLIC_WEB_BASE_URL || 'https://mention.earth';

// Stripe Payment Links (open in browser)
export const STRIPE_LINK_PLUS = process.env.EXPO_PUBLIC_STRIPE_LINK_PLUS || '';
export const STRIPE_LINK_FILE = process.env.EXPO_PUBLIC_STRIPE_LINK_FILE || '';

// KLIPY API
export const KLIPY_APP_KEY = process.env.EXPO_PUBLIC_KLIPY_APP_KEY || '';
