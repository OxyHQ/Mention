import type { HttpClient, HttpRequestConfig, HttpResponse } from '@mention/agora-shared';
import { API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';

const agoraApiClient = oxyServices.createLinkedClient({ baseURL: API_URL });
const linkedClient = agoraApiClient.client;

function linkedConfig(config?: HttpRequestConfig): { params?: HttpRequestConfig['params'] } | undefined {
  return config?.params ? { params: config.params } : undefined;
}

const authenticatedClient: HttpClient = {
  async get(url: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    const data = await linkedClient.get<Record<string, unknown>>(url, linkedConfig(config));
    return { data };
  },

  async post(url: string, data?: Record<string, unknown> | FormData, config?: HttpRequestConfig): Promise<HttpResponse> {
    const responseData = await linkedClient.post<Record<string, unknown>>(url, data, linkedConfig(config));
    return { data: responseData };
  },

  async patch(url: string, data?: Record<string, unknown>, config?: HttpRequestConfig): Promise<HttpResponse> {
    const responseData = await linkedClient.patch<Record<string, unknown>>(url, data, linkedConfig(config));
    return { data: responseData };
  },

  async delete(url: string, config?: HttpRequestConfig): Promise<HttpResponse> {
    const data = await linkedClient.delete<Record<string, unknown>>(url, linkedConfig(config));
    return { data };
  },
};

export const api = {
  async get<T = unknown>(endpoint: string, params?: Record<string, string | number | boolean | undefined>): Promise<{ data: T }> {
    const data = await linkedClient.get<T>(endpoint, { params });
    return { data };
  },
  async post<T = unknown>(endpoint: string, body?: Record<string, unknown>): Promise<{ data: T }> {
    const data = await linkedClient.post<T>(endpoint, body);
    return { data };
  },
  async put<T = unknown>(endpoint: string, body?: Record<string, unknown>): Promise<{ data: T }> {
    const data = await linkedClient.put<T>(endpoint, body);
    return { data };
  },
  async delete<T = unknown>(endpoint: string): Promise<{ data: T }> {
    const data = await linkedClient.delete<T>(endpoint);
    return { data };
  },
  async patch<T = unknown>(endpoint: string, body?: Record<string, unknown>): Promise<{ data: T }> {
    const data = await linkedClient.patch<T>(endpoint, body);
    return { data };
  },
};

export { authenticatedClient };
