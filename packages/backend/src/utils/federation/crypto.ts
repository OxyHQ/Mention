import crypto from 'crypto';
import { logger } from '../logger';
import { OXY_API_URL, AP_CONTENT_TYPE } from './constants';
import { getServiceOxyClient } from '../oxyHelpers';

interface KeyPairData {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

// In-memory cache for key pairs fetched from Oxy
const keyPairCache = new Map<string, { data: KeyPairData; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch a key pair from Oxy's federation API.
 * Oxy manages all key pairs; Mention uses them for signing.
 * The endpoint requires a valid service token (serviceAuthMiddleware).
 */
export async function getKeyPair(username: string): Promise<KeyPairData> {
  const cached = keyPairCache.get(username);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `${OXY_API_URL}/federation/keypair/${encodeURIComponent(username)}`;
  logger.debug(`[FedSync] fetching key pair from ${url}`);

  // Obtain a service token via the OxyServices client (auto-acquires/refreshes)
  const headers: Record<string, string> = {};
  try {
    const serviceToken = await getServiceOxyClient().getServiceToken();
    headers['Authorization'] = `Bearer ${serviceToken}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug(`[FedSync] Could not get service token for keypair fetch: ${message}`);
    // Fall back to no auth (may work in dev if serviceAuthMiddleware is relaxed)
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch key pair for ${username}: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json() as KeyPairData;
  logger.debug(`[FedSync] key pair fetched for ${username}: keyId=${data.keyId}`);
  keyPairCache.set(username, { data, fetchedAt: Date.now() });
  return data;
}

/**
 * Build the HTTP Signature header string per draft-cavage-http-signatures-12.
 * Signs (request-target), host, date, and optionally digest.
 */
export function signRequest(
  privateKeyPem: string,
  keyId: string,
  method: string,
  url: string,
  body?: string,
): Record<string, string> {
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
  const signer = crypto.createSign('sha256');
  signer.update(signingString);
  signer.end();
  const signature = signer.sign(privateKeyPem, 'base64');

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
