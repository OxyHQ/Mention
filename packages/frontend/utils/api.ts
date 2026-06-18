import { oxyServices } from '@/lib/oxyServices';
import axios from 'axios';
import { API_URL } from '@/config';

const API_TIMEOUT_MS = 15_000;

interface DataResponse<T> {
  data: T;
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

const mentionApiClient = oxyServices.createLinkedClient({ baseURL: API_URL });
const linkedClient = mentionApiClient.client;
type LinkedRequestConfig = NonNullable<Parameters<typeof linkedClient.get>[1]>;
type LinkedDeleteConfig = NonNullable<Parameters<typeof linkedClient.delete>[1]>;

const authenticatedClient = {
  async get<T = unknown>(endpoint: string, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.get<T>(endpoint, config);
    return { data };
  },

  async post<T = unknown>(endpoint: string, body?: unknown, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.post<T>(endpoint, body, config);
    return { data };
  },

  async put<T = unknown>(endpoint: string, body?: unknown, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.put<T>(endpoint, body, config);
    return { data };
  },

  async delete<T = unknown>(endpoint: string, config?: LinkedDeleteConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.delete<T>(endpoint, config);
    return { data };
  },

  async patch<T = unknown>(endpoint: string, body?: unknown, config?: LinkedRequestConfig): Promise<DataResponse<T>> {
    const data = await linkedClient.patch<T>(endpoint, body, config);
    return { data };
  },
};

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
