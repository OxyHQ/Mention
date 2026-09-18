import { oxyServices } from '@/lib/oxyServices';
import type { LinkedHttpClient } from '@oxy.so/core';
import { create as createAxiosClient } from 'axios';
import { API_URL } from '@/config';
import i18n from '@/lib/i18n';

const API_TIMEOUT_MS = 15_000;

interface DataResponse<T> {
  data: T;
}

/**
 * The reader's language, as an `Accept-Language` header.
 *
 * The backend resolves a multilingual post to ONE body per viewer, and this
 * header is how it learns which one to serve. It is read at CALL time, never
 * captured at module load: changing the app language in Settings must take
 * effect on the very next request. Absent while i18n is still initializing —
 * the server then falls back to the account's languages and the post's primary.
 */
function readerLanguageHeaders(): Record<string, string> {
  const language = i18n.language;
  return typeof language === 'string' && language.length > 0
    ? { 'Accept-Language': language }
    : {};
}

function withReaderLanguage<C extends { headers?: Record<string, string> }>(config?: C): C {
  const base = (config ?? {}) as C;
  // Caller-supplied headers win: an explicit Accept-Language is a deliberate override.
  return { ...base, headers: { ...readerLanguageHeaders(), ...base.headers } };
}

function getHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if ('response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status?: unknown }).status;
      return typeof status === 'number' ? status : undefined;
    }
  }

  if ('status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }

  return undefined;
}

/**
 * The Mention API client.
 *
 * ## `enableRetry: false` is load-bearing, not a preference
 *
 * The SDK builds its `AbortController` INSIDE the function `retryAsync`
 * retries, links the caller's signal to it with `addEventListener('abort')`,
 * and never checks `signal.aborted` first. An `abort` event fires ONCE, so on
 * attempt 2 the caller's already-fired signal cannot abort the newly built
 * controller — and a caller abort surfaces as an `AbortError` carrying
 * `status: 0`, which is not 4xx, so the SDK's `defaultShouldRetry` returns
 * true. The result is that a request the caller CANCELLED is re-issued for
 * real, up to `maxRetries` times, with exponential backoff between attempts.
 *
 * With the 5s default timeout and 3 retries that is ~28s of work after the
 * caller gave up, and the `RequestQueue` is 10 slots deep — so the zombies
 * starve the request the viewer is actually waiting on. Typing a few words
 * into search was leaving a dozen abandoned requests in flight.
 *
 * Turning retry off makes `requestFn` run once: the controller is built once,
 * the caller's signal aborts it correctly, and nothing cancelled is ever
 * re-sent. React Query already retries at the query layer with its own policy
 * and — unlike this one — honours cancellation, so the retry we are dropping
 * was the duplicate of the two.
 *
 * This is a workaround for a defect in `@oxy.so/core` (still present in 1.6.0,
 * verified). The root fix belongs in the SDK — an abort domain per `request()`
 * rather than per attempt, cancellation excluded from `shouldRetry`, and an
 * overall deadline. Re-enable retry DELIBERATELY once that ships, with
 * `retryOnTimeout: false` and an explicit deadline; do not simply delete this.
 *
 * `requestTimeout` matches `API_TIMEOUT_MS` on the axios client above. The two
 * clients in one app disagreeing 3x (5s vs 15s) was itself a bug report: 5s
 * sits below the p99 of several real endpoints, which turns a slow response
 * into a client-manufactured failure.
 */
const mentionApiClient = oxyServices.createLinkedClient({
  baseURL: API_URL,
  enableRetry: false,
  requestTimeout: API_TIMEOUT_MS,
});
const linkedClient: LinkedHttpClient['client'] = mentionApiClient.client;
type LinkedRequestConfig = NonNullable<Parameters<typeof linkedClient.get>[1]>;
type LinkedDeleteConfig = NonNullable<Parameters<typeof linkedClient.delete>[1]>;

const authenticatedClient = {
  async get<T = unknown>(endpoint: string, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.get<T>(endpoint, withReaderLanguage(config));
    return { data };
  },

  async post<T = unknown>(endpoint: string, body?: unknown, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.post<T>(endpoint, body, withReaderLanguage(config));
    return { data };
  },

  async put<T = unknown>(endpoint: string, body?: unknown, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.put<T>(endpoint, body, withReaderLanguage(config));
    return { data };
  },

  async delete<T = unknown>(endpoint: string, config?: LinkedDeleteConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.delete<T>(endpoint, withReaderLanguage(config));
    return { data };
  },

  async patch<T = unknown>(endpoint: string, body?: unknown, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.patch<T>(endpoint, body, withReaderLanguage(config));
    return { data };
  },
};

// Public API client (no authentication)
const publicClient = createAxiosClient({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: API_TIMEOUT_MS,
});

publicClient.interceptors.request.use((config) => {
  const { 'Accept-Language': acceptLanguage } = readerLanguageHeaders();
  if (acceptLanguage) {
    config.headers.set('Accept-Language', acceptLanguage);
  }
  return config;
});

// Authenticated API helpers (unwrap axios response)
export const api = {
  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await authenticatedClient.get<T>(endpoint, { params });
    return { data: response.data };
  },
  async post<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    const response = await authenticatedClient.post<T>(endpoint, body);
    return { data: response.data };
  },
  async put<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    const response = await authenticatedClient.put<T>(endpoint, body);
    return { data: response.data };
  },
  async delete<T = unknown>(endpoint: string): Promise<{ data: T }> {
    const response = await authenticatedClient.delete<T>(endpoint);
    return { data: response.data };
  },
  async patch<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    const response = await authenticatedClient.patch<T>(endpoint, body);
    return { data: response.data };
  },
};

// Public API helpers (no authentication)
export const publicApi = {
  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await publicClient.get<T>(endpoint, { params });
    return { data: response.data };
  },
};

// Error checking utilities
export function isUnauthorizedError(error: unknown): boolean {
  return getHttpStatus(error) === 401;
}

export function isNotFoundError(error: unknown): boolean {
  return getHttpStatus(error) === 404;
}

/**
 * Get API origin, ensuring correct port for localhost (4110)
 * Backend API runs on port 4110, regardless of frontend dev server port
 */
export function getApiOrigin(): string {
  try {
    const url = new URL(API_URL);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return `${url.protocol}//${url.hostname}:4110`;
    }
    return url.origin;
  } catch {
    return 'http://localhost:4110';
  }
}

export { authenticatedClient, publicClient };
