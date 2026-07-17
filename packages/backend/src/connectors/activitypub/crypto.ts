import { logger } from '../../utils/logger';
import { FEDERATION_DOMAIN } from './constants';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

/**
 * Mention's federation KEYS ADAPTER.
 *
 * The pure HTTP-signature crypto (`signRequest` / `verifyHttpSignature`, incl.
 * the X-Forwarded-Host host reconstruction) now lives in `@oxyhq/federation` —
 * a byte-identical, app-agnostic extraction. This file is what stays app-side:
 * the two adapters that bind Mention's private-key CUSTODY to that engine.
 * `getPublicKey` and `signViaOxy` both call oxy-api (`GET /federation/public-key`
 * / `POST /federation/sign`); the private key never enters Mention. Callers pass
 * `signViaOxy` as the engine's injected signer and `getPublicKey` for the
 * instance/actor keyId.
 */

/**
 * Public-key material for an actor, as advertised in its ActivityPub `publicKey`
 * block. The private key NEVER leaves Oxy — Mention only ever sees the public
 * key (to publish) and asks Oxy to sign on its behalf (see `signViaOxy`).
 */
export interface FederationPublicKey {
  keyId: string;
  publicKeyPem: string;
}

interface OxyPublicKeyResponse {
  keyId?: unknown;
  publicKeyPem?: unknown;
}

interface OxySignResponse {
  keyId?: unknown;
  algorithm?: unknown;
  signature?: unknown;
}

// In-memory cache for public keys fetched from Oxy. Keyed by username; the value
// is mention.earth-scoped (keyId host is FEDERATION_DOMAIN) and stable, so a 1h
// TTL is plenty and avoids a network round-trip per actor render.
const publicKeyCache = new Map<string, { data: FederationPublicKey; fetchedAt: number }>();
const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Shape of the error the Oxy service client throws. It does NOT throw a plain
 * `Error`: `@oxyhq/core`'s `HttpService` funnels every failure through
 * `handleHttpError`, which returns an `ApiError` PLAIN OBJECT
 * (`{ message, code, status }`). So `err instanceof Error` is false and a naive
 * `String(err)` yields the useless `"[object Object]"`. Other client layers may
 * instead throw a real `Error` (e.g. missing service credentials) or an
 * axios-style object with `response.status`/`response.data`, so this stays wide.
 */
interface ServiceClientError {
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; statusText?: unknown; data?: unknown };
  data?: unknown;
  body?: unknown;
}

function asServiceClientError(value: unknown): ServiceClientError | undefined {
  return value && typeof value === 'object' ? (value as ServiceClientError) : undefined;
}

function coerceStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

const MAX_ERROR_DETAIL_LENGTH = 300;

/**
 * Build a meaningful log/throw message from whatever the Oxy service client
 * throws, regardless of shape. Surfaces the real HTTP status and body so a
 * `/federation/sign` outage (e.g. oxy-api returning 429) is diagnosable from
 * logs — historically these failures logged only `[object Object]`, masking the
 * incident. NEVER returns `[object Object]`.
 *
 * Note: `@oxyhq/core`'s `ApiError` discards upstream response headers, so a
 * 429's `Retry-After` is not recoverable at this layer — surfacing the `429`
 * status itself is the legibility win.
 */
function describeServiceError(err: unknown): string {
  const record = asServiceClientError(err);
  const status =
    coerceStatus(record?.status) ??
    coerceStatus(record?.statusCode) ??
    coerceStatus(record?.response?.status);

  let detail: string | undefined;
  if (err instanceof Error) {
    detail = err.message || undefined;
  } else if (record) {
    if (isNonEmptyString(record.message)) {
      detail = record.message;
    } else {
      const body = record.response?.data ?? record.data ?? record.body;
      if (isNonEmptyString(body)) {
        detail = body;
      } else if (body !== undefined && body !== null) {
        try {
          detail = JSON.stringify(body);
        } catch {
          // Non-serializable body (circular) — leave detail unset.
        }
      }
      const statusText = record.response?.statusText;
      if (!detail && isNonEmptyString(statusText)) {
        detail = statusText;
      }
    }
  }

  if (detail && detail.length > MAX_ERROR_DETAIL_LENGTH) {
    detail = `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`;
  }

  if (status !== undefined) {
    // Avoid a doubled "HTTP 429: HTTP 429: …" when the detail already names it.
    if (detail && detail.includes(String(status))) return detail;
    return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
  }
  if (detail) return detail;

  // Last resort — still never emit "[object Object]".
  try {
    const serialized = JSON.stringify(err);
    if (serialized && serialized !== '{}' && serialized !== 'null') return serialized;
  } catch {
    // Circular / non-serializable — fall through to String().
  }
  const asString = String(err);
  return asString === '[object Object]' ? 'unknown error' : asString;
}

