import { logger } from './logger';

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
const OXY_SERVICE_API_KEY = process.env.OXY_SERVICE_API_KEY || '';
const OXY_SERVICE_API_SECRET = process.env.OXY_SERVICE_API_SECRET || '';

let cachedServiceToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Get a service token from the Oxy API for internal service-to-service calls.
 * Caches the token until near expiry.
 */
async function getServiceToken(): Promise<string> {
  if (cachedServiceToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedServiceToken;
  }

  const res = await fetch(`${OXY_API_URL}/auth/service-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: OXY_SERVICE_API_KEY,
      apiSecret: OXY_SERVICE_API_SECRET,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Failed to get Oxy service token: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { token?: string; accessToken?: string; expiresIn?: number };
  const token = data.token || data.accessToken;
  if (!token) throw new Error('No token in service-token response');

  cachedServiceToken = token;
  tokenExpiresAt = Date.now() + (data.expiresIn || 3600) * 1000;
  return token;
}

/**
 * Sync a federated actor to the Oxy user system via the PUT /users/federated API.
 * Replaces the old direct-DB approach (oxyDb.ts).
 */
export async function syncFederatedUserToOxy(actor: {
  actorUri: string;
  domain: string;
  username: string;
  displayName?: string;
  bio?: string;
  actorId: string;
}): Promise<void> {
  const token = await getServiceToken();

  const res = await fetch(`${OXY_API_URL}/users/federated`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(actor),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Oxy PUT /users/federated failed: ${res.status} ${body}`);
  }

  logger.debug(`Synced federated user to Oxy: ${actor.username}`);
}
