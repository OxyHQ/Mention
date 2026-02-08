import { oxyServices } from '@/lib/oxyServices';
import axios from 'axios';
import { API_URL } from '@/config';

const API_CONFIG = {
  baseURL: API_URL,
};

// Authenticated axios client for Mention backend (api.mention.earth)
// Auth token is read from the shared OxyServices instance on every request
const authenticatedClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: { 'Content-Type': 'application/json' },
});

authenticatedClient.interceptors.request.use((config) => {
  const token = oxyServices.getClient().getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Public API client (no authentication)
const publicClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  headers: { 'Content-Type': 'application/json' },
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
    const url = new URL(API_CONFIG.baseURL);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return `${url.protocol}//${url.hostname}:3000`;
    }
    return url.origin;
  } catch {
    return 'http://localhost:3000';
  }
}

export { API_CONFIG, authenticatedClient, publicClient };
