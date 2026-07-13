import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Error legibility for the Oxy federation-signing calls in
 * `connectors/activitypub/crypto.ts`.
 *
 * The Oxy service client does NOT throw a plain `Error`: `@oxyhq/core`'s
 * `HttpService` funnels failures through `handleHttpError`, which returns an
 * `ApiError` PLAIN OBJECT (`{ message, code, status }`). The old
 * `err instanceof Error ? err.message : String(err)` therefore logged the
 * useless `"[object Object]"`, which masked a real prod incident (oxy-api
 * `/federation/sign` returning 429). These tests assert the real HTTP status is
 * surfaced in both the log line and the re-thrown error, for every thrown shape.
 */

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest: mocks.makeServiceRequest }),
}));

import { getPublicKey, signViaOxy } from '../../../connectors/activitypub/crypto';

/** The single log-line string passed to `logger.error` on the most recent call. */
function lastErrorLog(): string {
  const calls = mocks.loggerError.mock.calls;
  return String(calls[calls.length - 1]?.[0] ?? '');
}

describe('signViaOxy error legibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces the HTTP status from an ApiError plain object (429), never [object Object]', async () => {
    // Exact shape @oxyhq/core throws: a plain object, NOT an Error instance.
    mocks.makeServiceRequest.mockRejectedValueOnce({
      message: 'Too many requests',
      code: 'RATE_LIMITED',
      status: 429,
    });

    await expect(signViaOxy('key#main', 'signing-string')).rejects.toThrow(/429/);

    const log = lastErrorLog();
    expect(log).toContain('429');
    expect(log).not.toContain('[object Object]');
  });

  it('surfaces status + body from an axios-style { response: { status, data } } object', async () => {
    mocks.makeServiceRequest.mockRejectedValueOnce({
      response: { status: 503, data: { error: 'sign service down' } },
    });

    await expect(signViaOxy('key#main', 'signing-string')).rejects.toThrow(/503/);

    const log = lastErrorLog();
    expect(log).toContain('503');
    expect(log).not.toContain('[object Object]');
  });

  it('uses .message for a real Error instance', async () => {
    mocks.makeServiceRequest.mockRejectedValueOnce(
      new Error('Service credentials not provided'),
    );

    await expect(signViaOxy('key#main', 'signing-string')).rejects.toThrow(
      /Service credentials not provided/,
    );

    const log = lastErrorLog();
    expect(log).toContain('Service credentials not provided');
    expect(log).not.toContain('[object Object]');
  });

  it('never emits [object Object] even for an opaque object with no known fields', async () => {
    mocks.makeServiceRequest.mockRejectedValueOnce({ weird: 'shape' });

    await expect(signViaOxy('key#main', 'signing-string')).rejects.toThrow();

    const log = lastErrorLog();
    expect(log).not.toContain('[object Object]');
    expect(log).toContain('weird');
  });
});

describe('getPublicKey error legibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces the HTTP status from an ApiError plain object (429), never [object Object]', async () => {
    mocks.makeServiceRequest.mockRejectedValueOnce({
      message: 'Too many requests',
      code: 'RATE_LIMITED',
      status: 429,
    });

    await expect(getPublicKey('alice')).rejects.toThrow(/429/);

    const log = lastErrorLog();
    expect(log).toContain('429');
    expect(log).not.toContain('[object Object]');
  });
});
