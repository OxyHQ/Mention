import axios, { AxiosError, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { router } from 'expo-router';
import { toast } from 'sonner';
import { getData, storeData } from './storage';
import { disconnectSocket } from './socket';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';
import { useContext } from 'react';
import { showAuthBottomSheet } from './auth';

const API_URL = process.env.API_URL || 'http://localhost:3000/api';

let isRefreshing = false;
let failedQueue: { resolve: Function; reject: Function }[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
let batchQueue: { config: AxiosRequestConfig; resolve: Function; reject: Function }[] = [];

// Cache implementation
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const clearCache = (pattern?: string) => {
  if (pattern) {
    const regex = new RegExp(pattern);
    for (const key of cache.keys()) {
      if (regex.test(key)) {
        cache.delete(key);
      }
    }
  } else {
    cache.clear();
  }
};

const processQueue = (error: Error | null, token: string | null = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  
  failedQueue = [];
};

// Create axios instance with default config
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add a request interceptor
api.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    const accessToken = await getData('accessToken');
    if (accessToken) {
      config.headers = config.headers || {};
      config.headers['Authorization'] = `Bearer ${accessToken}`;
    }
    return config;
  },
  (error: AxiosError) => {
    return Promise.reject(error);
  }
);

// Add a response interceptor
api.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };
    
    // Don't retry if it's already been retried or if it's a refresh token request
    if (error.response?.status !== 401 || 
        originalRequest._retry || 
        originalRequest.url?.includes('auth/refresh')) {
      return Promise.reject(error);
    }

    if (isRefreshing) {
      try {
        const token = await new Promise<string>((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        });
        originalRequest.headers!['Authorization'] = `Bearer ${token}`;
        return api(originalRequest);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    originalRequest._retry = true;
    isRefreshing = true;

    try {
      const refreshToken = await getData('refreshToken');
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      // Use a direct axios call to avoid interceptors
      const response = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });

      if (response.data.accessToken && response.data.refreshToken) {
        await Promise.all([
          storeData('accessToken', response.data.accessToken),
          storeData('refreshToken', response.data.refreshToken)
        ]);
        
        // Update headers for retrying
        originalRequest.headers!['Authorization'] = `Bearer ${response.data.accessToken}`;
        // Process other queued requests
        processQueue(null, response.data.accessToken);
        // Update Redux store with new token
        const storedSession = await getData('session');
        if (storedSession) {
          await storeData('session', {
            ...storedSession,
            accessToken: response.data.accessToken
          });
        }
        return api(originalRequest);
      }
      throw new Error('Invalid token refresh response');
    } catch (refreshError) {
      const error = refreshError instanceof Error ? refreshError : new Error('Token refresh failed');
      processQueue(error, null);
      await forceLogout();
      return Promise.reject(error);
    } finally {
      isRefreshing = false;
    }
  }
);

export const validateSession = async (): Promise<boolean> => {
  try {
    const accessToken = await getData('accessToken');
    if (!accessToken) {
      return false;
    }

    const validateApi = axios.create({
      baseURL: API_URL,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const response = await validateApi.get('/auth/validate');
    return response.data.valid === true;
  } catch (error: any) {
    console.error('[API] Session validation failed:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      await forceLogout();
    }
    return false;
  }
};

export const forceLogout = async () => {
  try {
    // Clear all auth-related data
    await Promise.all([
      storeData('accessToken', null),
      storeData('refreshToken', null),
      storeData('session', null),
      storeData('user', null)
    ]);
    
    // Clear any pending requests
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchQueue.length = 0;
    }
    
    // Clear failed queue
    failedQueue = [];
    isRefreshing = false;
    
    // Clear cache
    clearCache();
    
    // Disconnect socket
    disconnectSocket();
    
    // Show auth bottom sheet
    showAuthBottomSheet();
  } catch (error) {
    console.error('[API] Force logout error:', error);
  }
};

export const fetchData = async (endpoint: string) => {
  try {
    const response = await api.get(endpoint);
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${endpoint}:`, error);
    throw error;
  }
};

export default api;
