import { OxyServices } from '@oxyhq/services';
import { Platform } from 'react-native';
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import { API_URL } from '@/config';

// ============================================================================
// Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  data: T;
}

export interface ApiErrorResponse {
  message?: string;
  error?: string;
  errors?: Record<string, string[]>;
}

export interface RequestConfig extends AxiosRequestConfig {
  skipErrorHandling?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

const API_CONFIG = {
  baseURL: API_URL,
  timeout: 30000, // 30 seconds
} as const;

// Initialize OxyServices - if it automatically adds /api prefix, we don't need it in baseURL
const oxyServices = new OxyServices({ baseURL: API_CONFIG.baseURL });
const authenticatedClient = oxyServices.getClient();

// Public API client (no authentication required)
const publicClient = axios.create({
  baseURL: API_CONFIG.baseURL,
  timeout: API_CONFIG.timeout,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ============================================================================
// Error Handling
// ============================================================================

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public response?: ApiErrorResponse,
    public originalError?: AxiosError
  ) {
    super(message);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  static fromAxiosError(error: AxiosError<ApiErrorResponse>): ApiError {
    const status = error.response?.status;
    const response = error.response?.data;
    const message = response?.message || response?.error || error.message || 'An error occurred';

    return new ApiError(message, status, response, error);
  }
}

// ============================================================================
// Request Interceptors
// ============================================================================

// Add request interceptors for logging, error handling, etc.
authenticatedClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError<ApiErrorResponse>) => {
    // Transform axios errors to ApiError
    return Promise.reject(ApiError.fromAxiosError(error));
  }
);

publicClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError<ApiErrorResponse>) => {
    return Promise.reject(ApiError.fromAxiosError(error));
  }
);

// ============================================================================
// API Methods
// ============================================================================

/**
 * API client with authenticated requests
 * Provides type-safe methods for all HTTP verbs
 */
export const api = {
  async get<T = unknown>(
    endpoint: string,
    params?: Record<string, unknown>,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    try {
      const response = await authenticatedClient.get<T>(endpoint, { params, ...config });
      return { data: response.data };
    } catch (error) {
      if (config?.skipErrorHandling) throw error;
      throw error instanceof ApiError ? error : ApiError.fromAxiosError(error as AxiosError);
    }
  },

  async post<T = unknown>(
    endpoint: string,
    body?: unknown,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    try {
      const response = await authenticatedClient.post<T>(endpoint, body, config);
      return { data: response.data };
    } catch (error) {
      if (config?.skipErrorHandling) throw error;
      throw error instanceof ApiError ? error : ApiError.fromAxiosError(error as AxiosError);
    }
  },

  async put<T = unknown>(
    endpoint: string,
    body?: unknown,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    try {
      const response = await authenticatedClient.put<T>(endpoint, body, config);
      return { data: response.data };
    } catch (error) {
      if (config?.skipErrorHandling) throw error;
      throw error instanceof ApiError ? error : ApiError.fromAxiosError(error as AxiosError);
    }
  },

  async delete<T = unknown>(
    endpoint: string,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    try {
      const response = await authenticatedClient.delete<T>(endpoint, config);
      return { data: response.data };
    } catch (error) {
      if (config?.skipErrorHandling) throw error;
      throw error instanceof ApiError ? error : ApiError.fromAxiosError(error as AxiosError);
    }
  },

  async patch<T = unknown>(
    endpoint: string,
    body?: unknown,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    try {
      const response = await authenticatedClient.patch<T>(endpoint, body, config);
      return { data: response.data };
    } catch (error) {
      if (config?.skipErrorHandling) throw error;
      throw error instanceof ApiError ? error : ApiError.fromAxiosError(error as AxiosError);
    }
  },
};

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

// ============================================================================
// Specialized API Clients
// ============================================================================

/**
 * Health check API
 */
export const healthApi = {
  async checkHealth(): Promise<{ status: string; timestamp: string }> {
    const response = await api.get<{ status: string; timestamp: string }>('/api/health');
    return response.data;
  },
};

/**
 * Public API methods (no authentication required)
 */
export const publicApi = {
  async get<T = unknown>(
    endpoint: string,
    params?: Record<string, unknown>,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    try {
      const response = await publicClient.get<T>(endpoint, { params, ...config });
      return { data: response.data };
    } catch (error) {
      if (config?.skipErrorHandling) throw error;
      throw error instanceof ApiError ? error : ApiError.fromAxiosError(error as AxiosError);
    }
  },
};

export { API_CONFIG, oxyServices, authenticatedClient, publicClient };
