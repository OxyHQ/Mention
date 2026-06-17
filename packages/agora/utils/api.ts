import axios from 'axios';
import type { OxyServices } from '@oxyhq/core';
import { API_URL } from '@/config';

// Shared OxyServices singleton reference — set by AppProviders after auth init
let _oxyServices: OxyServices | null = null;

export function setOxyServicesRef(svc: OxyServices) {
  _oxyServices = svc;
}

// Authenticated axios client for Mention backend (api.mention.earth)
const authenticatedClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

authenticatedClient.interceptors.request.use((config) => {
  const token = _oxyServices?.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Retry once on 401 after rotating the current refresh-cookie slot.
authenticatedClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (error.response?.status === 401 && _oxyServices && !config._retried) {
      config._retried = true;
      try {
        const refreshed = await _oxyServices.refreshTokenViaCookie();
        if (refreshed?.accessToken) {
          _oxyServices.setTokens(refreshed.accessToken);
          config.headers.Authorization = `Bearer ${refreshed.accessToken}`;
          return authenticatedClient(config);
        }
      } catch {
        // Refresh failed — fall through to reject
      }
    }
    return Promise.reject(error);
  }
);

export const api = {
  async get<T = unknown>(endpoint: string, params?: Record<string, string | number | boolean | undefined>): Promise<{ data: T }> {
    const response = await authenticatedClient.get(endpoint, { params });
    return { data: response.data };
  },
  async post<T = unknown>(endpoint: string, body?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await authenticatedClient.post(endpoint, body);
    return { data: response.data };
  },
  async put<T = unknown>(endpoint: string, body?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await authenticatedClient.put(endpoint, body);
    return { data: response.data };
  },
  async delete<T = unknown>(endpoint: string): Promise<{ data: T }> {
    const response = await authenticatedClient.delete(endpoint);
    return { data: response.data };
  },
  async patch<T = unknown>(endpoint: string, body?: Record<string, unknown>): Promise<{ data: T }> {
    const response = await authenticatedClient.patch(endpoint, body);
    return { data: response.data };
  },
};

export { authenticatedClient };
