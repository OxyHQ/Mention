import crypto from 'crypto';
import { logger } from '../../utils/logger';
import { AP_CONTENT_TYPE, FEDERATION_DOMAIN } from './constants';
import { getServiceOxyClient } from '../../utils/oxyHelpers';

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
    const message = err instanceof Error ? err.message : String(err);
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
    const message = err instanceof Error ? err.message : String(err);
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

/**
 * Build the HTTP Signature header per draft-cavage-http-signatures-12 and sign it
 * via Oxy (the private key never leaves Oxy).
 *
 * The spec-correct signing string is composed locally: (request-target), host,
 * date, and — for body-bearing requests — digest and content-type. The composed
 * string is sent to Oxy's `/federation/sign`, and the resulting signature is
 * assembled into the `Signature:` header.
 *
 * Returns the headers to attach to the outbound request (Host, Date, optional
 * Digest, and Signature). Content-Type is set by the deliverer's fetch.
 */
export async function signRequest(
  keyId: string,
  method: string,
  url: string,
  body?: string,
): Promise<Record<string, string>> {
  const parsedUrl = new URL(url);
  const date = new Date().toUTCString();
  const headers: Record<string, string> = {
    Host: parsedUrl.host,
    Date: date,
  };

  const signedHeaderNames = ['(request-target)', 'host', 'date'];
  const signingParts = [
    `(request-target): ${method.toLowerCase()} ${parsedUrl.pathname}${parsedUrl.search}`,
    `host: ${parsedUrl.host}`,
    `date: ${date}`,
  ];

  if (body) {
    const digest = crypto.createHash('sha256').update(body).digest('base64');
    headers['Digest'] = `SHA-256=${digest}`;
    signedHeaderNames.push('digest');
    signingParts.push(`digest: SHA-256=${digest}`);
    // Include content-type in signature (required by some servers like Threads)
    signedHeaderNames.push('content-type');
    signingParts.push(`content-type: ${AP_CONTENT_TYPE}`);
  }

  const signingString = signingParts.join('\n');
  const signature = await signViaOxy(keyId, signingString);

  headers['Signature'] = [
    `keyId="${keyId}"`,
    'algorithm="rsa-sha256"',
    `headers="${signedHeaderNames.join(' ')}"`,
    `signature="${signature}"`,
  ].join(',');

  return headers;
}

/**
 * Parse the Signature header from an incoming request.
 */
function parseSignatureHeader(signatureHeader: string): {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
} | null {
  const params: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(signatureHeader)) !== null) {
    params[match[1]] = match[2];
  }

  if (!params.keyId || !params.signature) return null;

  return {
    keyId: params.keyId,
    algorithm: params.algorithm || 'rsa-sha256',
    headers: (params.headers || 'date').split(' '),
    signature: params.signature,
  };
}

/**
 * Verify the HTTP signature on an incoming request.
 * Returns the actor URI (key owner) if valid, null otherwise.
 */
interface VerifyHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface VerifyHttpResult {
  verified: boolean;
  actorUri?: string;
  reason?: string;
}

type FetchPublicKey = (keyId: string) => Promise<{ publicKeyPem: string; actorUri: string } | null>;

export async function verifyHttpSignature(
  req: VerifyHttpRequest,
  fetchPublicKey: FetchPublicKey,
): Promise<VerifyHttpResult> {
  const signatureHeader = req.headers['signature'] as string | undefined;
  if (!signatureHeader) return { verified: false, reason: 'missing-signature' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { verified: false, reason: 'invalid-signature-header' };

  const keyData = await fetchPublicKey(parsed.keyId);
  if (!keyData) {
    logger.debug(`Failed to fetch public key for keyId: ${parsed.keyId}`);
    return { verified: false, reason: 'key-fetch-failed' };
  }

  const lowerHeaders = Object.fromEntries(
    Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])
  );

  // Enforce Date skew (+/- 10 minutes) if present
  const dateHeader = lowerHeaders['date'];
  if (dateHeader) {
    const dateVal = Array.isArray(dateHeader) ? dateHeader[0] : dateHeader;
    const parsedDate = Date.parse(dateVal || '');
    if (!Number.isNaN(parsedDate)) {
      const skew = Math.abs(Date.now() - parsedDate);
      if (skew > 10 * 60 * 1000) {
        return { verified: false, reason: 'date-skew' };
      }
    }
  }

  // If Digest header is required in signature but missing/invalid, fail early
  if (parsed.headers.includes('digest')) {
    const digestHeader = lowerHeaders['digest'];
    const bodyString = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : '';
    if (!digestHeader) {
      return { verified: false, reason: 'missing-digest' };
    }
    const expectedDigest = `SHA-256=${crypto.createHash('sha256').update(bodyString).digest('base64')}`;
    const digestVal = Array.isArray(digestHeader) ? digestHeader[0] : digestHeader;
    if (digestVal !== expectedDigest) {
      return { verified: false, reason: 'digest-mismatch' };
    }
  }

  const signingParts = parsed.headers.map((header) => {
    if (header === '(request-target)') {
      return `(request-target): ${req.method.toLowerCase()} ${req.path}`;
    }
    const value = lowerHeaders[header.toLowerCase()];
    return `${header.toLowerCase()}: ${Array.isArray(value) ? value[0] : value}`;
  });

  const signingString = signingParts.join('\n');
  const verifier = crypto.createVerify('sha256');
  verifier.update(signingString);
  verifier.end();

  try {
    const isValid = verifier.verify(keyData.publicKeyPem, parsed.signature, 'base64');
    return { verified: isValid, actorUri: isValid ? keyData.actorUri : undefined, reason: isValid ? undefined : 'verify-failed' };
  } catch (err) {
    logger.debug('HTTP signature verification failed:', err);
    return { verified: false, reason: err instanceof Error ? err.message : 'verify-exception' };
  }
}
