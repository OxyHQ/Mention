// Base URLs
export const API_URL = process.env.API_URL || 'http://localhost:3000';
export const SOCKET_URL = process.env.API_URL_SOCKET || 'ws://localhost:3000/';
export const API_URL_SOCKET = process.env.API_URL_SOCKET || "ws://localhost:3000";

export const API_URL_SOCKET_CHAT = process.env.API_URL_SOCKET_CHAT || 'http://localhost:4000';
export const API_OXY_CHAT = process.env.API_OXY_CHAT || 'http://localhost:4000';
export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://192.168.86.44:3001');

// Stripe Payment Links (open in browser)
export const STRIPE_LINK_PLUS = process.env.EXPO_PUBLIC_STRIPE_LINK_PLUS || '';
export const STRIPE_LINK_FILE = process.env.EXPO_PUBLIC_STRIPE_LINK_FILE || '';
