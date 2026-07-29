import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SSRF regression proof for the media-proxy transport AFTER the Phase 1
 * convergence onto `@oxyhq/core/server`.
 *
 * These exercise the REAL guard: `fetchUpstreamFollowingRedirects` /
 * `fetchUpstreamSingleHop` call `assertSafePublicUrl` (now sourced from
 * `@oxyhq/core/server`) on hop 0 AND on every redirect hop. Only the socket
 * layer (`node:http` `request`) is mocked, so the private/metadata denylist and
 * the per-hop re-validation run for real — a redirect that points at an internal
 * address must still be rejected, never followed.
 *
 * No supertest here: mocking `http.request` globally would hijack supertest's
 * own client, so the route-level media-type/range checks live in a separate file
 * (mediaProxySsrf.test.ts) that mocks the transport instead.
 */

interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  destroyed: boolean;
  destroy: () => void;
  resume: () => void;
  setTimeout: () => void;
}

function makeFakeResponse(statusCode: number, headers: Record<string, string> = {}): FakeResponse {
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = statusCode;
  res.headers = headers;
  res.destroyed = false;
  res.destroy = vi.fn(() => {
    res.destroyed = true;
  });
  res.resume = vi.fn();
  res.setTimeout = vi.fn();
  return res;
}

/** FIFO queue of fake upstream responses; one is consumed per `http.request`. */
let pendingResponses: FakeResponse[] = [];
/** Records the URL path each hop actually dialed, so we can assert re-validation. */
let dialedPaths: string[] = [];

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const request = (options: { path?: string }, cb: (res: FakeResponse) => void) => {
    dialedPaths.push(options.path ?? '');
    const res = pendingResponses.shift();
    if (!res) throw new Error('no fake response queued for request');
    queueMicrotask(() => cb(res));
    return { setTimeout: (): void => {}, on: (): void => {}, end: (): void => {} };
  };
  // `safeUpstreamFetch` does `import http from 'node:http'` (default) and calls
  // `http.request`; provide the override on BOTH the namespace and the synthetic
  // default so either import shape resolves to the mock.
  const mocked = { ...actual, request };
  return { ...mocked, default: mocked };
});

import {
  fetchUpstreamFollowingRedirects,
  fetchUpstreamSingleHop,
} from '../../utils/safeUpstreamFetch';
import { SsrfRejection } from '@oxyhq/core/server';

const signal = new AbortController().signal;

beforeEach(() => {
  pendingResponses = [];
  dialedPaths = [];
});

describe('media-proxy transport — SSRF blocking (real core guard)', () => {
  it('rejects a private/internal IP before opening any socket', async () => {
    await expect(
      fetchUpstreamFollowingRedirects('http://127.0.0.1/secret', {}, signal),
    ).rejects.toBeInstanceOf(SsrfRejection);
    // The guard short-circuits — no socket was ever dialed.
    expect(dialedPaths).toEqual([]);
  });

  it('rejects the cloud metadata IP on a single-hop signed-style fetch', async () => {
    await expect(
      fetchUpstreamSingleHop('http://169.254.169.254/latest/meta-data/', {
        headers: {},
        signal,
      }),
    ).rejects.toBeInstanceOf(SsrfRejection);
    expect(dialedPaths).toEqual([]);
  });

  it('re-validates each redirect hop and rejects a redirect INTO an internal IP', async () => {
    // hop 0 is a public literal IP (passes the guard, no DNS) and returns a 302
    // whose Location points at the cloud-metadata address. The loop must
    // re-validate hop 1 and reject it — never following the redirect.
    pendingResponses = [
      makeFakeResponse(302, { location: 'http://169.254.169.254/latest/meta-data/' }),
    ];

    await expect(
      fetchUpstreamFollowingRedirects('http://8.8.8.8/redir', {}, signal),
    ).rejects.toBeInstanceOf(SsrfRejection);

    // Exactly one socket was dialed (hop 0); the internal redirect target was
    // rejected by the guard BEFORE any second socket opened.
    expect(dialedPaths).toEqual(['/redir']);
  });

  it('rejects a redirect that resolves to a literal loopback address', async () => {
    pendingResponses = [makeFakeResponse(301, { location: 'http://127.0.0.1:80/internal' })];

    await expect(
      fetchUpstreamFollowingRedirects('http://8.8.8.8/start', {}, signal),
    ).rejects.toBeInstanceOf(SsrfRejection);
    expect(dialedPaths).toEqual(['/start']);
  });

  it('still FOLLOWS a redirect to another public host (redirects are not broken)', async () => {
    // Proves the convergence did not over-block: a public→public redirect chain
    // is followed and the final non-redirect response is returned.
    pendingResponses = [
      makeFakeResponse(302, { location: 'http://1.1.1.1/final.jpg' }),
      makeFakeResponse(200, { 'content-type': 'image/jpeg' }),
    ];

    const result = await fetchUpstreamFollowingRedirects('http://8.8.8.8/start', {}, signal);

    expect(result.finalUrl).toBe('http://1.1.1.1/final.jpg');
    expect(result.response.statusCode).toBe(200);
    // Both hops were dialed, in order.
    expect(dialedPaths).toEqual(['/start', '/final.jpg']);
  });
});

/**
 * `preValidated` — the hop-0 guard reuse `/media/proxy` relies on so that
 * validating the URL before it can reach the cache store costs no extra DNS
 * resolution. The load-bearing property is that the reuse is scoped to hop 0
 * ONLY: a redirect targets a different URL and must always be validated afresh.
 */
describe('media-proxy transport — preValidated hop-0 guard reuse', () => {
  const PRE_VALIDATED = { ok: true, ip: '8.8.8.8', family: 4 } as const;

  it('reuses the caller guard for hop 0 instead of re-resolving', async () => {
    pendingResponses = [makeFakeResponse(200, { 'content-type': 'image/jpeg' })];

    // A URL the real guard REJECTS. It is dialed anyway, which is only possible
    // if hop 0 consumed the caller's guard rather than running its own check —
    // the observable proof that the second resolution is genuinely skipped.
    const result = await fetchUpstreamFollowingRedirects(
      'http://127.0.0.1/cached.jpg',
      {},
      signal,
      PRE_VALIDATED,
    );

    expect(result.response.statusCode).toBe(200);
    expect(dialedPaths).toEqual(['/cached.jpg']);
  });

  it('does NOT let the reused guard cover a redirect hop into an internal IP', async () => {
    pendingResponses = [
      makeFakeResponse(302, { location: 'http://169.254.169.254/latest/meta-data/' }),
    ];

    await expect(
      fetchUpstreamFollowingRedirects('http://8.8.8.8/redir', {}, signal, PRE_VALIDATED),
    ).rejects.toBeInstanceOf(SsrfRejection);

    // Hop 1 was validated for real and rejected before a second socket opened.
    expect(dialedPaths).toEqual(['/redir']);
  });

  it('validates hop 0 for real when no caller guard is supplied', async () => {
    await expect(
      fetchUpstreamFollowingRedirects('http://127.0.0.1/secret', {}, signal),
    ).rejects.toBeInstanceOf(SsrfRejection);
    expect(dialedPaths).toEqual([]);
  });
});
