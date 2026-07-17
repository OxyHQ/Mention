import { beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

const ACTOR_URI = 'https://mastodon.social/users/alice';
const KEY_ID = `${ACTOR_URI}#main-key`;
const INBOX_URL = 'https://mention.earth/ap/inbox';

// Integration test of Mention's federation SIGNING wiring: the pure HTTP-signature
// crypto now lives in `@oxyhq/federation`, and Mention supplies the private-key
// custody via `signViaOxy` (crypto.ts), which signs via Oxy's `/federation/sign`.
// Stub the service client so `signViaOxy` performs the RSA signature locally with
// the test private key — preserving an end-to-end sign/verify round-trip through
// the REAL adapter (crypto.ts → @oxyhq/federation) without the Oxy client/network.
// Uses `vi.hoisted` so the holder exists before the hoisted `vi.mock` factory runs;
// `beforeAll` fills in the generated private key.
const signing = vi.hoisted(() => ({ privateKeyPem: '' }));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    makeServiceRequest: async (_method: string, _url: string, data?: { signingString?: string }) => {
      const signer = crypto.createSign('sha256');
      signer.update(data?.signingString ?? '');
      signer.end();
      return {
        keyId: KEY_ID,
        algorithm: 'rsa-sha256',
        signature: signer.sign(signing.privateKeyPem, 'base64'),
      };
    },
  }),
}));

import { signRequest, verifyHttpSignature } from '@oxyhq/federation';
import { signViaOxy } from '../../connectors/activitypub/crypto';
import { AP_CONTENT_TYPE } from '../../connectors/activitypub/constants';

let publicKeyPem: string;

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
  signing.privateKeyPem = privateKey;
});

describe('verifyHttpSignature (via Mention signViaOxy adapter)', () => {
  it('verifies a valid signature produced by signRequest and returns the actor URI', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

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
    const signed = await signRequest(signViaOxy, 'https://other/key#main', 'POST', INBOX_URL, body);

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: lowerHeaders(signed), body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('key-fetch-failed');
  });

  it('rejects when the body is tampered after signing (digest mismatch)', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

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
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

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
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);
    const stale = lowerHeaders(signed);
    stale.date = new Date(Date.now() - 30 * 60 * 1000).toUTCString(); // 30 min ago

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers: stale, body },
      fetchPublicKey,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('date-skew');
  });

  // The sender signs over `host: mention.earth` (INBOX_URL host). The apex is
  // CF-proxied → ALB → backend, which rewrites the origin Host to
  // api.mention.earth and forwards the ORIGINAL signed host in X-Forwarded-Host.
  // Mention passes `trustForwardedHost: true` (as ap.routes.ts does in prod) so
  // the verifier rebuilds the `host` signing line from X-Forwarded-Host.
  it('verifies when received via the origin host with x-forwarded-host carrying the signed apex', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

    const headers = lowerHeaders(signed);
    headers.host = 'api.mention.earth';
    headers['x-forwarded-host'] = 'mention.earth';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );

    expect(result.verified).toBe(true);
    expect(result.actorUri).toBe(ACTOR_URI);
  });

  it('falls back to the host header when x-forwarded-host is absent (direct delivery)', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

    const headers = lowerHeaders(signed);
    expect(headers['x-forwarded-host']).toBeUndefined();

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );

    expect(result.verified).toBe(true);
    expect(result.actorUri).toBe(ACTOR_URI);
  });

  it('uses only the first token of a comma-separated x-forwarded-host list', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

    const headers = lowerHeaders(signed);
    headers.host = 'api.mention.earth';
    // A proxy chain appends its own hosts; the client-facing (signed) host is first.
    headers['x-forwarded-host'] = 'mention.earth, proxy-a.internal, proxy-b.internal';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );

    expect(result.verified).toBe(true);
    expect(result.actorUri).toBe(ACTOR_URI);
  });

  it('fails verification when x-forwarded-host does not match the signed host', async () => {
    const body = JSON.stringify({ type: 'Create', id: 'https://remote/a/1' });
    const signed = await signRequest(signViaOxy, KEY_ID, 'POST', INBOX_URL, body);

    const headers = lowerHeaders(signed);
    headers.host = 'api.mention.earth';
    headers['x-forwarded-host'] = 'evil.example';

    const result = await verifyHttpSignature(
      { method: 'POST', path: new URL(INBOX_URL).pathname, headers, body },
      fetchPublicKey,
      { trustForwardedHost: true },
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('verify-failed');
  });
});
