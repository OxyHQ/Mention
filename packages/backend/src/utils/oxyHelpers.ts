import { OxyServices } from '@oxyhq/core';
import { OxyClient } from './privacyHelpers';
import { logger } from './logger';

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
      logger.warn('[oxyHelpers] Neither OXY_SERVICE_API_KEY/SECRET nor OXY_SERVICE_TOKEN is set; service client will be unauthenticated');
    }
  }
  return client;
})();

export function getServiceOxyClient(): OxyServices {
  return serviceClient;
}

/**
 * Mention's Oxy `Application` `_id`. Sent as `clientId` on
 * `POST /profiles/recommendations` so Oxy selects Mention's per-app weight
 * profile when scoring recommendations (`REC_SCORING_V2`). When unset the Oxy
 * endpoint falls back to its default weight profile, so the value is optional
 * and the recommendation adapter simply omits `clientId` rather than failing.
 *
 * Provisioned alongside `OXY_SERVICE_API_KEY` / `OXY_SERVICE_API_SECRET` (SSM
 * `/oxy/mention/MENTION_OXY_CLIENT_ID`). It is the SAME Application that owns the
 * `6a30ca4b5b15dc1bb793ad53` service credential; the credential id and the
 * Application `_id` are distinct values.
 */
export function getMentionOxyClientId(): string | undefined {
  const value = process.env.MENTION_OXY_CLIENT_ID?.trim();
  return value && value.length > 0 ? value : undefined;
}
