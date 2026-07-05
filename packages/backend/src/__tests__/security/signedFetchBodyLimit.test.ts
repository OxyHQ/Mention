import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signRequest: vi.fn(),
  fetchUpstreamSingleHop: vi.fn(),
}));

vi.mock('../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signRequest: mocks.signRequest,
}));

vi.mock('../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/safeUpstreamFetch')>();
  return {
    ...actual,
    fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop,
  };
});

import {
  signedFetch,
  SIGNED_FETCH_MAX_ACTIVITYPUB_JSON_BYTES,
} from '../../connectors/activitypub/helpers';

function streamFromChunks(chunks: Buffer[]): PassThrough {
  const stream = new PassThrough();
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return stream;
}

describe('signedFetch ActivityPub body size limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPublicKey.mockResolvedValue({
      keyId: 'https://mention.test/ap/actor#main-key',
    });
    mocks.signRequest.mockResolvedValue({ Signature: 'sig' });
  });

  it('rejects an oversized ActivityPub response before buffering it all', async () => {
    const firstChunk = Buffer.alloc(
      SIGNED_FETCH_MAX_ACTIVITYPUB_JSON_BYTES,
      'a',
    );
    const overflowChunk = Buffer.from('x');
    const response = streamFromChunks([firstChunk, overflowChunk]);
    const destroySpy = vi.spyOn(response, 'destroy');

    mocks.fetchUpstreamSingleHop.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/activity+json' },
      response,
    });

    await expect(
      signedFetch(
        'https://remote.example/users/alice',
        'application/activity+json',
      ),
    ).rejects.toThrow(
      `ActivityPub response exceeded ${SIGNED_FETCH_MAX_ACTIVITYPUB_JSON_BYTES} bytes`,
    );
    expect(destroySpy).toHaveBeenCalled();
  });

  it('rejects oversized responses from content-length without draining the stream', async () => {
    const response = streamFromChunks([Buffer.from('{}')]);
    const destroySpy = vi.spyOn(response, 'destroy');

    mocks.fetchUpstreamSingleHop.mockResolvedValue({
      status: 200,
      headers: {
        'content-type': 'application/activity+json',
        'content-length': String(SIGNED_FETCH_MAX_ACTIVITYPUB_JSON_BYTES + 1),
      },
      response,
    });

    await expect(
      signedFetch(
        'https://remote.example/users/alice',
        'application/activity+json',
      ),
    ).rejects.toThrow(
      `ActivityPub response exceeded ${SIGNED_FETCH_MAX_ACTIVITYPUB_JSON_BYTES} bytes`,
    );
    expect(destroySpy).toHaveBeenCalled();
  });

  it('preserves normal bounded ActivityPub responses', async () => {
    const body = JSON.stringify({
      id: 'https://remote.example/users/alice',
      type: 'Person',
    });
    mocks.fetchUpstreamSingleHop.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/activity+json' },
      response: streamFromChunks([Buffer.from(body)]),
    });

    const res = await signedFetch(
      'https://remote.example/users/alice',
      'application/activity+json',
    );

    expect(res.ok).toBe(true);
    await expect(res.json()).resolves.toEqual({
      id: 'https://remote.example/users/alice',
      type: 'Person',
    });
  });
});
