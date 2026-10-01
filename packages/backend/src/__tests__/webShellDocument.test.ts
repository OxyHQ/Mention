import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  SHELL_TTL_MS,
  getShell,
  invalidateShellDocument,
  resetShellDocumentForTests,
} from '../services/webShellDocument';

/**
 * The shell document is a promise that the chunks it names exist. The Worker
 * drops the previous release's chunks on every deploy, so a copy that outlives
 * a deploy is a copy that breaks the app (the incident of 2026-09-30: a
 * ten-minute copy sent browsers to chunks that had already 404ed).
 */

const RELEASE_A = '<html><script src="/_expo/static/js/web/__common-aaaaaaaa.js"></script></html>';
const RELEASE_B = '<html><script src="/_expo/static/js/web/__common-bbbbbbbb.js"></script></html>';

function response(status: number, body: string, etag: string | null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' && etag ? etag : null) },
  };
}

/** Let the fire-and-forget background revalidation settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('web shell document cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetShellDocumentForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('trusts a fetched document only for seconds, not minutes', () => {
    expect(SHELL_TTL_MS).toBeLessThanOrEqual(30_000);
  });

  it('serves from memory inside the TTL without another request', async () => {
    const fetchMock = vi.fn(async () => response(200, RELEASE_A, '"a"'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getShell()).toBe(RELEASE_A);
    vi.advanceTimersByTime(SHELL_TTL_MS - 1);
    expect(await getShell()).toBe(RELEASE_A);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates with the ETag once the TTL passes, and a 304 keeps the copy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, RELEASE_A, '"a"'))
      .mockResolvedValueOnce(response(304, '', null));
    vi.stubGlobal('fetch', fetchMock);

    await getShell();
    vi.advanceTimersByTime(SHELL_TTL_MS + 1);
    expect(await getShell()).toBe(RELEASE_A); // stale copy served while it revalidates
    await settle();

    const revalidation = fetchMock.mock.calls[1][1] as { headers: Record<string, string> };
    expect(revalidation.headers['If-None-Match']).toBe('"a"');

    // The 304 renewed the copy: no third request inside the next TTL.
    vi.advanceTimersByTime(SHELL_TTL_MS - 1);
    await getShell();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('picks up a new release within one TTL plus one request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, RELEASE_A, '"a"'))
      .mockResolvedValueOnce(response(200, RELEASE_B, '"b"'));
    vi.stubGlobal('fetch', fetchMock);

    await getShell();
    vi.advanceTimersByTime(SHELL_TTL_MS + 1);
    await getShell();
    await settle();

    expect(await getShell()).toBe(RELEASE_B);
  });

  it('stops trusting the copy the moment a chunk it names is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, RELEASE_A, '"a"'))
      .mockResolvedValueOnce(response(200, RELEASE_B, '"b"'));
    vi.stubGlobal('fetch', fetchMock);

    await getShell();
    invalidateShellDocument(); // well inside the TTL
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getShell()).toBe(RELEASE_B);
  });

  it('keeps serving the held copy when the origin is down', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(200, RELEASE_A, '"a"'))
      .mockResolvedValue(response(503, '', null));
    vi.stubGlobal('fetch', fetchMock);

    await getShell();
    vi.advanceTimersByTime(SHELL_TTL_MS + 1);

    expect(await getShell()).toBe(RELEASE_A);
    await settle();
    expect(await getShell()).toBe(RELEASE_A);
  });

  it('has nothing to invalidate before the first fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    invalidateShellDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
