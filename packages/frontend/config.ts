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

export const API_URL_SOCKET_CHAT =
  process.env.API_URL_SOCKET_CHAT ||
  (process.env.NODE_ENV === 'production' ? 'wss://api.mention.earth' : 'http://localhost:4000');
export const API_OXY_CHAT =
  process.env.API_OXY_CHAT ||
  (process.env.NODE_ENV === 'production' ? 'wss://api.mention.earth' : 'http://localhost:4000');
export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://localhost:3001');

// Stripe Payment Links (open in browser)
export const STRIPE_LINK_PLUS = process.env.EXPO_PUBLIC_STRIPE_LINK_PLUS || '';
export const STRIPE_LINK_FILE = process.env.EXPO_PUBLIC_STRIPE_LINK_FILE || '';

// KLIPY API
export const KLIPY_APP_KEY = process.env.EXPO_PUBLIC_KLIPY_APP_KEY || '';
