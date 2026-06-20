import { beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

// crypto.ts imports getServiceOxyClient (only used by getKeyPair). Stub it so we
// don't pull in the Oxy client graph for the pure sign/verify round-trip.
vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(),
}));

import { signRequest, verifyHttpSignature } from '../../utils/federation/crypto';
import { AP_CONTENT_TYPE } from '../../utils/federation/constants';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const KEY_ID = `${ACTOR_URI}#main-key`;
const INBOX_URL = 'https://mention.earth/ap/inbox';

let publicKeyPem: string;
let privateKeyPem: string;

/** Resolve the test key for the signing actor; null for any other keyId. */
const fetchPublicKey = vi.fn(async (keyId: string) =>
  keyId === KEY_ID ? { publicKeyPem, actorUri: ACTOR_URI } : null,
);

/**
 * Lowercase the header map exactly as Express delivers req.headers. `signRequest`
 * signs `content-type` for body-bearing requests but emits it via the HTTP
 * Content-Type header (set by the deliverer's fetch), not in the returned signed
 * header map — so the receiver carries it as a real request header. Reproduce
 * that here so the reconstructed signing string matches.
 */
function lowerHeaders(headers: Record<string, string>): Record<string, string> {
  const lowered = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  if (lowered.digest && !lowered['content-type']) {
    lowered['content-type'] = AP_CONTENT_TYPE;
  }
  return lowered;
}

beforeAll(() => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKeyPem = publicKey;
  privateKeyPem = privateKey;
});

describe('verifyHttpSignature', () => {
  it('verifies a valid signature produced by signRequest and returns the actor URI', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = signRequest(privateKeyPem, KEY_ID, 'POST', INBOX_URL, body);

    const result = await verifyHttpSignature(
      {
        method: 'POST',
        path: new URL(INBOX_URL).pathname,
        headers: lowerHeaders(signed),
        body,
      },
      fetchPublicKey,
    );

    expect(result.verified).toBe(true);
    expect(result.actorUri).toBe(ACTOR_URI);
  });

  it('rejects when the Signature header is missing', async () => {
    const result = await verifyHttpSignature(
      { method: 'POST', path: '/ap/inbox', headers: {}, body: '' },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('missing-signature');
  });

  it('rejects when the public key cannot be fetched', async () => {
    const body = JSON.stringify({ type: 'Create' });
    const signed = signRequest(privateKeyPem, 'https://other/key#main', 'POST', INBOX_URL, body);

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: lowerHeaders(signed), body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('key-fetch-failed');
  });

  it('rejects when the body is tampered after signing (digest mismatch)', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = signRequest(privateKeyPem, KEY_ID, 'POST', INBOX_URL, body);

    const result = await verifyHttpSignature(
      {
        method: 'POST',
        path: new URL(INBOX_URL).pathname,
        headers: lowerHeaders(signed),
        body: JSON.stringify({ type: 'Create', id: 'https://remote/a/TAMPERED' }),
      },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('digest-mismatch');
  });

  it('rejects when the signed string does not match (verify-failed)', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = signRequest(privateKeyPem, KEY_ID, 'POST', INBOX_URL, body);

    // Change the request path so the reconstructed (request-target) differs from
    // what was signed — digest still matches, but the RSA verification fails.
    const result = await verifyHttpSignature(
      {
        method: 'POST',
        path: '/ap/different-inbox',
        headers: lowerHeaders(signed),
        body,
      },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('verify-failed');
  });

  it('rejects when the Date header is outside the allowed skew', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = signRequest(privateKeyPem, KEY_ID, 'POST', INBOX_URL, body);
    const stale = lowerHeaders(signed);
    stale.date = new Date(Date.now() - 30 * 60 * 1000).toUTCString(); // 30 min ago

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: stale, body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('date-skew');
  });
});
