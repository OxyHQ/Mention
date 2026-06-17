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

export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_ba07b16e89bd180d2b58c09b02db550e727fa598ed73e2f2';