/**
 * Fetch an actor's public key from Oxy's federation API.
 *
 * Oxy owns all federation key material. This returns the mention.earth-scoped
 * keyId (`https://<FEDERATION_DOMAIN>/ap/users/<username>#main-key`) and the
 * matching public key PEM, used to build the actor's `publicKey` block. The
 * private key is never returned. Requires a valid service token with the
 * appropriate federation permission; the OxyServices client
 * auto-acquires/refreshes it.
 */
export async function getPublicKey(username: string): Promise<FederationPublicKey> {
  const cached = publicKeyCache.get(username);
  if (cached && Date.now() - cached.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
    return cached.data;
  }

  const path = `/federation/public-key/${encodeURIComponent(username)}?domain=${encodeURIComponent(FEDERATION_DOMAIN)}`;
  let response: OxyPublicKeyResponse;
  try {
    response = await getServiceOxyClient().makeServiceRequest<OxyPublicKeyResponse>('GET', path);
  } catch (err) {
    const message = describeServiceError(err);
    // The public key drives the actor's advertised key material. Without it the
    // actor doc is incomplete and remote servers cannot verify our signatures.
    // Surface at error level — historically these failures were invisible.
    logger.error(
      `[Federation] getPublicKey failed (username=${username}, domain=${FEDERATION_DOMAIN}): ${message}`,
    );
    throw new Error(`Failed to fetch public key for ${username}: ${message}`);
  }

  if (!isNonEmptyString(response?.keyId) || !isNonEmptyString(response?.publicKeyPem)) {
    logger.error(
      `[Federation] getPublicKey returned malformed payload for username=${username}: ${JSON.stringify(response)?.slice(0, 200)}`,
    );
    throw new Error(`Malformed public-key response for ${username}`);
  }

  const data: FederationPublicKey = { keyId: response.keyId, publicKeyPem: response.publicKeyPem };
  publicKeyCache.set(username, { data, fetchedAt: Date.now() });
  logger.debug(`[Federation] public key fetched for ${username}: keyId=${data.keyId}`);
  return data;
}

/**
 * Ask Oxy to sign an HTTP-Signature signing string with the private key that
 * backs `keyId`. The private key never leaves Oxy. Returns the base64 RSA-SHA256
 * signature. Requires a service token with the appropriate federation
 * permission; the keyId host must be Mention's authorized domain (enforced by
 * Oxy).
 */
export async function signViaOxy(keyId: string, signingString: string): Promise<string> {
  let response: OxySignResponse;
  try {
    response = await getServiceOxyClient().makeServiceRequest<OxySignResponse>(
      'POST',
      '/federation/sign',
      { keyId, signingString },
    );
  } catch (err) {
    const message = describeServiceError(err);
    // A signing failure means every outbound signed request for this key fails.
    // Surface at error level so the outage is observable in production.
    logger.error(`[Federation] signViaOxy failed (keyId=${keyId}): ${message}`);
    throw new Error(`Failed to sign via Oxy for keyId ${keyId}: ${message}`);
  }

  if (!isNonEmptyString(response?.signature)) {
    logger.error(
      `[Federation] signViaOxy returned malformed payload for keyId=${keyId}: ${JSON.stringify(response)?.slice(0, 200)}`,
    );
    throw new Error(`Malformed sign response for keyId ${keyId}`);
  }

  return response.signature;
}
