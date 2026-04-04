import { OxyServices } from '@oxyhq/core';
import { OxyClient } from './privacyHelpers';

const OXY_BASE_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

/**
 * Create a per-request OxyServices instance with the user's auth token.
 * This avoids mutating the global singleton which is racy under concurrent requests.
 */
export function createScopedOxyClient(req: { accessToken?: string; headers: { authorization?: string } }): OxyClient | undefined {
  const token = req.accessToken || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return undefined;
  const client = new OxyServices({ baseURL: OXY_BASE_URL });
  client.setTokens(token);
  return client as unknown as OxyClient;
}

/**
 * Module-level singleton OxyServices instance authenticated with the service token.
 * Used for server-side operations on behalf of the system (e.g. resolving federated actors).
 *
 * Supports two modes:
 * 1. configureServiceAuth(apiKey, apiSecret) — auto-acquires and refreshes service JWTs
 * 2. OXY_SERVICE_TOKEN — static token (legacy/fallback)
 */
const serviceClient: OxyServices = (() => {
  const client = new OxyServices({ baseURL: OXY_BASE_URL });

  const apiKey = process.env.OXY_SERVICE_API_KEY;
  const apiSecret = process.env.OXY_SERVICE_API_SECRET;
  if (apiKey && apiSecret) {
    client.configureServiceAuth(apiKey, apiSecret);
  } else {
    const token = process.env.OXY_SERVICE_TOKEN;
    if (token) {
      client.setTokens(token);
    } else {
      console.warn('[oxyHelpers] Neither OXY_SERVICE_API_KEY/SECRET nor OXY_SERVICE_TOKEN is set; service client will be unauthenticated');
    }
  }
  return client;
})();

export function getServiceOxyClient(): OxyServices {
  return serviceClient;
}
