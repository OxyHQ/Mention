import { OxyServices } from '@oxyhq/core';
import { OxyClient } from './privacyHelpers';

/**
 * Create a per-request OxyServices instance with the user's auth token.
 * This avoids mutating the global singleton which is racy under concurrent requests.
 */
export function createScopedOxyClient(req: { accessToken?: string; headers: { authorization?: string } }): OxyClient | undefined {
  const token = req.accessToken || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return undefined;
  const client = new OxyServices({ baseURL: process.env.OXY_API_URL || 'https://api.oxy.so' });
  client.setTokens(token);
  return client as unknown as OxyClient;
}
