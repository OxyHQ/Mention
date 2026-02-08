import axios from 'axios';
import { API_URL } from '@/config';

// Shared OxyServices singleton reference — set by AppProviders after auth init
let _oxyServices: any = null;

export function setOxyServicesRef(svc: any) {
  _oxyServices = svc;
}

// Authenticated axios client for Mention backend (api.mention.earth)
const authenticatedClient = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

authenticatedClient.interceptors.request.use((config) => {
  const token = _oxyServices?.getClient?.()?.getAccessToken?.();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

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

export { authenticatedClient };
