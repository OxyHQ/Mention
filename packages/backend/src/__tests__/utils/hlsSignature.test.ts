import { describe, it, expect, vi } from 'vitest';

/**
 * The signature is the whole reason `/media/proxy` can relay the
 * `application/octet-stream` segments object stores serve without becoming a
 * relay for arbitrary binaries. What matters is that it is unforgeable and
 * bound to the exact upstream url.
 */

vi.mock('../../config', () => ({
  getOxyServiceCredentials: () => ({ apiSecret: 'test-service-secret' }),
}));

import { isSignedHlsComponent, signHlsComponentUrl } from '../../utils/hlsSignature';

const SEGMENT = 'https://video.cdn.bsky.app/hls/did:plc:abc/cid/720p/video0.ts';

describe('HLS component signatures', () => {
  it('verifies a signature it produced for the same url', () => {
    const signature = signHlsComponentUrl(SEGMENT);
    expect(signature).not.toBeNull();
    expect(isSignedHlsComponent(SEGMENT, signature)).toBe(true);
  });

  it('is stable for a given url, so segment urls stay cacheable', () => {
    expect(signHlsComponentUrl(SEGMENT)).toBe(signHlsComponentUrl(SEGMENT));
  });

  it('does NOT verify against a different url', () => {
    const signature = signHlsComponentUrl(SEGMENT);
    expect(isSignedHlsComponent('https://evil.example/payload.bin', signature)).toBe(false);
  });

  it('rejects a missing, empty, malformed or wrong signature', () => {
    expect(isSignedHlsComponent(SEGMENT, undefined)).toBe(false);
    expect(isSignedHlsComponent(SEGMENT, '')).toBe(false);
    expect(isSignedHlsComponent(SEGMENT, 'not-base64url!!')).toBe(false);
    expect(isSignedHlsComponent(SEGMENT, signHlsComponentUrl('https://other.example/x.ts'))).toBe(false);
  });

  it('rejects a non-string signature (a repeated query parameter arrives as an array)', () => {
    const signature = signHlsComponentUrl(SEGMENT);
    expect(isSignedHlsComponent(SEGMENT, [signature])).toBe(false);
  });
});
