/**
 * Tests run under either jest (frontend `jest-expo` preset) or vitest
 * (workspace runner). Both provide the same describe/it/expect globals.
 */

import { AxiosError, AxiosHeaders } from 'axios';
import {
  normalizeApiError,
  isNetworkError,
  isRateLimitError,
  isValidationError,
  classifyApiError,
} from '../apiError';

/** Build an AxiosError with a synthetic response, matching axios's runtime shape. */
function makeAxiosError(options: {
  status?: number;
  data?: unknown;
  code?: string;
  message?: string;
}): AxiosError {
  const config = { headers: new AxiosHeaders() };
  const error = new AxiosError(
    options.message ?? 'Request failed',
    options.code,
    config as never,
    undefined,
    options.status === undefined
      ? undefined
      : {
          status: options.status,
          statusText: '',
          data: options.data,
          headers: {},
          config: config as never,
        }
  );
  return error;
}

describe('normalizeApiError', () => {
  it('extracts status and server message from an axios error', () => {
    const err = makeAxiosError({ status: 400, data: { message: 'Post is too long' } });
    expect(normalizeApiError(err)).toEqual({
      status: 400,
      code: undefined,
      message: 'Post is too long',
    });
  });

  it('prefers the server `error` field when `message` is absent', () => {
    const err = makeAxiosError({ status: 500, data: { error: 'Internal failure' } });
    const result = normalizeApiError(err);
    expect(result.status).toBe(500);
    expect(result.message).toBe('Internal failure');
  });

  it('reads a server `code` field when present', () => {
    const err = makeAxiosError({ status: 429, data: { code: 'RATE_LIMITED', message: 'Slow down' } });
    const result = normalizeApiError(err);
    expect(result.status).toBe(429);
    expect(result.code).toBe('RATE_LIMITED');
  });

  it('synthesizes a NETWORK code when there is no response', () => {
    const err = makeAxiosError({ message: 'Network Error' });
    const result = normalizeApiError(err);
    expect(result.status).toBeUndefined();
    expect(result.code).toBe('NETWORK');
  });

  it('synthesizes a TIMEOUT code for aborted requests', () => {
    const err = makeAxiosError({ code: 'ECONNABORTED', message: 'timeout' });
    expect(normalizeApiError(err).code).toBe('TIMEOUT');
  });

  it('recovers status/message from a preserved `cause` chain', () => {
    const cause = makeAxiosError({ status: 422, data: { message: 'Invalid' } });
    const wrapper = new Error('Failed to create post', { cause });
    const result = normalizeApiError(wrapper);
    expect(result.status).toBe(422);
    expect(result.message).toBe('Invalid');
  });

  it('falls back to the Error message for a plain Error', () => {
    expect(normalizeApiError(new Error('boom'))).toEqual({ message: 'boom' });
  });

  it('handles non-Error thrown values', () => {
    expect(normalizeApiError('oops').message).toBe('oops');
    expect(normalizeApiError(undefined).message).toBe('Unexpected error');
  });
});

describe('classifiers', () => {
  it('isRateLimitError matches status 429 and RATE_LIMITED code', () => {
    expect(isRateLimitError({ status: 429, message: '' })).toBe(true);
    expect(isRateLimitError({ code: 'RATE_LIMITED', message: '' })).toBe(true);
    expect(isRateLimitError({ status: 500, message: '' })).toBe(false);
  });

  it('isValidationError matches 400/422', () => {
    expect(isValidationError({ status: 400, message: '' })).toBe(true);
    expect(isValidationError({ status: 422, message: '' })).toBe(true);
    expect(isValidationError({ status: 500, message: '' })).toBe(false);
  });

  it('isNetworkError matches only responseless NETWORK/TIMEOUT', () => {
    expect(isNetworkError({ code: 'NETWORK', message: '' })).toBe(true);
    expect(isNetworkError({ code: 'TIMEOUT', message: '' })).toBe(true);
    expect(isNetworkError({ status: 500, code: 'NETWORK', message: '' })).toBe(false);
  });
});

describe('classifyApiError', () => {
  it('classifies a 429 as rateLimited', () => {
    const { reason } = classifyApiError(makeAxiosError({ status: 429, data: {} }));
    expect(reason).toBe('rateLimited');
  });

  it('classifies a 400 as validation', () => {
    const { reason } = classifyApiError(makeAxiosError({ status: 400, data: {} }));
    expect(reason).toBe('validation');
  });

  it('classifies a connection failure as network', () => {
    const { reason } = classifyApiError(makeAxiosError({ message: 'Network Error' }));
    expect(reason).toBe('network');
  });

  it('classifies a 500 as server', () => {
    const { reason } = classifyApiError(makeAxiosError({ status: 500, data: {} }));
    expect(reason).toBe('server');
  });
});
