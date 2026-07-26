import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

// This suite exercises the bounded stream/deadline adapter directly; signing is
// outside its scope and the optional federation package is not needed.
vi.mock('@oxyhq/federation/node', () => ({
  createSignedFetch: vi.fn(),
}));
vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
}));
vi.mock('../../../connectors/activitypub/constants', () => ({
  AP_CONTENT_TYPE: 'application/activity+json',
  USER_AGENT: 'MentionTest/1.0',
  extractLocalPostIdFromApUri: vi.fn(),
}));

import {
  ACTIVITYPUB_BODY_IDLE_TIMEOUT_MS,
  ACTIVITYPUB_FETCH_DEADLINE_MS,
  ACTIVITYPUB_JSON_MAX_BYTES,
  singleHopToResponse,
  withActivityPubDeadline,
} from '../../../connectors/activitypub/helpers';
import type { SingleHopResult } from '../../../utils/safeUpstreamFetch';

function singleHop(
  stream: PassThrough,
  headers: Record<string, string> = {
    'content-type': 'application/activity+json',
  },
  status = 200,
): SingleHopResult {
  return {
    response: stream as unknown as IncomingMessage,
    status,
    headers,
  };
}

describe('ActivityPub remote JSON transport limits', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts a bounded ActivityPub JSON response', async () => {
    const stream = new PassThrough();
    stream.end(JSON.stringify({ type: 'Person' }));

    const response = await singleHopToResponse(singleHop(stream));

    await expect(response.json()).resolves.toEqual({ type: 'Person' });
  });

  it('rejects a successful non-JSON response before buffering it', async () => {
    const stream = new PassThrough();
    stream.end('<html>not an actor</html>');

    await expect(singleHopToResponse(singleHop(stream, {
      'content-type': 'text/html; charset=utf-8',
    }))).rejects.toThrow('unsupported content-type');
    expect(stream.destroyed).toBe(true);
  });

  it('rejects an oversized declared content length before reading', async () => {
    const stream = new PassThrough();

    await expect(singleHopToResponse(singleHop(stream, {
      'content-type': 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
      'content-length': String(ACTIVITYPUB_JSON_MAX_BYTES + 1),
    }))).rejects.toThrow(`exceeds ${ACTIVITYPUB_JSON_MAX_BYTES} bytes`);
    expect(stream.destroyed).toBe(true);
  });

  it('enforces the same byte cap on a chunked body', async () => {
    const stream = new PassThrough();
    stream.end(Buffer.alloc(ACTIVITYPUB_JSON_MAX_BYTES + 1, 0x20));

    await expect(singleHopToResponse(singleHop(stream))).rejects.toThrow(
      `exceeds ${ACTIVITYPUB_JSON_MAX_BYTES} bytes`,
    );
    expect(stream.destroyed).toBe(true);
  });

  it('destroys a response body that goes idle for five seconds', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const responsePromise = singleHopToResponse(singleHop(stream));
    const rejection = expect(responsePromise).rejects.toThrow('body idle timeout');

    await vi.advanceTimersByTimeAsync(ACTIVITYPUB_BODY_IDLE_TIMEOUT_MS + 1);

    await rejection;
    expect(stream.destroyed).toBe(true);
  });

  it('aborts the underlying operation at the total deadline', async () => {
    vi.useFakeTimers();
    let operationSignal: AbortSignal | undefined;
    const responsePromise = withActivityPubDeadline(
      (signal) => new Promise<never>(() => {
        operationSignal = signal;
      }),
    );
    const rejection = expect(responsePromise).rejects.toThrow('fetch deadline exceeded');

    await vi.advanceTimersByTimeAsync(ACTIVITYPUB_FETCH_DEADLINE_MS + 1);

    await rejection;
    expect(operationSignal?.aborted).toBe(true);
  });

  it('forwards a caller abort into the composed transport signal', async () => {
    const caller = new AbortController();
    const reason = new Error('caller cancelled');
    let operationSignal: AbortSignal | undefined;
    const responsePromise = withActivityPubDeadline(
      (signal) => new Promise<never>(() => {
        operationSignal = signal;
      }),
      caller.signal,
    );

    caller.abort(reason);

    await expect(responsePromise).rejects.toBe(reason);
    expect(operationSignal?.aborted).toBe(true);
  });

  it('does not start work when the caller signal is already aborted', async () => {
    const caller = new AbortController();
    const reason = new Error('already cancelled');
    caller.abort(reason);
    const operation = vi.fn(() => new Promise<never>(() => {}));

    await expect(withActivityPubDeadline(operation, caller.signal)).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
  });
});
