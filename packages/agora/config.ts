// Base URLs — same backend as Mention app
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.mention.earth'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000');

export const API_URL_SOCKET =
  process.env.EXPO_PUBLIC_API_URL_SOCKET ?? (
    process.env.NODE_ENV === 'production'
      ? 'https://api.mention.earth'
      : 'ws://localhost:3000'
  );

export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://localhost:3001');
