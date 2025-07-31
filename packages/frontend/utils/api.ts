import { OxyServices } from '@oxyhq/services';
import { Platform } from 'react-native';
import { API_URL } from '@/config';

// API Configuration
const API_CONFIG = {
  baseURL: API_URL,
  endpoints: {
    health: '/api/health',
    profile: '/api/profiles',
    data: '/api/data',
    feed: '/api/feed',
    users: undefined,
    profiles: {
      recentProperties: '/api/profiles/me/recent-properties',
      savedProperties: '/api/profiles/me/saved-properties',
      saveProperty: '/api/profiles/me/save-property',
      savedSearches: '/api/profiles/me/saved-searches',
      properties: '/api/profiles/me/properties',
    },
  },
};

// Initialize OxyServices
const oxyServices = new OxyServices({ baseURL: API_CONFIG.baseURL });
const authenticatedClient = oxyServices.getClient();

// API methods using authenticatedClient
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

export class ApiError extends Error {
  constructor(message: string, public status?: number, public response?: any) {
    super(message);
    this.name = 'ApiError';
  }
}

export function webAlert(
  title: string,
  message: string,
  buttons?: Array<{ text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void }>
) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const result = window.confirm(`${title}\n\n${message}`);
      if (result) {
        const confirmButton = buttons.find(btn => btn.style !== 'cancel');
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find(btn => btn.style === 'cancel');
        cancelButton?.onPress?.();
      }
    } else {
      window.alert(`${title}\n\n${message}`);
      buttons?.[0]?.onPress?.();
    }
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
}

export const healthApi = {
  async checkHealth() {
    const response = await api.get(API_CONFIG.endpoints.health);
    return response.data;
  },
};

export { API_CONFIG, oxyServices, authenticatedClient };
