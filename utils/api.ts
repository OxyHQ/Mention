import axios, { AxiosError, AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { router } from 'expo-router';
import { toast } from 'sonner';
import { getData, storeData } from './storage';
import { disconnectSocket } from './socket';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from '@/modules/oxyhqservices/components/AuthBottomSheet';
import { useContext } from 'react';
import { showAuthBottomSheet } from './auth';
import { API_URL } from '@/config';

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const BATCH_DELAY = 50; // ms to wait before processing batch
const MAX_BATCH_SIZE = 10;

let isRefreshing = false;
let failedQueue: { resolve: Function; reject: Function }[] = [];

// Enhanced cache implementation with typed interface and TTL support
interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface BatchRequest {
  config: AxiosRequestConfig;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

const cache = new Map<string, CacheEntry<any>>();
let batchQueue: BatchRequest[] = [];
let batchTimeout: NodeJS.Timeout | null = null;

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

export const getCacheKey = (endpoint: string, params?: any) => {
  return `${endpoint}${params ? `-${JSON.stringify(params)}` : ''}`;
};

export const setCacheEntry = <T>(key: string, data: T, ttl = CACHE_DURATION) => {
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl
  });
};

export const getCacheEntry = <T>(key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  
  if (Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return null;
  }
  
  return entry.data as T;
};

// Request batching implementation
const processBatch = async () => {
  const batch = batchQueue.splice(0, MAX_BATCH_SIZE);
  batchTimeout = null;

  if (batch.length === 0) return;

  try {
    // Group similar requests
    const requestGroups = batch.reduce((groups, request) => {
      const key = `${request.config.method}-${request.config.url}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(request);
      return groups;
    }, {} as Record<string, BatchRequest[]>);

    // Process each group
    await Promise.all(
      Object.values(requestGroups).map(async (requests) => {
        try {
          if (requests.length === 1) {
            // Single request
            const response = await api(requests[0].config);
            requests[0].resolve(response.data);
          } else {
            // Batch similar requests
            const params = requests.map(r => r.config.params || {});
            const response = await api({
              ...requests[0].config,
              params: { batch: params }
            });
            
            // Distribute responses
            requests.forEach((request, index) => {
              request.resolve(Array.isArray(response.data) ? response.data[index] : response.data);
            });
          }
        } catch (error) {
          requests.forEach(request => request.reject(error));
        }
      })
    );
  } catch (error) {
    batch.forEach(request => request.reject(error));
  }
};

export const batchRequest = <T>(config: AxiosRequestConfig): Promise<T> => {
  return new Promise((resolve, reject) => {
    batchQueue.push({ config, resolve, reject });
    
    if (batchTimeout) clearTimeout(batchTimeout);
    batchTimeout = setTimeout(processBatch, BATCH_DELAY);
  });
};

// Enhanced fetchData with caching and batching
export const fetchData = async <T>(
  endpoint: string,
  options: {
    params?: any;
    skipCache?: boolean;
    cacheTTL?: number;
    skipBatch?: boolean;
  } = {}
) => {
  const { params, skipCache = false, cacheTTL = CACHE_DURATION, skipBatch = false } = options;
  
  // Check cache first
  if (!skipCache) {
    const cacheKey = getCacheKey(endpoint, params);
    const cachedData = getCacheEntry<T>(cacheKey);
    if (cachedData) return cachedData;
  }

  try {
    const config: AxiosRequestConfig = {
      method: 'GET',
      url: endpoint,
      params
    };

    // Use batching for GET requests unless explicitly skipped
    const response = skipBatch
      ? await api(config)
      : await batchRequest<T>(config);

    // Cache successful responses
    if (!skipCache) {
      const cacheKey = getCacheKey(endpoint, params);
      setCacheEntry(cacheKey, response, cacheTTL);
    }

    return response;
  } catch (error) {
    console.error(`Error fetching data from ${endpoint}:`, error);
    throw error;
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

export const postData = async (endpoint: string, data: any) => {
  try {
    const response = await api.post(endpoint, data);
    clearCache(endpoint);
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.message;
    toast.error(`Error posting data: ${errorMessage}`);
    throw error;
  }
};

export default api;
