import { oxyServices } from '@/lib/oxyServices';
import axios, { AxiosHeaders, type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { API_URL } from '@/config';
import { createScopedLogger } from '@/lib/logger';

const API_TIMEOUT_MS = 15_000;
const logger = createScopedLogger('MentionApi');

interface RetryableAxiosRequestConfig extends InternalAxiosRequestConfig<unknown> {
  _retry?: boolean;
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

function setAuthorizationHeader(config: InternalAxiosRequestConfig<unknown>, token: string): void {
  const headers = AxiosHeaders.from(config.headers);
  headers.set('Authorization', `Bearer ${token}`);
  config.headers = headers;
}

function getAuthorizationHeader(config: InternalAxiosRequestConfig<unknown>): string | undefined {
  const value = AxiosHeaders.from(config.headers).get('Authorization');
  return typeof value === 'string' ? value : undefined;
}

// Authenticated axios client for Mention backend (api.mention.earth)
// Auth token is read from the shared OxyServices instance on every request
const authenticatedClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: API_TIMEOUT_MS,
});

authenticatedClient.interceptors.request.use((config) => {
  const token = oxyServices.getClient().getAccessToken();
  if (token) {
    setAuthorizationHeader(config, token);
  }
  return config;
});

// Handle auth races: if a request left with an old/missing bearer while the SDK
// committed a newer token, retry once with the current token. Real 401s still
// propagate to the caller instead of poking at private SDK internals.
authenticatedClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<unknown, unknown>) => {
    const originalRequest = error.config as RetryableAxiosRequestConfig | undefined;
    if (getHttpStatus(error) === 401 && originalRequest && !originalRequest._retry) {
      originalRequest._retry = true;
      const latestToken = oxyServices.getClient().getAccessToken();
      const latestHeader = latestToken ? `Bearer ${latestToken}` : undefined;
      if (latestToken && latestHeader !== getAuthorizationHeader(originalRequest)) {
        setAuthorizationHeader(originalRequest, latestToken);
        return authenticatedClient(originalRequest);
      }
      logger.warn('Authenticated request rejected with the current Oxy token', {
        method: originalRequest.method,
        url: originalRequest.url,
      });
    }
    return Promise.reject(error);
  }
);

// Public API client (no authentication)
const publicClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: API_TIMEOUT_MS,
});

// Authenticated API helpers (unwrap axios response)
export const api = {
  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await authenticatedClient.get(endpoint, { params });
    return { data: response.data };
  },
  async post<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    const response = await authenticatedClient.post(endpoint, body);
    return { data: response.data };
  },
  async put<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    const response = await authenticatedClient.put(endpoint, body);
    return { data: response.data };
  },
  async delete<T = unknown>(endpoint: string): Promise<{ data: T }> {
    const response = await authenticatedClient.delete(endpoint);
    return { data: response.data };
  },
  async patch<T = unknown>(endpoint: string, body?: unknown): Promise<{ data: T }> {
    const response = await authenticatedClient.patch(endpoint, body);
    return { data: response.data };
  },
};

// Public API helpers (no authentication)
export const publicApi = {
  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await publicClient.get(endpoint, { params });
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
 * Get API origin, ensuring correct port for localhost (3000)
 * Backend API runs on port 3000, regardless of frontend dev server port
 */
export function getApiOrigin(): string {
  try {
    const url = new URL(API_URL);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return `${url.protocol}//${url.hostname}:3000`;
    }
    return url.origin;
  } catch {
    return 'http://localhost:3000';
  }
}

export { authenticatedClient, publicClient };
