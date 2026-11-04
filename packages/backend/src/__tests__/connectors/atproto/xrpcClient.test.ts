import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared atproto GET is where Mention backs off a rate-limited host: a 429
 * pauses the host for as long as it asked and the request is retried; a pause
 * too long to wait out fails fast for every caller; and no host ever has more
 * than `MAX_IN_FLIGHT_PER_HOST` requests open at once.
 */

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  readResponseBody: vi.fn(),
}));

vi.mock('@oxy.so/core/server', () => ({
  safeFetch: mocks.safeFetch,
  readResponseBody: mocks.readResponseBody,
}));

import { MAX_IN_FLIGHT_PER_HOST, XrpcError, xrpcGet } from '../../../connectors/atproto/xrpcClient';

function answer(status: number, headers: Record<string, string> = {}) {
  return { response: { destroy: vi.fn() }, status, headers, finalUrl: '' };
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.safeFetch.mockReset();
  mocks.readResponseBody.mockReset();
  mocks.readResponseBody.mockResolvedValue({ kind: 'ok', body: Buffer.from('{"ok":true}') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('xrpcGet rate limiting', () => {
  it('waits out a 429 Retry-After, then retries', async () => {
    mocks.safeFetch
      .mockResolvedValueOnce(answer(429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(answer(200));

    const result = xrpcGet('retry.example', 'app.bsky.actor.getProfile', { actor: 'did:plc:a' });
    await vi.advanceTimersByTimeAsync(1_900);
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({ ok: true });
    expect(mocks.safeFetch).toHaveBeenCalledTimes(2);
  });

  it('fails fast while a host is paused for longer than a request may wait', async () => {
    mocks.safeFetch.mockResolvedValueOnce(answer(429, { 'retry-after': '600' }));

    await expect(xrpcGet('paused.example', 'app.bsky.feed.getAuthorFeed')).rejects.toMatchObject({
      status: 429,
    });
    // A second caller does not touch the paused host at all.
    await expect(xrpcGet('paused.example', 'app.bsky.feed.getAuthorFeed')).rejects.toBeInstanceOf(
      XrpcError,
    );
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps at most MAX_IN_FLIGHT_PER_HOST requests open against one host', async () => {
    const pending: Array<(value: ReturnType<typeof answer>) => void> = [];
    mocks.safeFetch.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve as (value: unknown) => void)),
    );

    const calls = Array.from({ length: MAX_IN_FLIGHT_PER_HOST + 2 }, () =>
      xrpcGet('busy.example', 'app.bsky.feed.getPosts', { uris: ['at://a', 'at://b'] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.safeFetch).toHaveBeenCalledTimes(MAX_IN_FLIGHT_PER_HOST);
    expect(mocks.safeFetch.mock.calls[0][0]).toBe(
      'https://busy.example/xrpc/app.bsky.feed.getPosts?uris=at%3A%2F%2Fa&uris=at%3A%2F%2Fb',
    );

    pending.shift()?.(answer(200));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.safeFetch).toHaveBeenCalledTimes(MAX_IN_FLIGHT_PER_HOST + 1);

    for (let i = 0; i < calls.length; i++) {
      pending.shift()?.(answer(200));
      await vi.advanceTimersByTimeAsync(0);
    }
    await expect(Promise.all(calls)).resolves.toHaveLength(MAX_IN_FLIGHT_PER_HOST + 2);
  });
});
