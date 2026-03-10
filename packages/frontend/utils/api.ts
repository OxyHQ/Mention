import { oxyServices } from '@/lib/oxyServices';
import axios from 'axios';
import { API_URL } from '@/config';

const API_TIMEOUT_MS = 15_000;

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
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 responses — attempt token refresh, then retry once
authenticatedClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        // AuthManager handles token refresh via the session
        const auth = (oxyServices as any).authManager || (oxyServices as any).auth;
        if (auth && typeof auth.refreshToken === 'function') {
          const refreshed = await auth.refreshToken();
          if (refreshed) {
            const newToken = oxyServices.getClient().getAccessToken();
            if (newToken) {
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              return authenticatedClient(originalRequest);
            }
          }
        }
      } catch (refreshError) {
        // Token refresh failed — let the error propagate
      }
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
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const response = await authenticatedClient.get(endpoint, { params });
    return { data: response.data };
  },
  async post<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const response = await authenticatedClient.post(endpoint, body);
    return { data: response.data };
  },
  async put<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const response = await authenticatedClient.put(endpoint, body);
    return { data: response.data };
  },
  async delete<T = any>(endpoint: string): Promise<{ data: T }> {
    const response = await authenticatedClient.delete(endpoint);
    return { data: response.data };
  },
  async patch<T = any>(endpoint: string, body?: any): Promise<{ data: T }> {
    const response = await authenticatedClient.patch(endpoint, body);
    return { data: response.data };
  },
};

// Public API helpers (no authentication)
export const publicApi = {
  async get<T = any>(endpoint: string, params?: Record<string, any>): Promise<{ data: T }> {
    const response = await publicClient.get(endpoint, { params });
    return { data: response.data };
  },
};

// Error checking utilities
export function isUnauthorizedError(error: any): boolean {
  return error?.response?.status === 401 || error?.status === 401;
}

export function isNotFoundError(error: any): boolean {
  return error?.response?.status === 404 || error?.status === 404;
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
